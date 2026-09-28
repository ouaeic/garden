import { createHash } from 'node:crypto';
import {
  MEMORY_PACK_BUDGET_TOKENS,
  MEMORY_PACK_QUOTAS,
  buildMemoryItemIndex,
  buildMemorySourceIndex,
  planMemoryQuery
} from '@garden/core';
import { MEMORY_FUZZY_SIMILARITY_THRESHOLD } from '@garden/core';
import type {
  EncryptedEnvelope,
  MemoryKind,
  MemoryPackQuota,
  MemoryQueryPlan,
  MemoryTrust
} from '@garden/core';
import type { Database } from './database.js';
import type { DataStore, RecallMemoryInput } from './store.js';

/* ------------------------------------------------------------------------ *
 * Retrieval eval
 *
 * Every claim the memory code makes about itself - that the fuzzy channel adds recall, that quotas
 * beat top-k, that the verbatim slot earns a fifth of the budget - was unfalsifiable until this
 * existed. There was no fixture, no gold set and no number a change could move, so a tokenizer
 * edit could halve recall and every test would still pass.
 *
 * The corpus is a small workspace's memory as it would actually look after a few months of use:
 * facts about named services, the owner's stated preferences, procedures, episodes recording what
 * was learned, and raw conversation turns. The probes are the questions someone would ask it,
 * written the way people write them rather than the way the entries are worded - which is the
 * entire difficulty, and the reason three of these had hard-zero recall before this wave.
 *
 * Two numbers come out, and they fail differently:
 *
 *   candidate recall - did the gold row enter any channel at all? A row that enters none is
 *   unretrievable at any k, so this is a hard ceiling and a pure property of the tokenizer, the
 *   query planner and the admission predicates.
 *
 *   pack recall - after fusion, the prior, per-kind quotas, dedupe and the token budget, is the
 *   gold row in the bytes the agent actually receives? This is what catches quota starvation, an
 *   episode losing its slot to five facts about the same subject.
 *
 * Question types follow LongMemEval's taxonomy adapted to a single-owner agent computer, including
 * the two that matter most here and that the widely-cited alternatives do not score at all:
 * knowledge update - a superseded fact must NOT come back for a present-tense question and MUST
 * come back for a past-tense one - and abstention, where the right answer is an empty pack rather
 * than six thousand tokens of the nearest thing available.
 * ------------------------------------------------------------------------ */

export type MemoryEvalQuestionType =
  | 'single_session_fact'
  | 'preference'
  | 'temporal_reasoning'
  | 'knowledge_update'
  | 'multi_session'
  | 'abstention';

export interface MemoryEvalItem {
  /** Stable handle used by the probes. Ids are minted at seed time and differ per run. */
  readonly ref: string;
  readonly kind: Exclude<MemoryKind, 'source'>;
  readonly trust?: MemoryTrust;
  readonly title?: string;
  readonly tags?: readonly string[];
  readonly body: string;
  readonly subject?: string;
  readonly object?: string;
  readonly predicate?: string;
  readonly pin?: boolean;
  /** How long before the eval clock this was observed. */
  readonly daysAgo: number;
  /**
   * When this row was packed into a task, in days before the eval clock.
   *
   * WHY THIS EXISTS. Before it, every row in this corpus carried `salience = 0` - minimum and
   * maximum - because nothing here had ever written a `mem.item_use` row or called
   * `consolidateMemory`. So `mem.prior`'s salience factor evaluated to exactly 1.0 for every row
   * in every probe, and the entire usage half of the ranking was invisible to the repository's
   * only retrieval instrument: an audit moved six of its constants at once, including deleting the
   * negative term and multiplying the usage window by a hundred, and 2,296 tests stayed green.
   *
   * The histories below are written per row rather than derived from `daysAgo`, for the same
   * reason the padding corpus is a pure function of its index and nothing here is generated from
   * the query: a fixture the ranking computes for itself measures nothing. They are also
   * deliberately NOT a reward for being a gold row - the heaviest history in the corpus belongs to
   * a retired value that must never come back for a present-tense question.
   */
  readonly uses?: readonly number[];
  /** How many of those uses the model went on to cite, taken from the most recent end. */
  readonly citedUses?: number;
  /** How many the harness watched fail, taken from the oldest end. */
  readonly failedUses?: number;
}

export interface MemoryEvalSource {
  readonly ref: string;
  readonly body: string;
  readonly role: 'user' | 'assistant' | 'tool';
  /** Groups turns into one past conversation, so a window around a hit has something to show. */
  readonly conversation: string;
  readonly daysAgo: number;
}

export interface MemoryEvalProbe {
  readonly id: string;
  readonly type: MemoryEvalQuestionType;
  readonly question: string;
  /**
   * Refs of the rows that answer it. Empty means nothing in the store answers this, and the right
   * behaviour is to retrieve nothing beyond what the owner pinned - a pin is an explicit standing
   * instruction to inject a row into every task, so it is the one thing an abstention permits.
   */
  readonly gold: readonly string[];
  /** Refs that must not appear - a retired value returned for a present-tense question. */
  readonly forbidden?: readonly string[];
  /** True when every gold row is required, not just one of them. */
  readonly requireAll?: boolean;
  /** Recall options the question itself implies, e.g. a past-tense question widening the scope. */
  readonly recall?: Pick<RecallMemoryInput, 'includeSuperseded' | 'asOf' | 'kinds'>;
  /**
   * A question the store is known not to answer, kept because the gap is worth recording.
   *
   * It is scored out of every aggregate rather than counted as a failure, because the alternative -
   * letting one permanent miss pull the recall floors below one - turns a perfect-recall guard into
   * an approximate one, and afterwards a real regression losing a different probe nets out against
   * it and passes silently. The probe is instead asserted to still miss, so if the gap ever closes
   * the eval says so and the probe gets promoted, rather than the store quietly improving into a
   * threshold nobody rechecked. The comment on each one has to say what would have to change.
   */
  readonly expectedMiss?: boolean;
}

/**
 * Facts are seeded through `recordMemoryFact`, so `default_shell` genuinely supersedes: the zsh row
 * is retired by the fish row exactly as it would be in use, rather than being written pre-retired.
 */
export const MEMORY_EVAL_ITEMS: readonly MemoryEvalItem[] = [
  {
    ref: 'relay-port',
    kind: 'fact',
    title: 'relay listen address',
    body: 'garden-relay binds 0.0.0.0:8443 behind the SNI proxy. Nothing else may hold that port.',
    subject: 'garden-relay',
    object: '0.0.0.0:8443',
    predicate: 'runs_on',
    daysAgo: 40,
    uses: [2, 5, 9, 16, 24, 33, 39],
    citedUses: 3
  },
  {
    ref: 'mail-connector-host',
    kind: 'fact',
    title: 'mail connector transport',
    body: 'The mail connector reads from dovecot over IMAP on this same computer.',
    subject: 'mail connector',
    object: 'dovecot',
    predicate: 'runs_on',
    daysAgo: 60,
    uses: [10, 29, 57],
    citedUses: 2
  },
  {
    ref: 'postgres-port',
    kind: 'fact',
    title: 'database address',
    body: 'PostgreSQL 18 runs on localhost:5432 with scram-sha-256 authentication.',
    subject: 'postgres',
    object: 'localhost:5432',
    predicate: 'runs_on',
    daysAgo: 90,
    uses: [4, 11, 27, 58, 79],
    citedUses: 2
  },
  {
    ref: 'backup-location',
    kind: 'fact',
    title: 'backup destination',
    body: 'Backups are written to /srv/garden/var/backup and mirrored to the encrypted volume.',
    subject: 'backups',
    object: '/srv/garden/var/backup',
    predicate: 'located_at',
    daysAgo: 75,
    uses: [9, 31, 68],
    citedUses: 1
  },
  {
    ref: 'shell-retired',
    kind: 'fact',
    title: 'default shell',
    body: 'The owner works in zsh on this computer.',
    subject: 'owner',
    object: 'zsh',
    predicate: 'default_shell',
    daysAgo: 200,
    uses: [196, 199, 203, 208, 214, 221, 229, 238, 248, 259]
  },
  {
    ref: 'shell-current',
    kind: 'fact',
    title: 'default shell',
    body: 'The owner works in fish on this computer.',
    subject: 'owner',
    object: 'fish',
    predicate: 'default_shell',
    daysAgo: 12,
    uses: [1, 6, 12],
    citedUses: 2
  },
  {
    ref: 'answer-style',
    kind: 'fact',
    title: 'answer style',
    body: 'The owner wants short answers with the command shown, not a narrated walkthrough.',
    subject: 'owner',
    object: 'short answers',
    predicate: 'prefers',
    daysAgo: 50,
    uses: [2, 4, 7, 11, 18, 29, 46],
    citedUses: 4
  },
  {
    ref: 'time-zone',
    kind: 'fact',
    title: 'time zone',
    body: 'The owner reads clocks in Europe/London and wants every schedule stated in it.',
    subject: 'owner',
    object: 'Europe/London',
    predicate: 'prefers',
    daysAgo: 120,
    uses: [20, 52],
    citedUses: 1
  },
  {
    ref: 'sni-decision',
    kind: 'fact',
    title: 'routing decision',
    body: 'Everything is routed by SNI on 443; the home router forwards no other port inbound.',
    subject: 'sni proxy',
    object: '443',
    predicate: 'runs_on',
    daysAgo: 150,
    uses: [34, 77],
    citedUses: 1
  },
  {
    ref: 'deploy-procedure',
    kind: 'procedure',
    title: 'Deploy garden',
    tags: ['deploy', 'garden'],
    body: 'pnpm build, then systemctl restart garden.target. Watch journalctl -u garden.target for the ready line before calling it done.',
    daysAgo: 20,
    uses: [1, 3, 8, 14, 19],
    citedUses: 2
  },
  {
    ref: 'certificate-procedure',
    kind: 'procedure',
    title: 'Rotate the TLS certificate',
    tags: ['tls', 'certificate', 'nginx'],
    body: 'acme.sh --issue --dns dns_cf -d the domain, then systemctl reload nginx. The relay picks the new chain up without a restart.',
    daysAgo: 35,
    uses: [13, 35],
    citedUses: 1
  },
  {
    ref: 'snapshot-procedure',
    kind: 'procedure',
    title: 'Take a database snapshot',
    tags: ['backup', 'postgres'],
    body: 'pg_dump -Fc garden > /srv/garden/var/backup/garden.dump and check the file size before trusting it.',
    daysAgo: 28,
    uses: [7, 21, 44],
    citedUses: 1
  },
  {
    ref: 'pptx-clipping',
    kind: 'episode',
    title: 'A slide lost the end of a paragraph',
    body: 'A PowerPoint text box clips whatever overflows instead of growing, and neither the file nor the library warns about it. Measure the text against the box and split it across two boxes.',
    daysAgo: 22,
    uses: [6, 19, 34],
    citedUses: 1
  },
  {
    ref: 'relay-not-enabled',
    kind: 'episode',
    title: 'The relay did not come back after a reboot',
    body: 'After the computer rebooted, garden-relay stayed down because its unit had never been enabled. systemctl enable --now garden-relay fixed it for good.',
    daysAgo: 18,
    uses: [4, 15, 29],
    citedUses: 1
  },
  {
    ref: 'imap-idle-interval',
    kind: 'episode',
    title: 'Mail only caught up late in the morning',
    body: 'The connector was polling every half hour because imap_idle_notify_interval was left at the dovecot default. Setting it to 2 minutes made new mail arrive immediately.',
    daysAgo: 30,
    uses: [8, 23, 45],
    citedUses: 1
  },
  {
    ref: 'journal-disk-full',
    kind: 'episode',
    title: 'The root volume filled with journal logs',
    body: 'The disk filled up because journald had no SystemMaxUse limit. Capped it at 500M and the space came back.',
    daysAgo: 65,
    uses: [11, 38],
    citedUses: 1
  },
  {
    ref: 'lockfile-drift',
    kind: 'episode',
    title: 'A build failed on lockfile drift',
    body: 'CI failed because the lockfile had drifted from the manifest. Installs are pinned with --frozen-lockfile now.',
    daysAgo: 47,
    uses: [5, 20, 43],
    citedUses: 2
  },
  {
    ref: 'font-substitution',
    kind: 'episode',
    title: 'A document rendered with the wrong font',
    body: 'A generated document silently substituted a fallback font because the requested family was not installed, which changed every line break in it.',
    daysAgo: 88,
    uses: [27, 71],
    citedUses: 1
  },
  {
    ref: 'owner-languages',
    kind: 'fact',
    title: 'working languages',
    body: 'The owner writes TypeScript and reads SQL comfortably.',
    subject: 'owner',
    object: 'typescript',
    predicate: 'knows_language',
    daysAgo: 140,
    uses: [24, 63],
    citedUses: 1
  },
  {
    ref: 'workspace-root',
    kind: 'fact',
    title: 'working root',
    body: 'Everything the agent owns lives under /srv/garden and nothing outside it is written without asking.',
    subject: 'workspace',
    object: '/srv/garden',
    predicate: 'located_at',
    pin: true,
    daysAgo: 160,
    uses: [26, 66],
    citedUses: 1
  },

  /* ---------------------------------------------------------------------- *
   * Competitors
   *
   * Everything above this line is an answer to some probe. Everything below it is a row that has
   * to lose, and the eval is worth nothing without them: with twenty-eight rows in the store and a
   * six-thousand-token pack that holds fifty-two, every channel could admit everything and score a
   * hundred percent, so fusion, the prior, the per-kind quotas and the per-subject cap were all
   * measured by a corpus that never made them choose. `pressure` in the report is the ratio that
   * has to stay above one for any of this to mean anything.
   *
   * They are near misses on purpose, not filler. A second service on a neighbouring port, a second
   * path under the same backup directory, a rollback beside the deploy it undoes: noise that shares
   * no vocabulary with the question is free to rank against, and measuring against free noise is
   * how a retrieval number gets published at ninety-nine percent and helps nobody.
   * ---------------------------------------------------------------------- */

  {
    ref: 'runner-port',
    kind: 'fact',
    title: 'workspace runner address',
    body: 'workspace-runner listens on localhost:7070 and is never exposed beyond the loopback interface.',
    subject: 'workspace-runner',
    object: 'localhost:7070',
    predicate: 'runs_on',
    daysAgo: 44,
    uses: [18, 47],
    citedUses: 1
  },
  {
    ref: 'relay-health-port',
    kind: 'fact',
    title: 'relay health endpoint',
    body: 'The relay health endpoint answers on 127.0.0.1:8444, separately from the port it serves traffic on.',
    subject: 'relay health endpoint',
    object: '127.0.0.1:8444',
    predicate: 'runs_on',
    daysAgo: 38
  },
  {
    ref: 'pgbouncer-port',
    kind: 'fact',
    title: 'connection pooler address',
    body: 'pgbouncer sits in front of PostgreSQL on localhost:6432 in transaction pooling mode.',
    subject: 'pgbouncer',
    object: 'localhost:6432',
    predicate: 'runs_on',
    daysAgo: 85,
    uses: [5, 12, 26, 40, 61],
    citedUses: 2,
    failedUses: 3
  },
  {
    ref: 'dovecot-port',
    kind: 'fact',
    title: 'imap service address',
    body: 'dovecot answers IMAPS on 993 and refuses plaintext IMAP on 143 entirely.',
    subject: 'dovecot',
    object: '993',
    predicate: 'runs_on',
    daysAgo: 62
  },
  {
    ref: 'postfix-port',
    kind: 'fact',
    title: 'submission service address',
    body: 'postfix accepts submission on 587 with STARTTLS required, and listens on no public interface.',
    subject: 'postfix',
    object: '587',
    predicate: 'runs_on',
    daysAgo: 62
  },
  {
    ref: 'grafana-port',
    kind: 'fact',
    title: 'dashboard address',
    body: 'Grafana runs on localhost:3000 and is reachable only through the relay, never directly.',
    subject: 'grafana',
    object: 'localhost:3000',
    predicate: 'runs_on',
    daysAgo: 70,
    uses: [22, 51]
  },
  {
    ref: 'prometheus-port',
    kind: 'fact',
    title: 'metrics address',
    body: 'Prometheus scrapes on localhost:9090 with a fifteen day retention window.',
    subject: 'prometheus',
    object: 'localhost:9090',
    predicate: 'runs_on',
    daysAgo: 70
  },
  {
    ref: 'redis-port',
    kind: 'fact',
    title: 'cache address',
    body: 'redis holds the job queue on localhost:6379 with persistence turned off.',
    subject: 'redis',
    object: 'localhost:6379',
    predicate: 'runs_on',
    daysAgo: 95,
    uses: [94, 96, 99, 103, 108]
  },
  {
    ref: 'unbound-port',
    kind: 'fact',
    title: 'resolver address',
    body: 'unbound resolves on 127.0.0.1:53 and is the only resolver this computer will use.',
    subject: 'unbound',
    object: '127.0.0.1:53',
    predicate: 'runs_on',
    daysAgo: 110,
    uses: [109, 112]
  },
  {
    ref: 'syncthing-port',
    kind: 'fact',
    title: 'file sync address',
    body: 'syncthing serves its own interface on localhost:8384 behind the same SNI front door.',
    subject: 'syncthing',
    object: 'localhost:8384',
    predicate: 'runs_on',
    daysAgo: 130,
    uses: [128, 131, 135]
  },
  {
    ref: 'wal-location',
    kind: 'fact',
    title: 'write-ahead log archive',
    body: 'The write-ahead log is archived to /srv/garden/var/backup/wal, which is pruned on its own schedule.',
    subject: 'wal archive',
    object: '/srv/garden/var/backup/wal',
    predicate: 'located_at',
    daysAgo: 74,
    uses: [21, 56],
    citedUses: 1
  },
  {
    ref: 'log-location',
    kind: 'fact',
    title: 'log directory',
    body: 'Service logs are written under /srv/garden/var/log; journald keeps the systemd side.',
    subject: 'logs',
    object: '/srv/garden/var/log',
    predicate: 'located_at',
    daysAgo: 66,
    uses: [17, 36, 64],
    citedUses: 1
  },
  {
    ref: 'config-location',
    kind: 'fact',
    title: 'configuration directory',
    body: 'Configuration lives in /srv/garden/etc and is the only tree edited by hand.',
    subject: 'configuration',
    object: '/srv/garden/etc',
    predicate: 'located_at',
    daysAgo: 100
  },
  {
    ref: 'skills-location',
    kind: 'fact',
    title: 'skills directory',
    body: 'Vetted skills live in /srv/garden/skills and are read at the start of a task.',
    subject: 'skills',
    object: '/srv/garden/skills',
    predicate: 'located_at',
    daysAgo: 55
  },
  {
    ref: 'vault-location',
    kind: 'fact',
    title: 'encrypted volume',
    body: 'The encrypted volume is mounted at /mnt/vault and holds the mirror of every backup.',
    subject: 'encrypted volume',
    object: '/mnt/vault',
    predicate: 'located_at',
    daysAgo: 76
  },
  {
    ref: 'theme-preference',
    kind: 'fact',
    title: 'interface theme',
    body: 'The owner uses a dark interface and wants nothing generated that assumes a light background.',
    subject: 'owner',
    object: 'dark theme',
    predicate: 'prefers',
    daysAgo: 58
  },
  {
    ref: 'date-format',
    kind: 'fact',
    title: 'date format',
    body: 'The owner writes dates as ISO 8601 and reads any other ordering as ambiguous.',
    subject: 'owner',
    object: 'ISO 8601',
    predicate: 'prefers',
    daysAgo: 105
  },
  {
    ref: 'spelling-preference',
    kind: 'fact',
    title: 'spelling',
    body: 'Anything written for the owner uses British spelling, in documents as well as in prose replies.',
    subject: 'owner',
    object: 'British spelling',
    predicate: 'prefers',
    daysAgo: 45,
    uses: [6, 28, 60],
    citedUses: 2
  },
  {
    ref: 'emoji-preference',
    kind: 'fact',
    title: 'no emoji',
    body: 'The owner wants no emoji anywhere: not in replies, not in generated documents, not in commit messages.',
    subject: 'owner',
    object: 'no emoji',
    predicate: 'prefers',
    daysAgo: 33,
    uses: [13, 37],
    citedUses: 1
  },
  {
    ref: 'units-preference',
    kind: 'fact',
    title: 'units',
    body: 'The owner reads metric units and wants any imperial figure converted rather than quoted.',
    subject: 'owner',
    object: 'metric units',
    predicate: 'prefers',
    daysAgo: 115
  },
  {
    ref: 'package-tool',
    kind: 'fact',
    title: 'package manager',
    body: 'Node packages are installed with pnpm; npm and yarn are not used on this computer.',
    subject: 'node packages',
    object: 'pnpm',
    predicate: 'uses_tool',
    daysAgo: 42,
    uses: [3, 10, 25, 41],
    citedUses: 2
  },
  {
    ref: 'search-tool',
    kind: 'fact',
    title: 'text search tool',
    body: 'Searching text on disk is done with ripgrep, which respects the ignore files grep does not.',
    subject: 'code search',
    object: 'ripgrep',
    predicate: 'uses_tool',
    daysAgo: 48
  },
  {
    ref: 'pdf-tool',
    kind: 'fact',
    title: 'pdf tool',
    body: 'PDFs are assembled and split with qpdf rather than a print-to-file round trip.',
    subject: 'pdf editing',
    object: 'qpdf',
    predicate: 'uses_tool',
    daysAgo: 92
  },

  {
    ref: 'restore-procedure',
    kind: 'procedure',
    title: 'Restore the database from a snapshot',
    tags: ['restore', 'postgres', 'backup'],
    body: 'systemctl stop garden.target, then pg_restore -c -d garden the dump, then start the target again. Never restore into a running system.',
    daysAgo: 26,
    uses: [12, 40],
    citedUses: 1
  },
  {
    ref: 'rollback-procedure',
    kind: 'procedure',
    title: 'Roll back a deploy',
    tags: ['rollback', 'deploy', 'garden'],
    body: 'git checkout the previous tag, pnpm build, systemctl restart garden.target. The database migration is forward-only, so check it is compatible first.',
    daysAgo: 24,
    uses: [15, 46],
    citedUses: 1
  },
  {
    ref: 'key-rotation-procedure',
    kind: 'procedure',
    title: 'Rotate the workspace data key',
    tags: ['keys', 'security'],
    body: 'Unwrap with the current root key, rewrap with the new one, then re-derive the memory index key. Ciphertext is untouched; only the wrapping changes.',
    daysAgo: 52
  },
  {
    ref: 'journal-procedure',
    kind: 'procedure',
    title: 'Prune the systemd journal',
    tags: ['logs', 'disk'],
    body: 'journalctl --vacuum-size=500M, then confirm SystemMaxUse is still set in journald.conf so it does not grow back.',
    daysAgo: 64
  },
  {
    ref: 'mail-restart-procedure',
    kind: 'procedure',
    title: 'Restart the mail connector',
    tags: ['mail', 'connector'],
    body: 'systemctl restart garden-mail, then watch for the IDLE line in the log before believing it reconnected.',
    daysAgo: 29
  },

  {
    ref: 'dns-propagation',
    kind: 'episode',
    title: 'A certificate renewal failed on DNS propagation',
    body: 'acme.sh failed the DNS-01 challenge because the TXT record had not propagated yet. Waiting sixty seconds between writing the record and asking for validation fixed it.',
    daysAgo: 34,
    uses: [10, 30],
    citedUses: 1
  },
  {
    ref: 'cron-utc',
    kind: 'episode',
    title: 'A scheduled task fired an hour early',
    body: 'A schedule was stored in UTC while the owner read it as local time, so through British Summer Time it ran an hour early. Schedules are written with an explicit zone now.',
    daysAgo: 41,
    uses: [14, 42],
    citedUses: 1
  },
  {
    ref: 'xlsx-text-numbers',
    kind: 'episode',
    title: 'A spreadsheet would not sum a column',
    body: 'The numbers had been written as text, so they left-aligned and every SUM came back zero. Writing them as numbers rather than strings fixed the column.',
    daysAgo: 53,
    uses: [9, 32],
    citedUses: 1
  },
  {
    ref: 'docx-toc-stale',
    kind: 'episode',
    title: 'A table of contents kept the old headings',
    body: 'A Word table of contents is a cached field, not a live view, so it kept the previous headings until the field was marked dirty for the reader to update.',
    daysAgo: 71,
    uses: [16, 49],
    citedUses: 1
  },
  {
    ref: 'pdf-table-split',
    kind: 'episode',
    title: 'A table lost its header across a page break',
    body: 'A long table broke across a page and the continuation had no header row, so the second page of figures was unreadable. Repeat the header on every page.',
    daysAgo: 79
  },
  {
    ref: 'oom-worker',
    kind: 'episode',
    title: 'The worker was killed during a large build',
    body: 'The build was killed by the OOM killer with no error of its own, only a truncated log. The unit has a MemoryMax now so it fails loudly instead of vanishing.',
    daysAgo: 58,
    uses: [7, 25, 55],
    citedUses: 2
  },
  {
    ref: 'browser-restale',
    kind: 'episode',
    title: 'A click landed on the wrong element',
    body: 'The page re-rendered between reading it and clicking, so the recorded coordinate pointed at a different control. Re-read the page immediately before acting on it.',
    daysAgo: 44
  },
  {
    ref: 'checkpoint-loss',
    kind: 'episode',
    title: 'A restore dropped an uncommitted file',
    body: 'Restoring a checkpoint reverted the workspace to the recorded tree, and a file written after it was taken went with it. Take a checkpoint before restoring one.',
    daysAgo: 96
  }
];

export const MEMORY_EVAL_SOURCES: readonly MemoryEvalSource[] = [
  {
    ref: 'relay-turn-user',
    conversation: 'relay-reboot',
    role: 'user',
    body: 'the relay is down again after I restarted the box, can you have a look',
    daysAgo: 18
  },
  {
    ref: 'relay-turn-agent',
    conversation: 'relay-reboot',
    role: 'assistant',
    body: 'garden-relay was never enabled at boot, so a restart left it stopped. I ran systemctl enable --now garden-relay and it is listening on 0.0.0.0:8443 again.',
    daysAgo: 18
  },
  {
    ref: 'relay-turn-tool',
    conversation: 'relay-reboot',
    role: 'tool',
    body: '$ systemctl status garden-relay\n  Loaded: loaded (/etc/systemd/system/garden-relay.service; enabled)\n  Active: active (running)\n  Listening on 0.0.0.0:8443',
    daysAgo: 18
  },
  {
    ref: 'mail-turn-user',
    conversation: 'mail-morning',
    role: 'user',
    body: 'mail stops syncing overnight and only catches up around eleven in the morning',
    daysAgo: 30
  },
  {
    ref: 'mail-turn-agent',
    conversation: 'mail-morning',
    role: 'assistant',
    body: 'dovecot had imap_idle_notify_interval at its default, so the connector only woke every thirty minutes. I set it to 2 minutes.',
    daysAgo: 30
  },
  {
    ref: 'deck-turn-user',
    conversation: 'deck-review',
    role: 'user',
    body: 'the deck you made lost the bottom of a paragraph on slide four',
    daysAgo: 22
  },
  {
    ref: 'deck-turn-agent',
    conversation: 'deck-review',
    role: 'assistant',
    body: 'a PowerPoint text box clips overflow silently rather than resizing, so the last lines were dropped. I split the paragraph across two boxes.',
    daysAgo: 22
  },
  {
    ref: 'snapshot-turn-tool',
    conversation: 'db-snapshot',
    role: 'tool',
    body: '$ pg_dump -Fc garden > /srv/garden/var/backup/garden.dump\n$ ls -l /srv/garden/var/backup\n-rw------- 1 garden garden 41M garden.dump',
    daysAgo: 28
  },

  /* Verbatim competitors. The source slot is a fifth of the pack and holds six rows; eight turns
   * could all fit it, so which turn the search returned was never actually decided by the search. */
  {
    ref: 'tls-turn-user',
    conversation: 'tls-renewal',
    role: 'user',
    body: 'the certificate did not renew last night, the job says it failed validation',
    daysAgo: 34
  },
  {
    ref: 'tls-turn-agent',
    conversation: 'tls-renewal',
    role: 'assistant',
    body: 'acme.sh asked for DNS-01 validation before the TXT record had propagated, so the challenge failed. I put a sixty second wait between writing the record and requesting validation and the renewal went through.',
    daysAgo: 34
  },
  {
    ref: 'tls-turn-tool',
    conversation: 'tls-renewal',
    role: 'tool',
    body: '$ acme.sh --issue --dns dns_cf -d relay.example\n[Wed] Verifying: relay.example\n[Wed] Success\n[Wed] Cert success.',
    daysAgo: 34
  },
  {
    ref: 'disk-turn-user',
    conversation: 'disk-full',
    role: 'user',
    body: 'everything just stopped writing, I think the disk is full',
    daysAgo: 65
  },
  {
    ref: 'disk-turn-agent',
    conversation: 'disk-full',
    role: 'assistant',
    body: 'journald had no SystemMaxUse, so the journal had grown to fill the root volume. I vacuumed it to 500M and set the cap so it cannot happen again.',
    daysAgo: 65
  },
  {
    ref: 'disk-turn-tool',
    conversation: 'disk-full',
    role: 'tool',
    body: '$ journalctl --vacuum-size=500M\nVacuuming done, freed 22.4G of archived journals.\n$ df -h /\n/dev/sda1  100G  61G  39G  62% /',
    daysAgo: 65
  },
  {
    ref: 'sheet-turn-user',
    conversation: 'spreadsheet-sums',
    role: 'user',
    body: 'the totals row in that spreadsheet is coming out as zero and the figures sit on the left',
    daysAgo: 53
  },
  {
    ref: 'sheet-turn-agent',
    conversation: 'spreadsheet-sums',
    role: 'assistant',
    body: 'the column had been written as text rather than numbers, which is why it left-aligned and why SUM returned zero. I rewrote the cells as numbers and the total is right.',
    daysAgo: 53
  },
  {
    ref: 'cron-turn-user',
    conversation: 'schedule-zone',
    role: 'user',
    body: 'the morning summary arrived at six, an hour before I asked for it',
    daysAgo: 41
  },
  {
    ref: 'cron-turn-agent',
    conversation: 'schedule-zone',
    role: 'assistant',
    body: 'the schedule was stored in UTC and read as local time, so it drifted by an hour once British Summer Time began. It carries Europe/London explicitly now.',
    daysAgo: 41
  },
  {
    ref: 'oom-turn-user',
    conversation: 'build-killed',
    role: 'user',
    body: 'the build just stops halfway with nothing in the output',
    daysAgo: 58
  },
  {
    ref: 'oom-turn-tool',
    conversation: 'build-killed',
    role: 'tool',
    body: '$ journalctl -k | tail -3\nOut of memory: Killed process 41122 (node) total-vm:9182364kB\n$ systemctl show garden-worker -p MemoryMax\nMemoryMax=infinity',
    daysAgo: 58
  },
  {
    ref: 'oom-turn-agent',
    conversation: 'build-killed',
    role: 'assistant',
    body: 'the kernel OOM killer took the node process, which is why the log simply ended. I set MemoryMax on the worker unit so it fails with an error instead of disappearing.',
    daysAgo: 58
  },
  {
    ref: 'runner-turn-user',
    conversation: 'runner-loopback',
    role: 'user',
    body: 'can I reach the runner from my laptop directly',
    daysAgo: 44
  },
  {
    ref: 'runner-turn-agent',
    conversation: 'runner-loopback',
    role: 'assistant',
    body: 'no - workspace-runner binds localhost:7070 only, and the router forwards nothing inbound but 443. Everything reaches it through the relay.',
    daysAgo: 44
  }
];

export const MEMORY_EVAL_PROBES: readonly MemoryEvalProbe[] = [
  {
    id: 'relay-port-plain',
    type: 'single_session_fact',
    question: 'what port does the relay listen on',
    gold: ['relay-port']
  },
  {
    id: 'relay-down-after-reboot',
    type: 'single_session_fact',
    question: 'the relay is down again after I restarted the box',
    gold: ['relay-port', 'relay-not-enabled']
  },
  {
    id: 'relay-by-exact-name',
    type: 'single_session_fact',
    question: 'what do we know about garden-relay',
    gold: ['relay-port']
  },
  {
    id: 'mail-connector-transport',
    type: 'single_session_fact',
    question: 'which mail server does the connector read from',
    gold: ['mail-connector-host']
  },
  {
    id: 'database-address',
    type: 'single_session_fact',
    question: 'what address is the database on',
    gold: ['postgres-port']
  },
  {
    id: 'backup-destination',
    type: 'single_session_fact',
    question: 'where do the backups go',
    gold: ['backup-location']
  },
  {
    id: 'backup-directory-by-path',
    type: 'single_session_fact',
    question: 'what is in /srv/garden/var/backup',
    gold: ['backup-location', 'snapshot-procedure']
  },
  {
    id: 'inbound-routing',
    type: 'single_session_fact',
    question: 'how does inbound traffic reach the services on this computer',
    gold: ['sni-decision']
  },
  {
    id: 'answer-length',
    type: 'preference',
    question: 'how long should my answers to the owner be',
    gold: ['answer-style']
  },
  {
    id: 'schedule-time-zone',
    type: 'preference',
    question: 'which time zone should I state a schedule in',
    gold: ['time-zone']
  },
  {
    id: 'owner-language',
    type: 'preference',
    question: 'which programming language does the owner work in',
    gold: ['owner-languages']
  },
  {
    id: 'shell-now',
    type: 'knowledge_update',
    question: 'which shell does the owner use',
    gold: ['shell-current'],
    forbidden: ['shell-retired']
  },
  {
    id: 'shell-before',
    type: 'temporal_reasoning',
    question: 'which shell did the owner use previously',
    gold: ['shell-retired'],
    recall: { includeSuperseded: true }
  },
  {
    id: 'deploy-how',
    type: 'multi_session',
    question: 'how do I deploy garden',
    gold: ['deploy-procedure']
  },
  {
    id: 'deploy-restart-unit',
    type: 'multi_session',
    question: 'restart garden.target after a deploy',
    gold: ['deploy-procedure']
  },
  {
    id: 'certificate-rotation',
    type: 'multi_session',
    question: 'how do I rotate the TLS certificate',
    gold: ['certificate-procedure']
  },
  {
    id: 'database-snapshot',
    type: 'multi_session',
    question: 'how do I take a snapshot of the database',
    gold: ['snapshot-procedure']
  },
  {
    id: 'mail-morning-cause',
    type: 'multi_session',
    question: 'why was mail only syncing late in the morning',
    gold: ['imap-idle-interval', 'mail-turn-agent']
  },
  {
    id: 'imap-setting-by-name',
    type: 'multi_session',
    question: 'what did we set imap_idle_notify_interval to',
    gold: ['imap-idle-interval', 'mail-turn-agent']
  },
  {
    id: 'idle-setting-by-words',
    type: 'multi_session',
    question: 'what is the idle notify interval on the mail box set to',
    gold: ['imap-idle-interval', 'mail-turn-agent']
  },
  {
    id: 'deck-lost-paragraph',
    type: 'multi_session',
    question: 'why did my deck lose the bottom of a paragraph',
    gold: ['pptx-clipping', 'deck-turn-agent']
  },
  {
    id: 'text-box-overflow',
    type: 'multi_session',
    question: 'what happens when a PowerPoint text box overflows',
    gold: ['pptx-clipping']
  },
  {
    id: 'disk-filled',
    type: 'multi_session',
    question: 'what did we do about the disk filling up with logs',
    gold: ['journal-disk-full']
  },
  {
    id: 'build-lockfile',
    type: 'multi_session',
    question: 'why did the build fail on the lockfile',
    gold: ['lockfile-drift']
  },
  {
    id: 'wrong-font',
    type: 'multi_session',
    question: 'why did a generated document use a different font than I asked for',
    gold: ['font-substitution']
  },
  {
    id: 'relay-reboot-conversation',
    type: 'multi_session',
    question: 'find the conversation where the relay came back after a reboot',
    gold: ['relay-turn-agent', 'relay-not-enabled']
  },
  {
    id: 'abstain-unrelated-place',
    type: 'abstention',
    question: 'what is the capital city of Peru',
    gold: []
  },
  {
    id: 'abstain-never-discussed',
    type: 'abstention',
    question: 'remind me what the neighbour said about her boat',
    gold: []
  },
  {
    id: 'abstain-unrelated-errand',
    type: 'abstention',
    question: 'what did the dentist charge for the crown',
    gold: []
  },

  /* Probes that only mean something once the competitors above are in the store: each of these has
   * a near neighbour that shares most of its vocabulary, so passing requires ranking rather than
   * admission. */
  {
    id: 'runner-port-plain',
    type: 'single_session_fact',
    question: 'which port does the workspace runner listen on',
    gold: ['runner-port']
  },
  {
    id: 'wal-archive-path',
    type: 'single_session_fact',
    question: 'where does the write ahead log get archived',
    gold: ['wal-location']
  },
  {
    id: 'no-emoji-in-documents',
    type: 'preference',
    question: 'should there be emoji in a document written for the owner',
    gold: ['emoji-preference']
  },
  {
    // Worded so that a lexical store can legitimately reach it: the control for the paraphrase
    // below, which asks for the same preference in words the row does not contain.
    id: 'spelling-convention',
    type: 'preference',
    question: 'what spelling should I use in a document for the owner',
    gold: ['spelling-preference']
  },
  {
    // The known gap, kept as a probe rather than as a remark. Nothing in "colour or color" occurs
    // in the row that answers it - "Anything written for the owner uses British spelling" - so no
    // lexical channel reaches it at any k. Adding "for the owner" does reach it, but through the
    // subject rather than through what was asked, which says the row has a matched subject and
    // nothing about the question being answerable.
    //
    // Reaching a stated preference from a paraphrase of its content is what a semantic channel
    // would have done, and migration 54 removed that channel because an embedding of a memory body
    // is a recoverable copy of the plaintext the store encrypts. So this misses by design, and what
    // would have to change for it to pass is that objection falling, or some other bridge from a
    // paraphrase to the words it paraphrases.
    id: 'spelling-paraphrase',
    type: 'preference',
    question: 'is it colour or color',
    gold: ['spelling-preference'],
    expectedMiss: true
  },
  {
    id: 'restore-from-snapshot',
    type: 'multi_session',
    question: 'how do I restore the database from a snapshot',
    gold: ['restore-procedure']
  },
  {
    id: 'roll-back-deploy',
    type: 'multi_session',
    question: 'how do I roll back a bad deploy',
    gold: ['rollback-procedure']
  },
  {
    id: 'certificate-renewal-failed',
    type: 'multi_session',
    question: 'why did the certificate renewal fail validation',
    gold: ['dns-propagation', 'tls-turn-agent']
  },
  {
    id: 'schedule-ran-early',
    type: 'multi_session',
    question: 'why did my scheduled summary arrive an hour early',
    gold: ['cron-utc', 'cron-turn-agent']
  },
  {
    id: 'spreadsheet-totals-zero',
    type: 'multi_session',
    question: 'why is the totals row in my spreadsheet coming out as zero',
    gold: ['xlsx-text-numbers', 'sheet-turn-agent']
  },
  {
    id: 'contents-page-stale',
    type: 'multi_session',
    question: 'why does the contents page still list the old headings',
    gold: ['docx-toc-stale']
  },
  {
    id: 'build-stops-silently',
    type: 'multi_session',
    question: 'the build stops halfway with nothing in the output',
    gold: ['oom-worker', 'oom-turn-agent']
  }
];

/**
 * Pinned rows are admitted by the structural channel for every query, by design: a pin is the
 * owner saying "this belongs in every task". They are therefore not evidence that a question was
 * answered, and an abstention probe tolerates exactly them and nothing else.
 */
export const ALWAYS_ON_REFS: ReadonlySet<string> = new Set(
  MEMORY_EVAL_ITEMS.filter((item) => item.pin).map((item) => item.ref)
);

/** The store never opens an envelope, so seeding uses a reversible stand-in rather than a key. */
const seal = (value: string): EncryptedEnvelope => ({
  v: 1,
  iv: 'eval',
  tag: 'eval',
  ciphertext: Buffer.from(value, 'utf8').toString('base64')
});

export interface MemoryEvalSeed {
  /** ref -> row id, for both items and sources. */
  readonly ids: ReadonlyMap<string, string>;
  /** ref -> row id, sources only, for the verbatim-search half of the eval. */
  readonly sourceIds: ReadonlyMap<string, string>;
  /** conversation -> synthetic task id. */
  readonly conversations: ReadonlyMap<string, string>;
  readonly writeCost: MemoryEvalWriteCost;
}

/**
 * Reported beside accuracy on purpose. The write path can be most of an agent's execution time and
 * is routinely left out of published memory comparisons, which makes a slow extraction pipeline
 * look free next to raw chunking.
 */
export interface MemoryEvalWriteCost {
  readonly items: number;
  readonly sources: number;
  readonly indexedBytes: number;
  readonly millis: number;
}

export interface MemoryEvalProbeResult {
  readonly id: string;
  readonly type: MemoryEvalQuestionType;
  readonly question: string;
  /** Gold refs the recall returned. */
  readonly found: readonly string[];
  /** Gold refs it did not. */
  readonly missed: readonly string[];
  /** Refs the probe forbade and the recall returned anyway. */
  readonly leaked: readonly string[];
  readonly hit: boolean;
  readonly returned: number;
  /**
   * One-based position of the first gold row in relevance order, or null when none came back.
   *
   * Membership is the wrong question for a recall the agent asked mid-task: it reads from the top,
   * and an answer at position twenty-two of twenty-five is one it will not reach. Rank is also the
   * only metric here that a bigger pack cannot buy - returning everything makes recall perfect and
   * leaves rank exactly where it was.
   */
  readonly rank: number | null;
  /** Tokens the emitted pack spent on this question. */
  readonly packTokens: number;
  /** Of those, the tokens spent on rows the probe names as an answer. */
  readonly goldTokens: number;
}

export interface MemoryEvalReport {
  readonly probes: readonly MemoryEvalProbeResult[];
  readonly recall: number;
  /**
   * Mean reciprocal rank over the probes that have an answer. A probe whose gold row never came
   * back contributes zero, which is what makes this comparable with `recall` rather than a
   * restatement of it.
   */
  readonly mrr: number;
  /** Mean tokens the pack spent per answerable question - the price paid for the recall above. */
  readonly packTokens: number;
  /** Share of those tokens spent on rows that answer the question rather than surround it. */
  readonly goldShare: number;
  /**
   * Rows in the store over rows the pack can hold. At or below one, every channel can admit
   * everything it matched and no quota, prior or fusion weight has to decide anything - so every
   * number above it is a measurement of the corpus rather than of the retrieval.
   */
  readonly pressure: number;
  readonly byType: ReadonlyMap<MemoryEvalQuestionType, { hit: number; total: number }>;
  readonly misses: readonly string[];
  /** Probes marked `expectedMiss`, which every number above is computed without. */
  readonly expectedMisses: readonly string[];
  readonly leaks: readonly string[];
  readonly writeCost: MemoryEvalWriteCost;
}

/** Rows the pack can hold at once, which is what the corpus has to exceed to be measuring anything. */
export const MEMORY_EVAL_PACK_CAPACITY = MEMORY_PACK_QUOTAS.reduce(
  (total, quota) => total + quota.cap,
  0
);

export const MEMORY_EVAL_CORPUS_PRESSURE =
  (MEMORY_EVAL_ITEMS.length + MEMORY_EVAL_SOURCES.length) / MEMORY_EVAL_PACK_CAPACITY;

/**
 * The same ratio with the padding corpus counted, which is the one that reaches the candidate caps.
 *
 * Kept as a separate constant rather than folded into the one above: the unpadded number is what
 * the committed unpressured figures were measured at, and a reader comparing the two runs needs
 * both denominators visible rather than one that changed underneath them.
 */
export const MEMORY_EVAL_PADDED_PRESSURE = (paddingRows: number): number =>
  MEMORY_EVAL_CORPUS_PRESSURE + paddingRows / MEMORY_EVAL_PACK_CAPACITY;

/** Wide enough that no quota selects anything out, so a run under them measures admission alone. */
export const MEMORY_EVAL_UNBOUNDED_QUOTAS: readonly MemoryPackQuota[] = MEMORY_PACK_QUOTAS.map(
  (quota) => ({ ...quota, share: 1, cap: 1_000, perSubject: 1_000 })
);

const daysBefore = (now: Date, days: number): Date => new Date(now.getTime() - days * 86_400_000);

/**
 * Writes the corpus into a real store. Nothing here is a fixture of the query's own making: rows go
 * in through the same public methods the worker uses, so a change to the write path shows up in the
 * recall number rather than being papered over by a hand-built index.
 */
export const seedMemoryEvalCorpus = async (input: {
  store: DataStore;
  userId: string;
  workspaceId: string;
  key: Uint8Array;
  now: Date;
  /**
   * Whether to write the `uses` histories and run the nightly pass.
   *
   * Off by default, and that is not laziness. The committed numbers above this were measured on a
   * corpus whose salience was uniformly zero, so `mem.prior`'s salience factor was the constant
   * 1.0 for every row - turning usage on for the same corpus moves them, and re-baselining a
   * retrieval gate to accommodate a fixture is how a gate stops being one. The usage arm is
   * therefore a second corpus with its own committed numbers, and the pair is what makes the
   * usage tier observable at all: the A/B between them is the only measurement in this repository
   * of what the salience factor is worth.
   */
  withUsage?: boolean;
}): Promise<MemoryEvalSeed> => {
  const started = process.hrtime.bigint();
  await input.store.syncMemoryPredicates();
  const ids = new Map<string, string>();
  const sourceIds = new Map<string, string>();
  const conversations = new Map<string, string>();
  let indexedBytes = 0;

  for (const item of MEMORY_EVAL_ITEMS) {
    const index = buildMemoryItemIndex(
      {
        title: item.title ?? null,
        tags: item.tags ?? [],
        body: item.body,
        subject: item.subject ?? null,
        object: item.object ?? null
      },
      input.key
    );
    indexedBytes +=
      index.titleTokens.length +
      index.tagTokens.length +
      index.aliasTokens.length +
      index.bodyTokens.length;
    const observedAt = daysBefore(input.now, item.daysAgo);
    const common = {
      id: evalRowId(item.ref),
      userId: input.userId,
      workspaceId: input.workspaceId,
      trust: item.trust ?? ('stated' as MemoryTrust),
      documentCiphertext: seal(item.body),
      index,
      observedAt,
      validFrom: observedAt,
      pin: item.pin ?? false
    };
    if (item.kind === 'fact') {
      if (!item.predicate) throw new Error(`eval fact ${item.ref} has no predicate`);
      const recorded = await input.store.recordMemoryFact({ ...common, predicate: item.predicate });
      ids.set(item.ref, recorded.item.id);
      continue;
    }
    const created = await input.store.createMemoryItem({
      ...common,
      kind: item.kind,
      lastVerified: item.kind === 'procedure' ? observedAt : null
    });
    ids.set(item.ref, created.id);
  }

  const turnsSoFar = new Map<string, number>();
  for (const source of MEMORY_EVAL_SOURCES) {
    let taskId = conversations.get(source.conversation);
    if (!taskId) {
      // A real task row, because mem.source.task_id is a foreign key now: deleting a conversation
      // takes its memory with it, and a corpus of invented ids could not exercise the schema it is
      // measuring. The ciphertext is a placeholder - nothing here ever opens it.
      const conversationTask = await input.store.createTask({
        userId: input.userId,
        workspaceId: input.workspaceId,
        modelId: 'eval-model',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 0,
        titleCiphertext: { v: 1, iv: 'eval', tag: 'eval', ciphertext: source.conversation },
        promptCiphertext: { v: 1, iv: 'eval', tag: 'eval', ciphertext: source.conversation },
        // This corpus measures recall over the verbatim layer. Names are a separate index with its
        // own probes, and giving these placeholder rows one would put tokens nobody is asking about
        // into the numbers.
        nameIndex: { nameTokens: '', openingTokens: '' }
      });
      taskId = conversationTask.id;
      conversations.set(source.conversation, taskId);
    }
    // Turns within one conversation are a minute apart, so "the rows around this hit" has a real
    // order to read rather than a tie broken by row id.
    const turn = turnsSoFar.get(source.conversation) ?? 0;
    turnsSoFar.set(source.conversation, turn + 1);
    const index = buildMemorySourceIndex(source.body, input.key);
    indexedBytes += index.bodyTokens.length;
    const created = await input.store.createMemorySource({
      id: evalRowId(source.ref),
      userId: input.userId,
      workspaceId: input.workspaceId,
      channel: source.role === 'tool' ? 'terminal' : 'chat',
      role: source.role,
      taskId,
      bodyCiphertext: seal(source.body),
      bodyTokens: index.bodyTokens,
      tokensEst: index.tokensEst,
      indexed: index.indexed,
      occurredAt: new Date(daysBefore(input.now, source.daysAgo).getTime() + turn * 60_000)
    });
    ids.set(source.ref, created.id);
    sourceIds.set(source.ref, created.id);
  }

  /*
   * The usage half of the ranking, made observable.
   *
   * Uses go in through `recordMemoryUse` and salience comes out of `consolidateMemory` - the two
   * methods `apps/worker/src/memory-capture.ts` calls at the end of a turn - rather than being
   * written onto the column. That is what makes a change to the salience weights, the decay
   * exponent or the retention fold move a number in this file: without it every row scored
   * `salience = 0` and `mem.prior`'s salience factor was the constant 1.0 for the whole corpus.
   *
   * One `recordMemoryUse` per instant rather than one per row: the writer stamps every id in a
   * call with the same `used_at`, and a history is a sequence of separate turns.
   */
  for (const item of input.withUsage ? MEMORY_EVAL_ITEMS : []) {
    if (!item.uses?.length) continue;
    const id = ids.get(item.ref);
    if (!id) continue;
    const ordered = [...item.uses].sort((left, right) => left - right);
    const cited = item.citedUses ?? 0;
    const failed = item.failedUses ?? 0;
    for (const [index, daysAgo] of ordered.entries())
      await input.store.recordMemoryUse({
        workspaceId: input.workspaceId,
        itemIds: [id],
        usedAt: daysBefore(input.now, daysAgo),
        cited: index < cited,
        /*
         * THREE OUTCOMES, BECAUSE THE SCORE PARTITIONS ON THREE. This read
         * `index >= ordered.length - failed ? 'fail' : 'ok'`, so every use that was not cited and
         * did not fail was graded a success - and `recordMemoryPackOutcome` writes exactly the
         * opposite for that case: an entry the finished turn never touched is written `unknown`,
         * ungraded in both directions, and only a cited entry carries the turn's grade. A fixture
         * that never produces `unknown` cannot see what the score does with it, and what the score
         * used to do with it was count it as a success.
         *
         * WHAT THIS FIXTURE STILL DOES NOT MATCH IS `fail`. The only caller of
         * `recordMemoryPackOutcome` in the product passes the literal `outcome: 'ok'`, so no turn
         * on this box writes `outcome='fail'` at all, and the `failedUses` histories below
         * exercise a partition production cannot currently reach. They are kept because the
         * negative weight is real SQL that something has to measure; they are not evidence that it
         * fires. The two outcomes production does write are `ok` and `unknown`, and those are the
         * two this now gets right.
         *
         * Changing this moved none of the committed numbers on the build it was written against,
         * because `unknown` and `ok` scored identically there; it is what makes them move now.
         */
        outcome: index >= ordered.length - failed ? 'fail' : index < cited ? 'ok' : 'unknown'
      });
  }
  if (input.withUsage) await input.store.consolidateMemory(input.workspaceId, { now: input.now });

  // Incremental document frequency only ever accrues, so the recall query would be reading counts
  // that were never reconciled. Every eval measures the settled state, which is the honest one.
  await input.store.rebuildMemoryCorpusStats(input.workspaceId);

  return {
    ids,
    sourceIds,
    conversations,
    writeCost: {
      items: MEMORY_EVAL_ITEMS.length,
      sources: MEMORY_EVAL_SOURCES.length,
      indexedBytes,
      millis: Number(process.hrtime.bigint() - started) / 1e6
    }
  };
};

/* ------------------------------------------------------------------------ *
 * Padding: the same corpus, under pressure
 *
 * The corpus above is fifty-one rows. That is enough to make quotas, the prior and the fusion
 * weights decide something - the pack holds forty-four - and it is nowhere near enough to make the
 * three per-channel candidate caps decide anything at all. `MEMORY_LEXICAL_CANDIDATES` takes the
 * top 120 rows a GIN probe matched and `MEMORY_FUZZY_SCAN_CANDIDATES` scores the top 600 a trigram
 * probe matched; on fifty-one rows neither can ever be reached, so every number the eval commits is
 * measured with the two caps switched off. They are the mitigation for "ranking gets slow at scale"
 * and they are also a selection step: a row cut at the cap is unreachable at any k, exactly like a
 * row no channel admitted, and nothing above would notice the difference.
 *
 * So the corpus is seeded a second time with several thousand rows that a real workspace of the
 * same age would be carrying - other services, other ports, other paths, other incidents - and the
 * committed numbers are measured twice. The padding is plausible and irrelevant on purpose: it is
 * written in the register the probes are asked in, so it competes for the caps and for the pack,
 * and it answers nothing, so a probe it displaces is a probe the retrieval genuinely lost.
 *
 * Every string here is a pure function of its index. A padding corpus drawn from a random source
 * would move the committed numbers between runs, which is the same defect `evalRowId` was written
 * to fix one level down.
 * ------------------------------------------------------------------------ */

/** Invented, and deliberately sharing no name with anything the probes ask about. */
const PADDING_SERVICES: readonly string[] = [
  'ingest',
  'shipper',
  'collector',
  'warden',
  'ledger',
  'courier',
  'beacon',
  'tallier',
  'sifter',
  'harbour',
  'anvil',
  'loom',
  'quarry',
  'trellis',
  'lantern',
  'ferry',
  'kiln',
  'orchard',
  'pantry',
  'mill'
];

const PADDING_HOSTS: readonly string[] = [
  '10.4.2.11',
  '10.4.2.12',
  '10.4.7.3',
  '10.9.1.40',
  '192.168.14.6',
  '127.0.0.1',
  '10.4.2.31',
  '10.11.0.2'
];

const PADDING_ROOTS: readonly string[] = [
  '/var/lib',
  '/var/log',
  '/opt/local/share',
  '/srv/data',
  '/var/spool',
  '/opt/state'
];

/**
 * Only predicates `MEMORY_PREDICATES` declares, because `mem.item.predicate` is a foreign key into
 * the predicate table. An invented one is rejected by the schema, which is the schema working.
 */
const PADDING_PREDICATES: readonly string[] = [
  'runs_on',
  'located_at',
  'uses_tool',
  'related_to',
  'project_status'
];

const PADDING_TEAMS: readonly string[] = ['team-blue', 'team-amber', 'team-slate', 'team-fern'];

const PADDING_STATUSES: readonly string[] = [
  'still being drained',
  'waiting on a rebuild',
  'running in one region only',
  'paused until the next window'
];

/**
 * Index-driven selection with coprime strides rather than a generator.
 *
 * A pseudorandom stream would be reproducible too, but only as long as nobody inserts a row above
 * it; strides keep every padding row a function of its own index alone, so the corpus can be grown
 * or shrunk and the rows that remain are the rows that were there before.
 */
const pick = <T>(values: readonly T[], index: number, stride: number): T =>
  values[(index * stride + stride) % values.length]!;

/**
 * How much padding. Sized off the caps rather than picked for roundness: the fuzzy scan cap is 600,
 * and a cap only measures something once the channel it caps has more rows than it will take, so
 * the item count is several times that. The source count is what puts `lex_src`'s 120 out of reach.
 */
export const MEMORY_EVAL_PADDING_ITEMS = 2_400;
export const MEMORY_EVAL_PADDING_SOURCES = 1_600;
export const MEMORY_EVAL_PADDING_CONVERSATIONS = 40;

const pad3 = (value: number): string => String(value % 1000).padStart(3, '0');

/**
 * Five consecutive indices are one service: three facts under three different predicates, a
 * runbook and an incident.
 *
 * The grouping is what makes the padding press on the parts of the pack that select rather than
 * only on the parts that rank. `mem.item` carries a unique index over (workspace, subject,
 * predicate) for current facts, so a subject repeated under one predicate is rejected outright; a
 * subject repeated under different ones is what the per-subject cap exists for.
 */
const paddingGroup = (index: number): number => Math.floor(index / 5);

/** A padding service's name, which is what its rows are about and what nothing asks for. */
const paddingUnit = (index: number): string => {
  const group = paddingGroup(index);
  return `svc-${pick(PADDING_SERVICES, group, 7)}-${String(group % 10_000).padStart(4, '0')}`;
};

/**
 * One padding item. Facts outnumber the rest roughly as they do in a store that has been written
 * to by the extraction path, because the quota that has to decide under pressure is the fact quota.
 */
export const memoryEvalPaddingItem = (index: number): MemoryEvalItem => {
  const unit = paddingUnit(index);
  const host = pick(PADDING_HOSTS, index, 3);
  const port = 9000 + (index % 900);
  const root = pick(PADDING_ROOTS, index, 5);
  const path = `${root}/${pick(PADDING_SERVICES, index, 11)}/${pad3(index % 89)}`;
  const ref = `pad-${pad3(Math.floor(index / 1000))}${pad3(index)}`;
  const daysAgo = 5 + (index % 700);
  const shape = index % 5;
  if (shape <= 2) {
    // Rotated by group so the three facts a service carries differ from each other and the corpus
    // as a whole still gets every predicate, rather than three of the five appearing everywhere.
    const predicate =
      PADDING_PREDICATES[(shape + paddingGroup(index)) % PADDING_PREDICATES.length]!;
    const object =
      predicate === 'runs_on'
        ? `${host}:${port}`
        : predicate === 'located_at'
          ? path
          : predicate === 'uses_tool'
            ? paddingUnit(index + 13)
            : predicate === 'related_to'
              ? pick(PADDING_TEAMS, index, 3)
              : pick(PADDING_STATUSES, index, 3);
    const body =
      predicate === 'runs_on'
        ? `${unit} listens on ${host}:${port} and is restarted by the supervisor when its ` +
          `health probe fails twice in a row.`
        : predicate === 'located_at'
          ? `${unit} writes its working set to ${path} and prunes anything older than ` +
            `${14 + (index % 60)} days.`
          : predicate === 'uses_tool'
            ? `${unit} will not start until ${object} is accepting connections on its socket.`
            : predicate === 'related_to'
              ? `${unit} is looked after by ${object}; changes to its unit file go through ` +
                `them first.`
              : `${unit} is ${object}: the migration off the old queue format is what is left.`;
    return {
      ref,
      kind: 'fact',
      title: `${unit} ${predicate === 'runs_on' ? 'listen address' : 'storage'}`,
      subject: unit,
      object,
      predicate,
      body,
      daysAgo
    };
  }
  if (shape === 3)
    return {
      ref,
      kind: 'procedure',
      title: `restart ${unit}`,
      tags: [pick(PADDING_SERVICES, index, 11), 'runbook'],
      body:
        `To restart ${unit}: drain its queue, stop the unit, wait for ${path} to settle, then ` +
        `start it again and confirm the health probe on ${host}:${port} answers within ` +
        `${5 + (index % 25)} seconds.`,
      daysAgo
    };
  return {
    ref,
    kind: 'episode',
    title: `${unit} stalled`,
    body:
      `${unit} stopped accepting work for ${3 + (index % 40)} minutes after the host clock ` +
      `stepped backwards. The queue at ${path} drained once the unit was restarted, and nothing ` +
      `downstream of ${host}:${port} noticed.`,
    daysAgo
  };
};

/** One padding turn, grouped into conversations so the verbatim channel is under pressure too. */
export const memoryEvalPaddingSource = (index: number): MemoryEvalSource => {
  const unit = paddingUnit(index);
  const host = pick(PADDING_HOSTS, index, 3);
  const port = 9000 + (index % 900);
  const root = pick(PADDING_ROOTS, index, 5);
  const role = index % 3 === 0 ? 'user' : index % 3 === 1 ? 'assistant' : 'tool';
  const body =
    role === 'user'
      ? `${unit} looks slow again, can you see what it is waiting on`
      : role === 'assistant'
        ? `${unit} was blocked on ${root} filling up. I pruned the oldest ${10 + (index % 50)} ` +
          `files and it started answering on ${host}:${port} again.`
        : `systemctl status ${unit}\n  active (running) since ${1 + (index % 28)}h ago\n  ` +
          `listening on ${host}:${port}`;
  return {
    ref: `padsrc-${pad3(Math.floor(index / 1000))}${pad3(index)}`,
    body,
    role,
    conversation: `pad-conversation-${pad3(index % MEMORY_EVAL_PADDING_CONVERSATIONS)}`,
    daysAgo: 5 + (index % 700)
  };
};

export interface MemoryEvalPadding {
  readonly items: number;
  readonly sources: number;
  readonly millis: number;
}

/**
 * Writes the padding into a store that already holds the corpus, through the same public methods.
 *
 * Facts go in through `createMemoryItem` rather than `recordMemoryFact`: every padding subject is
 * distinct, so there is nothing for supersession to retire, and 2,400 transactions to prove that is
 * most of a minute of test time for no assertion.
 */
export const seedMemoryEvalPadding = async (input: {
  store: DataStore;
  userId: string;
  workspaceId: string;
  key: Uint8Array;
  now: Date;
  items?: number;
  sources?: number;
}): Promise<MemoryEvalPadding> => {
  const started = process.hrtime.bigint();
  const items = input.items ?? MEMORY_EVAL_PADDING_ITEMS;
  const sources = input.sources ?? MEMORY_EVAL_PADDING_SOURCES;

  for (let index = 0; index < items; index += 1) {
    const item = memoryEvalPaddingItem(index);
    const observedAt = daysBefore(input.now, item.daysAgo);
    await input.store.createMemoryItem({
      id: evalRowId(item.ref),
      userId: input.userId,
      workspaceId: input.workspaceId,
      kind: item.kind,
      trust: 'stated',
      documentCiphertext: seal(item.body),
      index: buildMemoryItemIndex(
        {
          title: item.title ?? null,
          tags: item.tags ?? [],
          body: item.body,
          subject: item.subject ?? null,
          object: item.object ?? null
        },
        input.key
      ),
      predicate: item.predicate ?? null,
      observedAt,
      validFrom: observedAt,
      lastVerified: item.kind === 'procedure' ? observedAt : null
    });
  }

  const conversations = new Map<string, string>();
  const turnsSoFar = new Map<string, number>();
  for (let index = 0; index < sources; index += 1) {
    const source = memoryEvalPaddingSource(index);
    let taskId = conversations.get(source.conversation);
    if (!taskId) {
      const conversationTask = await input.store.createTask({
        userId: input.userId,
        workspaceId: input.workspaceId,
        modelId: 'eval-model',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 0,
        titleCiphertext: { v: 1, iv: 'eval', tag: 'eval', ciphertext: source.conversation },
        promptCiphertext: { v: 1, iv: 'eval', tag: 'eval', ciphertext: source.conversation },
        nameIndex: { nameTokens: '', openingTokens: '' }
      });
      taskId = conversationTask.id;
      conversations.set(source.conversation, taskId);
    }
    const turn = turnsSoFar.get(source.conversation) ?? 0;
    turnsSoFar.set(source.conversation, turn + 1);
    const sourceIndex = buildMemorySourceIndex(source.body, input.key);
    await input.store.createMemorySource({
      id: evalRowId(source.ref),
      userId: input.userId,
      workspaceId: input.workspaceId,
      channel: source.role === 'tool' ? 'terminal' : 'chat',
      role: source.role,
      taskId,
      bodyCiphertext: seal(source.body),
      bodyTokens: sourceIndex.bodyTokens,
      tokensEst: sourceIndex.tokensEst,
      indexed: sourceIndex.indexed,
      occurredAt: new Date(daysBefore(input.now, source.daysAgo).getTime() + turn * 60_000)
    });
  }

  // Document frequency drives every BM25 weight in the recall query, and the padding is most of the
  // corpus now: reading unreconciled counts would score the probes against a workspace that does
  // not exist.
  await input.store.rebuildMemoryCorpusStats(input.workspaceId);

  return { items, sources, millis: Number(process.hrtime.bigint() - started) / 1e6 };
};

/**
 * A row's id, derived from its ref rather than minted.
 *
 * Rows the ranking genuinely cannot separate are ordered by id, and with random ids that decided
 * real outcomes: `spelling-convention` sits exactly on the per-subject cap, so a run passed or
 * failed on which UUID sorted first. A measurement that changes between two runs over the same
 * corpus is not a measurement, and a committed number sitting on top of one is a coin toss that
 * fails in someone else's branch.
 */
const evalRowId = (ref: string): string => {
  const digest = createHash('sha256').update(`garden-memory-eval ${ref}`).digest('hex');
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32)
  ].join('-');
};

export const runMemoryRecallEval = async (input: {
  store: DataStore;
  workspaceId: string;
  key: Uint8Array;
  now: Date;
  seed: MemoryEvalSeed;
  budgetTokens?: number;
  maxItems?: number;
  /**
   * Lifting the budget alone does not lift the ceiling: the per-kind cap and the per-subject cap
   * are separate limits that a bigger budget never reaches past, so a "what could be retrieved at
   * all" run that only raised `budgetTokens` measured the same rows as the pack and quietly agreed
   * with itself. The ceiling run passes quotas wide enough that only admission is left.
   */
  quotas?: readonly MemoryPackQuota[];
  /**
   * Which pack the probes are scored against, so the numbers have a denominator.
   *
   * `ranked` is the real one. The other two are controls, and without them every committed figure
   * is an absolute nobody can read: recall 1.0 at 410 tokens means nothing until you know what
   * 410 arbitrary tokens of the same corpus would have scored, or whether the questions answer
   * themselves.
   *
   * `empty` sends no pack at all. It should score at or near zero; anything else means a probe is
   * self-answering and is measuring the question rather than the store.
   *
   * `random` fills the same token budget from the same reachable rows, chosen by a seeded shuffle
   * rather than by rank. It is the honest baseline the ranking has to beat, and it is committed as
   * a ceiling rather than a floor: if the ranked arm ever fails to clear it, the ranking is
   * decoration.
   */
  pack?: 'ranked' | 'empty' | 'random';
  /**
   * Padding rows sharing the workspace, counted into `pressure` and nothing else.
   *
   * The probes and the gold sets are identical across a padded and an unpadded run - that is what
   * makes the two sets of numbers comparable - so the only thing the report can say about the
   * padding is how much of it there was.
   */
  paddingRows?: number;
}): Promise<MemoryEvalReport> => {
  const byRef = input.seed.ids;
  const refOf = new Map([...byRef].map(([ref, id]) => [id, ref]));
  const probes: MemoryEvalProbeResult[] = [];
  const mode = input.pack ?? 'ranked';

  /**
   * A tiny deterministic generator, seeded per probe from its own id.
   *
   * The control has to be reproducible or it is not a control - a baseline that moves between runs
   * cannot be committed as a threshold. This is xorshift32, which is more than enough to shuffle a
   * few dozen rows and has no dependency.
   */
  const shuffled = <T>(values: readonly T[], seedText: string): T[] => {
    let state = 2_463_534_242;
    for (const character of seedText)
      state = ((state ^ character.charCodeAt(0)) * 16_777_619) >>> 0;
    const copy = [...values];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      const swap = state % (index + 1);
      [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
    }
    return copy;
  };

  /**
   * Every row any probe can reach, which is the pool the random arm draws from. Collected from the
   * ranked run rather than from a second query, so the control is drawn from exactly the rows the
   * ranking had available and the comparison is about ORDER rather than about admission.
   */
  const universe = new Map<string, { id: string; tokensEst: number }>();
  if (mode === 'random')
    for (const probe of MEMORY_EVAL_PROBES) {
      const reachable = await input.store.recallMemoryCandidates({
        workspaceId: input.workspaceId,
        plan: planMemoryQuery(probe.question, input.key),
        now: input.now,
        budgetTokens: input.budgetTokens ?? MEMORY_PACK_BUDGET_TOKENS,
        order: 'relevance',
        ...(input.maxItems === undefined ? {} : { maxItems: input.maxItems }),
        ...(input.quotas === undefined ? {} : { quotas: input.quotas }),
        ...(probe.recall ?? {})
      });
      for (const candidate of reachable)
        universe.set(candidate.id, { id: candidate.id, tokensEst: candidate.tokensEst });
    }

  for (const probe of MEMORY_EVAL_PROBES) {
    // Relevance order, because the row set is identical either way - `order` reaches only the final
    // ORDER BY - and this is the one that also yields a rank. That the two orders really do select
    // the same rows is asserted separately rather than assumed here.
    const budget = input.budgetTokens ?? MEMORY_PACK_BUDGET_TOKENS;
    const ranked =
      mode === 'empty'
        ? []
        : await input.store.recallMemoryCandidates({
            workspaceId: input.workspaceId,
            plan: planMemoryQuery(probe.question, input.key),
            now: input.now,
            budgetTokens: budget,
            order: 'relevance',
            ...(input.maxItems === undefined ? {} : { maxItems: input.maxItems }),
            ...(input.quotas === undefined ? {} : { quotas: input.quotas }),
            ...(probe.recall ?? {})
          });
    let candidates = ranked;
    if (mode === 'random') {
      // The same budget, filled from the same reachable rows in an order nobody chose.
      const drawn: typeof ranked = [];
      let spentTokens = 0;
      for (const row of shuffled([...universe.values()], probe.id)) {
        if (spentTokens + row.tokensEst > budget) continue;
        spentTokens += row.tokensEst;
        drawn.push(row as (typeof ranked)[number]);
        if (drawn.length >= ranked.length && ranked.length > 0) break;
      }
      candidates = drawn;
    }
    const refs = candidates.map((candidate) => refOf.get(candidate.id) ?? null);
    const returnedRefs = new Set(refs.filter((ref): ref is string => !!ref));
    const found = probe.gold.filter((ref) => returnedRefs.has(ref));
    const missed = probe.gold.filter((ref) => !returnedRefs.has(ref));
    const leaked = (probe.forbidden ?? []).filter((ref) => returnedRefs.has(ref));
    // Abstention inverts the test: a question the store cannot answer must not fill the pack with
    // the nearest available thing, because near misses cost the same tokens as answers.
    const unpinned = [...returnedRefs].filter((ref) => !ALWAYS_ON_REFS.has(ref));
    const hit =
      probe.gold.length === 0
        ? unpinned.length === 0 && candidates.length === returnedRefs.size
        : leaked.length === 0 && (probe.requireAll ? missed.length === 0 : found.length > 0);
    const goldAt = refs.findIndex((ref) => ref !== null && probe.gold.includes(ref));
    probes.push({
      id: probe.id,
      type: probe.type,
      question: probe.question,
      found,
      missed,
      leaked,
      hit,
      returned: candidates.length,
      rank: goldAt < 0 ? null : goldAt + 1,
      packTokens: candidates.reduce((total, candidate) => total + candidate.tokensEst, 0),
      goldTokens: candidates.reduce(
        (total, candidate, index) =>
          total + (probe.gold.includes(refs[index] ?? '') ? candidate.tokensEst : 0),
        0
      )
    });
  }

  // A probe the store is known not to answer scores nothing at all, so the numbers below stay
  // measurements of what retrieval does rather than of what it has been excused from.
  const expectedMisses = new Set(
    MEMORY_EVAL_PROBES.filter((probe) => probe.expectedMiss).map((probe) => probe.id)
  );
  const scored = probes.filter((result) => !expectedMisses.has(result.id));

  const byType = new Map<MemoryEvalQuestionType, { hit: number; total: number }>();
  for (const result of scored) {
    const bucket = byType.get(result.type) ?? { hit: 0, total: 0 };
    byType.set(result.type, { hit: bucket.hit + (result.hit ? 1 : 0), total: bucket.total + 1 });
  }

  // Abstention probes are excluded from rank and from the cost average: their correct pack is
  // empty, and averaging a zero-token pack into the cost of answering would flatter both numbers.
  const answerable = new Set(
    MEMORY_EVAL_PROBES.filter((probe) => probe.gold.length > 0 && !probe.expectedMiss).map(
      (probe) => probe.id
    )
  );
  const costed = probes.filter((result) => answerable.has(result.id));
  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
  const spent = mean(costed.map((result) => result.packTokens));

  return {
    probes,
    recall: scored.filter((result) => result.hit).length / scored.length,
    mrr: mean(costed.map((result) => (result.rank === null ? 0 : 1 / result.rank))),
    packTokens: spent,
    goldShare: spent === 0 ? 0 : mean(costed.map((result) => result.goldTokens)) / spent,
    pressure: MEMORY_EVAL_PADDED_PRESSURE(input.paddingRows ?? 0),
    byType,
    misses: scored.filter((result) => !result.hit).map((result) => result.id),
    expectedMisses: [...expectedMisses],
    leaks: probes.flatMap((result) => result.leaked.map((ref) => `${result.id}:${ref}`)),
    writeCost: input.seed.writeCost
  };
};

/** Renders a report the way a release check should print it: one line, then the misses by name. */
export const formatMemoryEvalReport = (report: MemoryEvalReport): string => {
  const scored = report.probes.filter((probe) => !report.expectedMisses.includes(probe.id));
  const lines = [
    `recall ${(report.recall * 100).toFixed(1)}% ` +
      `(${scored.filter((probe) => probe.hit).length}/${scored.length}) ` +
      `mrr ${report.mrr.toFixed(3)} ` +
      `pack ${report.packTokens.toFixed(0)}t (${(report.goldShare * 100).toFixed(0)}% gold) ` +
      `pressure ${report.pressure.toFixed(2)}x`,
    ...[...report.byType]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([type, count]) => `  ${type}: ${count.hit}/${count.total}`),
    `  write: ${report.writeCost.items} items, ${report.writeCost.sources} sources, ` +
      `${report.writeCost.indexedBytes} index bytes, ${report.writeCost.millis.toFixed(0)}ms`
  ];
  if (report.misses.length > 0) lines.push(`  missed: ${report.misses.join(', ')}`);
  // Printed apart from the misses above, because it is a gap the eval knows about and holds open.
  if (report.expectedMisses.length > 0)
    lines.push(`  known gap: ${report.expectedMisses.join(', ')}`);
  if (report.leaks.length > 0) lines.push(`  leaked: ${report.leaks.join(', ')}`);
  // The worst-ranked answers are where the next improvement is, so name them rather than the mean.
  const worst = report.probes
    .filter((probe) => probe.rank !== null && probe.rank > 3)
    .sort((left, right) => (right.rank ?? 0) - (left.rank ?? 0))
    .slice(0, 5);
  if (worst.length > 0)
    lines.push(`  deep: ${worst.map((probe) => `${probe.id}@${probe.rank}`).join(', ')}`);
  return lines.join('\n');
};

/* ------------------------------------------------------------------------ *
 * Searching past conversations
 *
 * The pack eval above measures what a task opens with. This measures the other half the owner
 * asked for by name: going back and finding what was actually said, months later, in words that
 * are not the words it was said in.
 *
 * It is a separate instrument because it has a separate failure mode. Pack recall is about
 * admission - did the row enter a channel at all. Verbatim search admits nearly everything that
 * shares a word with the question, so its whole difficulty is ordering: a transcript is thousands
 * of turns that all contain "the", and the question is one sentence. Every probe below is worded
 * as a person would ask months later rather than as the turn was worded, which is what makes the
 * ordering do the work.
 * ------------------------------------------------------------------------ */

export interface MemoryEvalSessionProbe {
  readonly id: string;
  readonly question: string;
  /** Refs of the turns that answer it. Any one of them counts: the reader gets the conversation. */
  readonly gold: readonly string[];
}

export const MEMORY_EVAL_SESSION_PROBES: readonly MemoryEvalSessionProbe[] = [
  {
    id: 'sess-relay-boot',
    question: 'why was the relay not running after the machine rebooted',
    gold: ['relay-turn-agent']
  },
  {
    id: 'sess-mail-late',
    question: 'why did mail only sync late in the day',
    gold: ['mail-turn-agent']
  },
  {
    id: 'sess-slide-clipped',
    question: 'what happened to the missing text at the bottom of a slide',
    gold: ['deck-turn-agent']
  },
  {
    id: 'sess-cert-validation',
    question: 'what fixed the certificate validation failure',
    gold: ['tls-turn-agent']
  },
  {
    id: 'sess-root-volume',
    question: 'what filled up the root volume',
    gold: ['disk-turn-agent']
  },
  {
    id: 'sess-sum-zero',
    question: 'why did the sum come out as zero',
    gold: ['sheet-turn-agent']
  },
  {
    id: 'sess-summary-early',
    question: 'why did the scheduled summary arrive an hour early',
    gold: ['cron-turn-agent']
  },
  {
    id: 'sess-build-killed',
    question: 'what killed the build process',
    gold: ['oom-turn-agent', 'oom-turn-tool']
  },
  {
    id: 'sess-runner-reachable',
    question: 'can the runner be reached from outside the box',
    gold: ['runner-turn-agent']
  },
  {
    id: 'sess-dump-written',
    question: 'where did the database dump get written',
    gold: ['snapshot-turn-tool']
  },
  {
    id: 'sess-journal-vacuum',
    question: 'how much space did vacuuming the journal free',
    gold: ['disk-turn-tool']
  },
  {
    id: 'sess-idle-interval',
    question: 'what did we change the imap idle interval to',
    gold: ['mail-turn-agent']
  }
];

/**
 * Read from the top: an agent given a page of search results reads the first few and stops, so a
 * hit at position nine is a miss with extra steps. Committing the number at a small k is what
 * stops a wider result page being mistaken for a better search.
 */
export const MEMORY_EVAL_SESSION_SEARCH_K = 5;

export interface MemoryEvalSearchProbeResult {
  readonly id: string;
  readonly question: string;
  readonly found: readonly string[];
  readonly rank: number | null;
  readonly returned: number;
}

export interface MemoryEvalSearchReport {
  readonly probes: readonly MemoryEvalSearchProbeResult[];
  readonly recall: number;
  readonly mrr: number;
  /** Distinct past conversations the results spanned, averaged over the probes. */
  readonly conversationsPerProbe: number;
  /**
   * Stored bodies that had to be opened to answer one question.
   *
   * The metric that does not flatter a small corpus. Accuracy over twenty-three turns says little
   * about accuracy over twenty-three thousand, but this says exactly what it will cost: the index
   * opens what it returns, and a scan opens the workspace. One is a constant, the other is the
   * owner's whole history, decrypted in the worker, on every search.
   */
  readonly decryptedPerProbe: number;
}

const searchReport = (
  probes: readonly MemoryEvalSearchProbeResult[],
  conversations: readonly number[],
  decrypted: readonly number[]
): MemoryEvalSearchReport => {
  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
  return {
    probes,
    recall: probes.filter((probe) => probe.found.length > 0).length / probes.length,
    mrr: mean(probes.map((probe) => (probe.rank === null ? 0 : 1 / probe.rank))),
    conversationsPerProbe: mean(conversations),
    decryptedPerProbe: mean(decrypted)
  };
};

/**
 * The indexed path: BM25 over the keyed blind index, capped per conversation.
 */
export const runMemorySessionSearchEval = async (input: {
  store: DataStore;
  workspaceId: string;
  key: Uint8Array;
  seed: MemoryEvalSeed;
  limit?: number;
  /** Lifted to measure what the per-conversation cap is actually holding back. */
  perTask?: number;
}): Promise<MemoryEvalSearchReport> => {
  const refOf = new Map([...input.seed.sourceIds].map(([ref, id]) => [id, ref]));
  const probes: MemoryEvalSearchProbeResult[] = [];
  const conversations: number[] = [];
  const decrypted: number[] = [];
  for (const probe of MEMORY_EVAL_SESSION_PROBES) {
    const hits = await input.store.searchMemorySources({
      workspaceId: input.workspaceId,
      plan: planMemoryQuery(probe.question, input.key),
      limit: input.limit ?? MEMORY_EVAL_SESSION_SEARCH_K,
      ...(input.perTask === undefined ? {} : { perTask: input.perTask })
    });
    const refs = hits.map((hit) => refOf.get(hit.id) ?? null);
    const at = refs.findIndex((ref) => ref !== null && probe.gold.includes(ref));
    probes.push({
      id: probe.id,
      question: probe.question,
      found: probe.gold.filter((ref) => refs.includes(ref)),
      rank: at < 0 ? null : at + 1,
      returned: hits.length
    });
    conversations.push(new Set(hits.map((hit) => hit.taskId ?? hit.id)).size);
    // Only the rows that came back are opened; the ranking happened in the database over tokens it
    // cannot read.
    decrypted.push(hits.length);
  }
  return searchReport(probes, conversations, decrypted);
};

/**
 * The path this replaced, kept so the delta stays measured rather than remembered.
 *
 * `session_search` used to decrypt the workspace's whole task history in the worker and rank it by
 * counting substring occurrences: eight points if the entire question appeared verbatim, one per
 * whitespace-separated word of it found anywhere in the text. No stemming, so "restarted" cannot
 * find "restart"; no document frequency, so the word "the" is worth exactly as much as "dovecot";
 * no length normalisation, so the longest transcript wins nearly every query.
 *
 * The corpus is the same turns either way. Only the retrieval differs, which is what makes the two
 * numbers comparable - and what stops the committed one being a claim about a bigger corpus.
 */
export const runSubstringSessionSearchEval = (
  limit: number = MEMORY_EVAL_SESSION_SEARCH_K
): MemoryEvalSearchReport => {
  const probes: MemoryEvalSearchProbeResult[] = [];
  const conversations: number[] = [];
  const decrypted: number[] = [];
  for (const probe of MEMORY_EVAL_SESSION_PROBES) {
    const question = probe.question.slice(0, 500).toLowerCase();
    const terms = [...new Set(question.split(/\s+/).filter((term) => term.length > 1))];
    const ranked = MEMORY_EVAL_SOURCES.map((source) => {
      const text = source.body.toLowerCase();
      return {
        source,
        score:
          (text.includes(question) ? 8 : 0) +
          terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0)
      };
    })
      .filter((entry) => entry.score > 0)
      // Score, then most recent first, exactly as the worker sorted its matches.
      .sort((left, right) => right.score - left.score || left.source.daysAgo - right.source.daysAgo)
      .slice(0, limit);
    const refs = ranked.map((entry) => entry.source.ref);
    const at = refs.findIndex((ref) => probe.gold.includes(ref));
    probes.push({
      id: probe.id,
      question: probe.question,
      found: probe.gold.filter((ref) => refs.includes(ref)),
      rank: at < 0 ? null : at + 1,
      returned: ranked.length
    });
    conversations.push(new Set(ranked.map((entry) => entry.source.conversation)).size);
    // Every stored body has to be opened before it can be scored, because the score is computed
    // over the plaintext. That is the cost the index removes, and it is the workspace's whole size.
    decrypted.push(MEMORY_EVAL_SOURCES.length);
  }
  return searchReport(probes, conversations, decrypted);
};

export const formatMemoryEvalSearchReport = (
  label: string,
  report: MemoryEvalSearchReport
): string => {
  const lines = [
    `${label}: recall@${MEMORY_EVAL_SESSION_SEARCH_K} ` +
      `${(report.recall * 100).toFixed(1)}% ` +
      `(${report.probes.filter((probe) => probe.found.length > 0).length}/${report.probes.length}) ` +
      `mrr ${report.mrr.toFixed(3)} ` +
      `spread ${report.conversationsPerProbe.toFixed(1)} conversations/probe ` +
      `opened ${report.decryptedPerProbe.toFixed(1)} bodies/probe`
  ];
  const missed = report.probes.filter((probe) => probe.found.length === 0).map((probe) => probe.id);
  if (missed.length > 0) lines.push(`  missed: ${missed.join(', ')}`);
  return lines.join('\n');
};

/* ------------------------------------------------------------------------ *
 * Do the candidate caps bind?
 *
 * The three caps inside `MEMORY_RECALL_SQL` are invisible from outside it: a channel that took the
 * top 120 of 40,000 rows and a channel that took all 40 it matched return the same shape, and the
 * only difference is that the first one silently dropped rows the second one would have ranked. So
 * the padded run needs a way to say "the cap was reached" that is not "the numbers got worse".
 *
 * This counts, per probe, how many rows each capped channel's admission predicate matches before
 * its LIMIT applies. It restates three WHERE clauses rather than sharing them, which is the one
 * thing this file otherwise refuses to do - but the statements are constants that the eval exists
 * to police, and a diagnostic that imported the same expression it is measuring would report that
 * the caps bind whatever the statement said. If the counts drift from the recall query's own
 * admission, that is a divergence worth failing on, not a duplication worth removing.
 * ------------------------------------------------------------------------ */

export interface MemoryChannelPressure {
  /** Rows `lex_item` would rank before `MEMORY_LEXICAL_CANDIDATES` cuts it. */
  readonly lexicalItems: number;
  /** Rows `lex_src` would rank before the same cap cuts it. */
  readonly lexicalSources: number;
  /** Rows `trg_cand` would score before `MEMORY_FUZZY_SCAN_CANDIDATES` cuts it. */
  readonly fuzzyCandidates: number;
}

export const measureMemoryChannelPressure = async (input: {
  database: Database;
  workspaceId: string;
  plan: MemoryQueryPlan;
}): Promise<MemoryChannelPressure> => {
  const result = await input.database.query<{
    lexical_items: string | number;
    lexical_sources: string | number;
    fuzzy_candidates: string | number;
  }>(
    `WITH q AS (
       SELECT $1::uuid AS ws,
              NULLIF(array_to_string($2::text[], ' | '), '')::tsquery AS ts,
              $3::text[] AS q_trg,
              $4::float8 AS threshold
     )
     SELECT
       (SELECT count(*) FROM mem.item i, q
          WHERE i.workspace_id = q.ws AND i.status = 'active' AND i.trust <> 'inferred'
            AND i.tsv @@ q.ts) AS lexical_items,
       (SELECT count(*) FROM mem.source s, q
          WHERE s.workspace_id = q.ws AND s.indexed AND s.tsv @@ q.ts) AS lexical_sources,
       (SELECT count(*) FROM mem.item i, q
          WHERE i.workspace_id = q.ws AND i.status = 'active' AND i.trust <> 'inferred'
            AND cardinality(q.q_trg) > 0
            AND i.trigrams && q.q_trg
            AND i.trigram_len >= q.threshold * cardinality(q.q_trg)
            AND i.trigram_len * q.threshold <= cardinality(q.q_trg)) AS fuzzy_candidates
     FROM q`,
    [input.workspaceId, input.plan.lexemes, input.plan.trigrams, MEMORY_FUZZY_SIMILARITY_THRESHOLD]
  );
  const row = result.rows[0]!;
  return {
    lexicalItems: Number(row.lexical_items),
    lexicalSources: Number(row.lexical_sources),
    fuzzyCandidates: Number(row.fuzzy_candidates)
  };
};
