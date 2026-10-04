import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_NAME_INDEX_STAMP,
  conversationNamePrefixTokens,
  isMemoryToken,
  MEMORY_DEAD_END_TAG,
  MEMORY_DEAD_END_TRUST_DAYS,
  MEMORY_EXCERPT_CHARS,
  MEMORY_FUZZY_SIMILARITY_THRESHOLD,
  MEMORY_PROCEDURE_STALE_DAYS,
  deadEndFromCheck,
  memoryDeadEndTagKey,
  memorySubjectKey,
  MEMORY_PACK_QUOTAS,
  MEMORY_RECALL_BUDGET_TOKENS,
  MEMORY_RECALL_QUOTAS,
  assertMemoryValidity,
  buildMemoryItemIndex,
  buildConversationNameIndex,
  buildMemorySourceIndex,
  MEMORY_KINDS,
  MEMORY_PACK_BUDGET_TOKENS,
  MEMORY_PACK_DEFAULT_QUOTA,
  MEMORY_PACK_OPEN_INTERVAL,
  isFunctionalMemoryPredicate,
  memoryAliasLexemes,
  memoryExcerpt,
  memoryIndexKey,
  memoryLexemes,
  memoryPackCitations,
  parseMemoryPackBody,
  memoryTemporalStatus,
  memoryTrigrams,
  planMemoryQuery,
  recallMemories,
  renderMemoryPack,
  resolveMemoryContradiction,
  type MemoryPackEntry
} from './memory.js';

const indexKey = memoryIndexKey(Buffer.alloc(32, 7));
const otherKey = memoryIndexKey(Buffer.alloc(32, 9));

describe('temporal memory', () => {
  const now = new Date('2026-07-31T08:00:00.000Z');

  it('keeps durable facts active and excludes future or expired facts', () => {
    expect(memoryTemporalStatus({ content: 'Durable' }, now)).toBe('active');
    expect(
      memoryTemporalStatus({ content: 'Later', validFrom: '2026-08-01T00:00:00.000Z' }, now)
    ).toBe('upcoming');
    expect(
      memoryTemporalStatus({ content: 'Old', validUntil: '2026-07-31T08:00:00.000Z' }, now)
    ).toBe('expired');
  });

  it('rejects invalid and inverted validity windows', () => {
    expect(() => assertMemoryValidity({ content: 'Invalid', validUntil: 'not-a-date' })).toThrow(
      'invalid'
    );
    expect(() =>
      assertMemoryValidity({
        content: 'Inverted',
        validFrom: '2026-08-02T00:00:00.000Z',
        validUntil: '2026-08-01T00:00:00.000Z'
      })
    ).toThrow('later');
  });

  it('recalls reviewed facts locally by relevance, recency, and bounded prompt size', () => {
    const recalled = recallMemories(
      [
        {
          id: 'old-shell',
          target: 'workspace',
          content: 'The deployment uses zsh scripts.',
          updatedAt: '2025-01-01T00:00:00.000Z'
        },
        {
          id: 'current-backup',
          target: 'workspace',
          content: 'The encrypted backup is stored off host.',
          updatedAt: '2026-07-30T00:00:00.000Z'
        },
        {
          id: 'preference',
          target: 'user',
          content: 'The user prefers concise status updates.',
          updatedAt: '2026-07-01T00:00:00.000Z'
        }
      ],
      'verify the backup before deployment',
      { maxItems: 2, maxCharacters: 200, now }
    );
    expect(recalled.map((entry) => entry.id)).toEqual(['current-backup', 'old-shell']);
    expect(recallMemories(recalled, 'backup', { maxItems: 4, maxCharacters: 20, now })).toEqual([]);
  });
});

describe('memory tokenizer', () => {
  it('keeps paths, flags, versions and hostnames whole while normalising prose', () => {
    expect(
      memoryLexemes('Running /usr/bin/fish 3.7.1 on host.example.com with --no-color')
    ).toEqual(['run', '/usr/bin/fish', '3.7.1', 'host.example.com', '--no-color']);
  });

  it('drops stop words and matches singular and plural forms of the same word', () => {
    expect(memoryLexemes('the backups on that host')).toEqual(['backup', 'host']);
    expect(memoryLexemes('a backup')).toEqual(['backup']);
    // Doubled consonants collapse so "deployed" and "deploys" land on one lexeme.
    expect(memoryLexemes('deployed')).toEqual(memoryLexemes('deploys'));
  });

  it('preserves lexeme order, which is what keeps tsvector positions meaningful', () => {
    expect(memoryLexemes('alpha beta alpha')).toEqual(['alpha', 'beta', 'alpha']);
  });
});

describe('keyed blind index', () => {
  it('produces stable tokens under one key and unrelated tokens under another', () => {
    const content = { title: 'default shell', tags: ['shell'], body: 'The owner uses fish.' };
    const first = buildMemoryItemIndex(content, indexKey);
    const second = buildMemoryItemIndex(content, indexKey);
    const foreign = buildMemoryItemIndex(content, otherKey);

    expect(first.bodyTokens).toBe(second.bodyTokens);
    expect(first.dedupeKey).toBe(second.dedupeKey);
    expect(first.bodyTokens).not.toBe(foreign.bodyTokens);
    // Tokens must survive `to_tsvector('simple', ...)` unchanged, so they stay purely alphabetic.
    expect(first.bodyTokens.split(' ').every((token) => /^[a-p]{16}$/.test(token))).toBe(true);
    expect(first.bodyTokens.split(' ')).toHaveLength(memoryLexemes(content.body).length);
  });

  it('keeps the plaintext out of every column it writes', () => {
    const index = buildMemoryItemIndex(
      { title: 'production database', body: 'prod runs on port 6543', object: 'port 6543' },
      indexKey
    );
    const written = [
      index.titleTokens,
      index.tagTokens,
      index.bodyTokens,
      index.dedupeKey,
      index.subjectKey ?? '',
      index.objectKey ?? '',
      ...index.trigrams,
      ...index.tagsHashed
    ].join(' ');
    for (const secret of ['prod', 'port', '6543', 'production', 'database'])
      expect(written).not.toContain(secret);
  });

  it('hashes trigrams without changing the similarity they encode', () => {
    const jaccard = (left: readonly string[], right: readonly string[]): number => {
      const shared = left.filter((value) => right.includes(value)).length;
      return shared / (left.length + right.length - shared);
    };
    const plainLeft = memoryTrigrams('garden.target');
    const plainRight = memoryTrigrams('garden.service');
    const keyedLeft = buildMemoryItemIndex({ body: '', title: 'garden.target' }, indexKey).trigrams;
    const keyedRight = buildMemoryItemIndex(
      { body: '', title: 'garden.service' },
      indexKey
    ).trigrams;

    expect(keyedLeft).toHaveLength(plainLeft.length);
    expect(jaccard(keyedLeft, keyedRight)).toBeCloseTo(jaccard(plainLeft, plainRight), 12);
    expect(jaccard(plainLeft, plainRight)).toBeGreaterThan(MEMORY_FUZZY_SIMILARITY_THRESHOLD);

    // Unrelated text still shares the leading padding trigram of any word starting with the same
    // letter ("the" and "target" both yield "  t"), which is exactly why a bare overlap test is
    // not enough and the threshold has to exist.
    const unrelated = buildMemoryItemIndex(
      { title: 'Wrote the brief', body: 'Edited PREFERENCES.md by hand.' },
      indexKey
    ).trigrams;
    expect(unrelated.some((gram) => keyedLeft.includes(gram))).toBe(true);
    expect(jaccard(keyedLeft, unrelated)).toBeLessThan(MEMORY_FUZZY_SIMILARITY_THRESHOLD);
  });

  it('stores blobs unindexed rather than poisoning the lexeme dictionary', () => {
    const blob = Buffer.from('x'.repeat(4_000)).toString('base64');
    const source = buildMemorySourceIndex(blob, indexKey);
    expect(source.indexed).toBe(false);
    expect(source.bodyTokens).toBe('');
    // The row is still worth storing; only the lexical index refuses it.
    expect(source.tokensEst).toBeGreaterThan(0);

    const prose = buildMemorySourceIndex('systemctl restart garden.target succeeded', indexKey);
    expect(prose.indexed).toBe(true);
    expect(prose.bodyTokens).not.toBe('');
  });

  it('keeps a conversation findable by its name when its request is a pasted blob', () => {
    const blob = Buffer.from('x'.repeat(80_000)).toString('base64');
    const index = buildConversationNameIndex('Kitchen rewire', blob, indexKey);
    // The two surfaces go through the tokenizer separately, so the guard that refuses the blob
    // does not take the name down with it.
    expect(index.nameTokens).not.toBe('');
    expect(index.openingTokens).toBe('');

    // A name is matched with exactly the tokens a query is planned with, which is the whole reason
    // the corpus indexer is reused here rather than a second one written beside it: the stemmer
    // that makes "restarted" find "restart" in a transcript now does it in a name too.
    const named = buildConversationNameIndex('Relay restart', '', indexKey);
    const planned = planMemoryQuery('restarted the relays', indexKey).lexemes;
    for (const token of named.nameTokens.split(' ')) expect(planned).toContain(token);

    // A request longer than the bound contributes its opening and stops there.
    const long = buildConversationNameIndex('', `${'relay '.repeat(400)}gooseberry`, indexKey);
    expect(long.openingTokens).not.toBe('');
    expect(long.openingTokens.split(' ')).not.toContain(
      buildConversationNameIndex('gooseberry', '', indexKey).nameTokens
    );
  });

  it('finds a name by the first letters of a word in it, and only by the word being typed', () => {
    const audit = buildConversationNameIndex('Grimbolder audit', '', indexKey).prefixTokens!;
    // The case the index could not answer at all: a word the owner is half way through typing.
    for (const typed of ['gri', 'grim', 'grimbold', 'grimbolder'])
      expect(audit.split(' ')).toContain(conversationNamePrefixTokens(typed, indexKey)[0]);

    // Two letters narrow nothing, so nothing is indexed for them and nothing is asked for.
    expect(conversationNamePrefixTokens('gr', indexKey)).toEqual([]);
    expect(audit.split(' ')).not.toContain(
      conversationNamePrefixTokens('grx', indexKey)[0] ?? 'none'
    );

    // Only the word still being typed. "audit" is finished, and a finished word that happens to
    // start another word must not quietly widen the search that was actually asked for.
    const [typing] = conversationNamePrefixTokens('audit grimbold', indexKey);
    expect(typing).toBe(conversationNamePrefixTokens('grimbold', indexKey)[0]);
    expect(conversationNamePrefixTokens('grimbold audit', indexKey)[0]).toBe(
      conversationNamePrefixTokens('audit', indexKey)[0]
    );

    // Through the same stemmer as the index, so a half-typed word lands where the whole one did.
    expect(
      buildConversationNameIndex('Released relays', '', indexKey).prefixTokens!.split(' ')
    ).toContain(conversationNamePrefixTokens('releas', indexKey)[0]);

    // And through the same alias expansion, so a prefix reaches a compound name by its parts the
    // way the whole word already does.
    const relay = buildConversationNameIndex('garden-relay ticket', '', indexKey).prefixTokens!;
    expect(relay.split(' ')).toContain(conversationNamePrefixTokens('rel', indexKey)[0]);
    expect(relay.split(' ')).toContain(conversationNamePrefixTokens('garden-rel', indexKey)[0]);

    // A word nobody is typing the front of has nothing to ask with.
    expect(conversationNamePrefixTokens('what', indexKey)).toEqual([]);
    expect(conversationNamePrefixTokens('', indexKey)).toEqual([]);
  });

  it('keeps the prefixes keyed, bounded, and out of the blob guard’s reach', () => {
    const index = buildConversationNameIndex('Grimbolder audit', '', indexKey);
    const tokens = index.prefixTokens!.split(' ');
    // Nothing here is reversible: a prefix is a keyed token like any other, in its own domain, so
    // the database can match one and cannot read one, and the same name under another workspace's
    // key is a different set of tokens entirely.
    for (const token of tokens) expect(isMemoryToken(token)).toBe(true);
    expect(index.prefixTokens).not.toContain('grim');
    expect(buildConversationNameIndex('Grimbolder audit', '', otherKey).prefixTokens).not.toBe(
      index.prefixTokens
    );
    // The whole-word surface and the prefix surface are separate token spaces, so a row matched by
    // a prefix can be ranked below one matched by the word.
    expect(tokens).not.toContain(buildConversationNameIndex('grimbolder', '', indexKey).nameTokens);

    // What it costs: one token per length, from three to the word, per word of the name.
    expect(tokens).toHaveLength('grimbolder'.length - 2 + ('audit'.length - 2));

    // A pasted line in a name is bounded rather than indexed once per character.
    const pasted = buildConversationNameIndex(
      Array.from({ length: 60 }, (_, index) => `word${index}`).join(' '),
      '',
      indexKey
    );
    expect(pasted.prefixTokens!.split(' ').length).toBeLessThanOrEqual(128);

    // A name the blob guard refused has no prefixes either: it must not come back in through them.
    const blob = Buffer.from('x'.repeat(80_000)).toString('base64');
    expect(buildConversationNameIndex(blob, '', indexKey).prefixTokens).toBe('');
  });

  it('writes the prefixes in an order that says nothing about the words they came from', () => {
    /*
     * A tsvector keeps the position of every lexeme, so the order this string is written in is
     * stored and can be read straight off a database dump. Anything the order depends on is
     * therefore published: hand the prefixes over in the order of the words they came from and each
     * row states which keyed token sorts before which, which merges across a history into an
     * alphabetical order over the whole vocabulary and takes most of the work out of guessing what
     * the tokens stand for. Sorted by the token, each one sits where its own value puts it, which
     * a reader could already have worked out from the token itself.
     */
    const tokens = buildConversationNameIndex('zebra apple', '', indexKey).prefixTokens!.split(' ');
    expect(tokens).toEqual([...tokens].sort());

    // The same set of words in the other order is the same name to a reader of the column, which is
    // the whole property: the order carries the tokens' own values and nothing about the plaintext.
    expect(buildConversationNameIndex('apple zebra', '', indexKey).prefixTokens).toBe(
      tokens.join(' ')
    );

    // And the ordering of the plaintext is not recoverable from it: `apple`'s rungs sort before
    // `zebra`'s as plaintext, and where they land here is decided by something the key controls.
    const rungsOf = (word: string): string[] =>
      buildConversationNameIndex(word, '', indexKey).prefixTokens!.split(' ');
    const apple = new Set(rungsOf('apple'));
    expect(tokens.filter((token) => apple.has(token))).not.toEqual(tokens.slice(0, apple.size));
  });

  it('stamps the shape of the vector it wrote, in a value that says nothing about the owner', () => {
    // The one thing a backfill can ask a row that has already been written, and the reason it can
    // tell "indexed before prefixes existed" from "a name with no prefixes in it".
    expect(isMemoryToken(CONVERSATION_NAME_INDEX_STAMP)).toBe(true);
    expect(CONVERSATION_NAME_INDEX_STAMP).toHaveLength(20);
    // Longer than any keyed lexeme token, so no name can ever produce it.
    const lengths = new Set(
      buildConversationNameIndex('Grimbolder audit', 'Look at the ledger', indexKey)
        .nameTokens.split(' ')
        .map((token) => token.length)
    );
    expect(lengths).toEqual(new Set([16]));
  });
});

describe('memory query planning', () => {
  it('caps lexemes, derives entity keys from unigrams and bigrams, and spots temporal intent', () => {
    const plan = planMemoryQuery('which shell does the owner use on host.example.com?', indexKey);
    expect(plan.lexemes.length).toBeLessThanOrEqual(512);
    expect(plan.lexemes).toEqual([...plan.lexemes].sort());
    expect(plan.temporalIntent).toBe(false);
    // "host.example.com" is identifier-shaped, so it reaches the fuzzy channel; prose does not.
    expect(plan.trigrams.length).toBeGreaterThan(0);

    const subjectOnly = planMemoryQuery('owner', indexKey);
    expect(plan.entityKeys).toContain(subjectOnly.entityKeys[0]);

    expect(planMemoryQuery('which shell did I use previously?', indexKey).temporalIntent).toBe(
      true
    );
    expect(planMemoryQuery('what was I using before the migration?', indexKey).temporalIntent).toBe(
      true
    );
  });

  it('matches a stored subject key so facts about a named thing are pulled exactly', () => {
    const stored = buildMemoryItemIndex({ body: 'x', subject: '  Postgres  ' }, indexKey);
    expect(planMemoryQuery('is postgres still running?', indexKey).entityKeys).toContain(
      stored.subjectKey
    );
  });

  it('hands the database every term of a long request, including the rare ones', () => {
    // The defect this replaces: the plan keyed each lexeme, sorted the *hashes* and kept 24. An
    // HMAC sorts as noise, so survival was pseudorandom with respect to meaning, and the terms
    // most worth matching - the ones that occur once in the whole store - were the likeliest
    // casualties. A realistic request is well over two dozen content words.
    const request = `The mail connector has been polling instead of idling since yesterday.
      Check /srv/garden/var/log for dovecot errors, confirm imap_idle_notify_interval is not back
      at its default, and tell me whether the reboot last week is what changed it. Digest mail
      arrives empty in the morning and only catches up later, which first looked like a regression
      in the poll loop but might be the connector reconnecting without a session.`;
    const plan = planMemoryQuery(request, indexKey);
    const distinct = new Set([...memoryLexemes(request), ...memoryAliasLexemes(request)]);
    expect(distinct.size).toBeGreaterThan(24);
    expect(plan.lexemes.length).toBe(distinct.size);

    // Every discriminative term the old planner threw away survives, checked by the same keyed
    // token the index would have written for it.
    for (const term of ['dovecot', 'imap_idle_notify_interval', 'connector', 'reboot'])
      expect(plan.lexemes).toEqual(
        expect.arrayContaining(planMemoryQuery(term, indexKey).lexemes.slice(0, 1))
      );
  });

  it('reaches a compound name by the word a person would use for it', () => {
    // subject 'garden-relay' is one lexeme, so "relay" shares nothing with it lexically and
    // nothing structurally either - subject keys are exact equality. The alias surface is the
    // bridge, and it has to work in both directions.
    const stored = buildMemoryItemIndex(
      {
        title: 'bind address',
        body: 'It binds 0.0.0.0:8443 behind the SNI proxy.',
        subject: 'garden-relay',
        object: '0.0.0.0:8443'
      },
      indexKey
    );
    const aliasTokens = new Set(stored.aliasTokens.split(' ').filter(Boolean));
    expect(aliasTokens.size).toBeGreaterThan(0);

    const plain = planMemoryQuery('what port does the relay listen on', indexKey);
    const exact = planMemoryQuery('what is garden-relay bound to', indexKey);
    const bodyTokens = new Set(stored.bodyTokens.split(' ').filter(Boolean));
    const titleTokens = new Set(stored.titleTokens.split(' ').filter(Boolean));

    // Without the alias field the plain-language question reaches no indexed token of this row.
    expect(plain.lexemes.some((token) => bodyTokens.has(token) || titleTokens.has(token))).toBe(
      false
    );
    expect(plain.lexemes.some((token) => aliasTokens.has(token))).toBe(true);
    // And the exact name still matches, through the query's own alias expansion.
    expect(exact.lexemes.some((token) => aliasTokens.has(token))).toBe(true);
  });

  it('splits compounds into words worth asking by and leaves prose alone', () => {
    expect(memoryAliasLexemes('garden-relay')).toEqual(['garden', 'relay']);
    expect(memoryAliasLexemes('imap_idle_notify_interval')).toEqual([
      'idle',
      'imap',
      'interval',
      'notify'
    ]);
    expect(memoryAliasLexemes('/srv/garden/var/log')).toEqual(['garden', 'log', 'srv', 'var']);
    expect(memoryAliasLexemes('PowerPoint')).toEqual(['point', 'power']);
    // Ordinary prose already produces these lexemes, so it contributes nothing and costs nothing.
    expect(memoryAliasLexemes('the owner uses fish on this computer')).toEqual([]);
    // Digits alone are not words anybody searches by.
    expect(memoryAliasLexemes('0.0.0.0:8443')).toEqual([]);
  });
});

describe('memory contradiction policy', () => {
  const stated = { id: 'a', trust: 'stated' as const, observedAt: '2026-01-01T00:00:00.000Z' };
  const derivedOld = { id: 'b', trust: 'derived' as const, observedAt: '2025-01-01T00:00:00.000Z' };
  const derivedNew = { id: 'c', trust: 'derived' as const, observedAt: '2026-06-01T00:00:00.000Z' };
  const statedToo = { id: 'd', trust: 'stated' as const, observedAt: '2026-05-01T00:00:00.000Z' };

  it('never silently picks a winner between two things the owner stated', () => {
    expect(resolveMemoryContradiction(stated, statedToo, 'contradict')).toEqual({
      action: 'dispute',
      ids: ['a', 'd']
    });
  });

  it('lets a stated fact retract a derived one and lets the newer derived fact win', () => {
    expect(resolveMemoryContradiction(derivedOld, stated, 'contradict')).toEqual({
      action: 'retract',
      winnerId: 'a',
      loserId: 'b'
    });
    expect(resolveMemoryContradiction(derivedOld, derivedNew, 'contradict')).toEqual({
      action: 'supersede',
      winnerId: 'c',
      loserId: 'b'
    });
  });

  it('keeps both sides when one refines the other and does nothing when they agree', () => {
    expect(resolveMemoryContradiction(stated, derivedNew, 'refines')).toEqual({
      action: 'support',
      ids: ['a', 'c']
    });
    expect(resolveMemoryContradiction(stated, statedToo, 'agree')).toEqual({ action: 'none' });
    expect(resolveMemoryContradiction(stated, statedToo, 'unrelated')).toEqual({ action: 'none' });
  });

  it('marks exactly the predicates that can only hold one current value', () => {
    expect(isFunctionalMemoryPredicate('default_shell')).toBe(true);
    expect(isFunctionalMemoryPredicate('prefers')).toBe(false);
    expect(isFunctionalMemoryPredicate('not_a_predicate')).toBe(false);
  });
});

describe('dead ends', () => {
  const key = memoryIndexKey(Buffer.alloc(32, 3));
  const observedAt = new Date('2026-08-12T09:00:00.000Z');
  const command = 'pytest -q tests/importer';
  const built = deadEndFromCheck(
    {
      label: 'the importer test passes',
      command,
      cwd: '/srv/importer',
      detail: 'exit 1 (expected 0): AssertionError: expected 3 rows'
    },
    observedAt,
    key
  );

  /**
   * The sentence is the whole safety argument. A memory that says a command does not work will be
   * read by a turn that could have made it work, so it says what was seen and when, and stops.
   */
  it('records one observation rather than a verdict on the command', () => {
    expect(built.content.body).toContain('did not pass when the harness last ran it');
    expect(built.content.body).toContain('AssertionError: expected 3 rows');
    expect(built.content.body).toContain('Running it again is what settles whether');
    // Nothing that reads as a standing property of the command or of the project.
    expect(built.content.body).not.toMatch(/does not work|is broken|always fails|never/iu);
  });

  it('is trusted for two weeks where a procedure is trusted for six months', () => {
    expect(built.validTo.getTime() - observedAt.getTime()).toBe(
      MEMORY_DEAD_END_TRUST_DAYS * 86_400_000
    );
    expect(MEMORY_DEAD_END_TRUST_DAYS).toBeLessThan(MEMORY_PROCEDURE_STALE_DAYS);
  });

  /**
   * The two halves have to meet on the same subject or nothing ever retires anything: a passing run
   * keys its procedure on the bare command line, so this does too.
   */
  it('keys on the command exactly as a passing run does', () => {
    expect(built.index.subjectKey).toBe(memorySubjectKey(command, key));
  });

  /**
   * And the store, which holds no plaintext, has to be able to find these rows by that tag. If the
   * two ever drifted apart, dead ends would still be written and nothing could ever take them back.
   */
  it('carries a tag the store can match without the key', () => {
    expect(built.index.tagsHashed).toContain(memoryDeadEndTagKey(key));
    // Kept whole by the tokenizer, so asking about something that failed does not summon all of
    // them on the strength of one stemmed word.
    expect(memoryLexemes(MEMORY_DEAD_END_TAG)).toEqual([MEMORY_DEAD_END_TAG]);
    expect(planMemoryQuery('why did the deploy fail', key).tagTokens).not.toContain(
      memoryDeadEndTagKey(key)
    );
  });

  it('keeps a wall of output out of the pack', () => {
    const noisy = deadEndFromCheck(
      { label: 'build', command: 'make', cwd: '/srv', detail: 'exit 2: '.padEnd(9_000, 'x') },
      observedAt,
      key
    );
    expect(noisy.content.body.length).toBeLessThan(600);
  });
});

describe('memory pack rendering', () => {
  const entries: MemoryPackEntry[] = [
    {
      id: '2a000000-0000-4000-8000-000000000002',
      kind: 'episode',
      trust: 'derived',
      observedAt: '2026-07-30T12:00:00.000Z',
      validFrom: '2026-07-30T12:00:00.000Z',
      validTo: null,
      title: 'Restored the backup',
      tags: ['backup', 'ops'],
      body: 'Verified the archive and restarted the service.'
    },
    {
      id: '1a000000-0000-4000-8000-000000000001',
      kind: 'fact',
      trust: 'stated',
      observedAt: '2026-07-01T09:30:00.000Z',
      validFrom: '2026-07-01T09:30:00.000Z',
      validTo: '2026-07-25T00:00:00.000Z',
      title: null,
      tags: [],
      body: 'default_shell = fish'
    },
    {
      id: '3a000000-0000-4000-8000-000000000003',
      kind: 'fact',
      trust: 'stated',
      observedAt: '2026-07-25T00:00:00.000Z',
      validFrom: '2026-07-25T00:00:00.000Z',
      validTo: null,
      title: null,
      tags: [],
      body: 'default_shell = zsh'
    }
  ];

  it('renders identical bytes regardless of the order candidates arrived in', () => {
    const forward = renderMemoryPack(entries);
    const reversed = renderMemoryPack([...entries].reverse());
    const rotated = renderMemoryPack([entries[1]!, entries[2]!, entries[0]!]);

    expect(reversed.body).toBe(forward.body);
    expect(rotated.body).toBe(forward.body);
    expect(reversed.sha256).toBe(forward.sha256);
    // Facts before episodes, and by id inside each section - never by score.
    expect(forward.itemIds).toEqual([
      '1a000000-0000-4000-8000-000000000001',
      '3a000000-0000-4000-8000-000000000003',
      '2a000000-0000-4000-8000-000000000002'
    ]);
  });

  it('renders only absolute timestamps and never a counter or a clock reading', () => {
    const rendered = renderMemoryPack(entries).body;
    expect(rendered).toContain('observed=2026-07-01T09:30:00.000Z');
    expect(rendered).toContain('valid=2026-07-01T09:30:00.000Z/2026-07-25T00:00:00.000Z');
    expect(rendered).not.toMatch(/\bago\b|\bdays\b|\d+ (?:memories|items)|loaded/i);
    // Rendering twice a millisecond apart must not produce a byte of difference.
    expect(renderMemoryPack(entries).sha256).toBe(renderMemoryPack(entries).sha256);
  });

  it('collapses a candidate that appeared on two channels into one entry', () => {
    const duplicated = renderMemoryPack([...entries, entries[0]!]);
    expect(duplicated.itemIds).toHaveLength(3);
    expect(duplicated.sha256).toBe(renderMemoryPack(entries).sha256);
  });

  it('publishes a quota table that spends the whole budget across the tiers', () => {
    const total = MEMORY_PACK_QUOTAS.reduce((sum, quota) => sum + quota.share, 0);
    expect(total).toBeCloseTo(1, 10);
    // Verbatim source keeps a slot of its own: replacing it with extracted facts loses accuracy.
    expect(MEMORY_PACK_QUOTAS.some((quota) => quota.kind === 'source')).toBe(true);
  });

  it('gives every declared kind a quota, and every rendered section a kind', () => {
    // The recall query joins rows to this table by kind, so a kind that is missing from it is
    // ranked and then silently dropped. 'entity' was in MemoryKind, in MEMORY_KINDS and first in
    // the rendered pack, and had no quota - it could never appear in a pack at all. It is gone now,
    // because nothing ever wrote one; these two lists staying in step is what keeps the next kind
    // from repeating it.
    const quota = new Map(MEMORY_PACK_QUOTAS.map((entry) => [entry.kind, entry]));
    for (const kind of MEMORY_KINDS) expect(quota.get(kind), `no quota for ${kind}`).toBeDefined();
    expect(MEMORY_PACK_DEFAULT_QUOTA.share).toBeGreaterThan(0);
    expect(MEMORY_PACK_DEFAULT_QUOTA.cap).toBeGreaterThan(0);

    for (const kind of MEMORY_KINDS) {
      const rendered = renderMemoryPack([
        {
          id: '11111111-1111-4111-8111-111111111111',
          kind,
          trust: 'stated',
          observedAt: '2026-07-01T00:00:00.000Z',
          validFrom: '2026-07-01T00:00:00.000Z',
          validTo: null,
          title: 'garden-relay',
          tags: [],
          body: 'The SNI relay in front of every published service.'
        }
      ]);
      expect(rendered.body, `${kind} renders no section`).toContain('## ');
      expect(rendered.itemIds, `${kind} was dropped from the pack`).toHaveLength(1);
    }
  });
});

describe('excerpting a stored body', () => {
  const transcript = [
    'I asked whether the morning digest had gone out and it had not.',
    'The queue was empty, the notifier was up, and nothing had been delivered since Tuesday.',
    'garden-relay was never enabled at boot, so a restart left it stopped.',
    'I ran systemctl enable --now garden-relay and it is listening on 0.0.0.0:8443 again.',
    'After that the digest went out on the next tick and the backlog cleared.'
  ].join('\n');

  it('returns a short body whole rather than decorating it', () => {
    expect(memoryExcerpt('the relay is down', 'relay')).toBe('the relay is down');
  });

  it('cuts at the passage the index matched, not at the literal query', () => {
    // The body never contains the word "restarted" - only "restart". A substring search finds no
    // position at all here and silently excerpts from character zero, which is a different
    // paragraph. The stemmer is what makes the window land on the sentence that answers.
    const excerpt = memoryExcerpt(transcript, 'why was the relay stopped after I restarted', {
      maxChars: 120
    });
    expect(excerpt).toContain('never enabled at boot');
    expect(excerpt).not.toContain('morning digest had gone out');
    expect(excerpt.startsWith('…')).toBe(true);
  });

  it('prefers the window that covers the most of the question', () => {
    const excerpt = memoryExcerpt(transcript, 'systemctl enable garden-relay listening 8443', {
      maxChars: 130
    });
    expect(excerpt).toContain('systemctl enable --now garden-relay');
    expect(excerpt).toContain('0.0.0.0:8443');
  });

  it('points at the compound term the index actually matched on', () => {
    // The index admits this row because the alias surface splits `garden-relay` into its parts, so
    // a question asking about "the relay" reaches it. The excerpt has to reach the same place: no
    // token in this body equals `relay`, and matching on lexemes alone excerpts from the top.
    expect(memoryLexemes(transcript)).not.toContain('relay');
    const excerpt = memoryExcerpt(transcript, 'when was the relay last enabled', { maxChars: 90 });
    expect(excerpt).toContain('garden-relay');
  });

  it('falls back to the head of the body when nothing in the question occurs in it', () => {
    const excerpt = memoryExcerpt(transcript, 'dentist appointment', { maxChars: 60 });
    expect(excerpt.startsWith('I asked whether')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('stays inside the length it was given, whatever it matched', () => {
    const long = `${'padding word '.repeat(400)}the relay listens on 8443${' trailing word'.repeat(400)}`;
    for (const maxChars of [80, 200, MEMORY_EXCERPT_CHARS]) {
      const excerpt = memoryExcerpt(long, 'which port does the relay listen on', { maxChars });
      expect(excerpt.length).toBeLessThanOrEqual(maxChars + 2);
      expect(excerpt).toContain('8443');
    }
  });

  it('never opens mid-word', () => {
    const excerpt = memoryExcerpt(transcript, 'notifier', { maxChars: 100 });
    expect(excerpt).toContain('notifier');
    expect(/^…\S*\s/u.test(excerpt) || !excerpt.startsWith('…')).toBe(true);
  });

  it('is deterministic, because a search result is quoted back into a later turn', () => {
    const once = memoryExcerpt(transcript, 'relay enabled at boot', { maxChars: 140 });
    expect(memoryExcerpt(transcript, 'relay enabled at boot', { maxChars: 140 })).toBe(once);
  });
});

describe('recall quotas', () => {
  it('gives every kind an even share, unlike the pack', () => {
    // The pack is answering "what does this task need to know" and weights the tiers accordingly.
    // A recall is answering one narrow question, and which tier holds its answer is exactly what
    // the asker does not know - so no tier may start ahead of another.
    const shares = new Set(MEMORY_RECALL_QUOTAS.map((quota) => quota.share));
    expect(shares.size).toBe(1);
    for (const kind of MEMORY_KINDS)
      expect(MEMORY_RECALL_QUOTAS.some((quota) => quota.kind === kind)).toBe(true);
  });

  it('costs a fraction of a pack, because it buys one answer rather than a context', () => {
    expect(MEMORY_RECALL_BUDGET_TOKENS).toBeLessThan(MEMORY_PACK_BUDGET_TOKENS / 2);
  });
});

describe('an open validity interval says what it means', () => {
  const open: MemoryPackEntry = {
    id: '4a000000-0000-4000-8000-000000000004',
    kind: 'fact',
    trust: 'stated',
    observedAt: '2026-07-01T00:00:00.000Z',
    validFrom: '2026-07-01T00:00:00.000Z',
    validTo: null,
    title: null,
    tags: [],
    body: 'The gateway listens on 8443.'
  };

  it('names the open end instead of trailing off after the separator', () => {
    const rendered = renderMemoryPack([open]).body;
    // The bytes must not end `.../`: the block's own header explains only what an *ended* validity
    // means, so the live entries - which are all of them, most of the time - would be the ones
    // rendered ambiguously.
    expect(rendered).toContain('valid=2026-07-01T00:00:00.000Z/Present');
    expect(rendered).not.toMatch(/valid=\S+\/(?:\s|$)/mu);
  });

  it('still renders a closed interval as two instants, because that reading was never unclear', () => {
    const closed = renderMemoryPack([{ ...open, validTo: '2026-07-25T00:00:00.000Z' }]).body;
    expect(closed).toContain('valid=2026-07-01T00:00:00.000Z/2026-07-25T00:00:00.000Z');
    expect(closed).not.toContain(MEMORY_PACK_OPEN_INTERVAL);
  });
});

/**
 * The producer for `mem.item.cited_count` - a term of the salience formula that, before this wave,
 * read a column nothing in the product ever wrote.
 */
describe('attributing a finished turn to the entries it used', () => {
  const rate: MemoryPackEntry = {
    id: '11111111-0000-4000-8000-000000000001',
    kind: 'fact',
    trust: 'stated',
    observedAt: '2026-07-01T00:00:00.000Z',
    validFrom: '2026-07-01T00:00:00.000Z',
    validTo: null,
    title: 'brochure renewal rate',
    tags: [],
    body: 'The renewal rate on the brochure job is 4.25 per cent for the current term.'
  };
  const send: MemoryPackEntry = {
    id: '22222222-0000-4000-8000-000000000002',
    kind: 'episode',
    trust: 'derived',
    observedAt: '2026-07-01T00:00:00.000Z',
    validFrom: '2026-07-01T00:00:00.000Z',
    validTo: null,
    title: 'the last brochure send',
    tags: [],
    body: 'The last brochure send was held back until every font came back embedded.'
  };
  const parsed = (...entries: MemoryPackEntry[]) =>
    parseMemoryPackBody(renderMemoryPack(entries).body);

  it('reads a rendered pack back into one text per entry, metadata dropped', () => {
    const entries = parsed(rate, send);
    expect(entries.map((entry) => entry.id)).toEqual([rate.id, send.id]);
    expect(entries[0]?.text).toBe(`${rate.title}\n${rate.body}`);
    // The head line is identical in shape on every entry, so keeping it would hand every entry the
    // same wording and make "which entry did this come from" unanswerable.
    expect(entries[0]?.text).not.toContain('trust=');
    expect(entries[0]?.text).not.toContain('observed=');
  });

  it('cites the entry the answer quoted and not the one it did not', () => {
    expect(
      memoryPackCitations({
        entries: parsed(rate, send),
        used: [
          'The renewal rate on the brochure job is 4.25 per cent for the current term.',
          'Answered from what the workspace already remembered.'
        ],
        request: 'What rate are we renewing the brochure job at?'
      })
    ).toEqual([rate.id]);
  });

  it('cites a paraphrase, because a run of four content words is not a coincidence', () => {
    expect(
      memoryPackCitations({
        entries: parsed(rate, send),
        used: ['The brochure job renews at 4.25 per cent for the current term.'],
        request: 'What rate are we renewing the brochure job at?'
      })
    ).toEqual([rate.id]);
  });

  it('refuses to credit an entry for wording that came from the owner', () => {
    // The trap this exclusion exists for, built so that it is the exclusion doing the work and not
    // an absence of overlap: the request and the entry share the run "renewal rate brochure job"
    // verbatim, and the answer repeats it. Without the request filter that run is a distinctive
    // entry shingle present in the answer and the entry is credited - for wording it never
    // supplied. The block was retrieved *with* the request, so this overlap is the normal case
    // rather than a contrived one.
    const request = 'What is the renewal rate on the brochure job?';
    expect(
      memoryPackCitations({
        entries: parsed(rate, send),
        used: ['The renewal rate on the brochure job has not changed.'],
        request
      })
    ).toEqual([]);
    // The same call without the owner's words to subtract, which is what the filter is subtracting.
    expect(
      memoryPackCitations({
        entries: parsed(rate, send),
        used: ['The renewal rate on the brochure job has not changed.']
      })
    ).toEqual([rate.id]);
  });

  it('refuses to credit either of two entries that share the wording', () => {
    const twin: MemoryPackEntry = { ...rate, id: '33333333-0000-4000-8000-000000000003' };
    // Two rows saying the same thing is exactly what near-duplicate detection exists to stop, and
    // until it does the honest answer to "which one did the turn read" is neither.
    expect(
      memoryPackCitations({
        entries: parsed(rate, twin),
        used: ['The renewal rate on the brochure job is 4.25 per cent for the current term.'],
        request: 'nothing'
      })
    ).toEqual([]);
  });

  it('cites nothing when the turn produced nothing to attribute', () => {
    expect(memoryPackCitations({ entries: parsed(rate, send), used: [], request: 'x' })).toEqual(
      []
    );
    expect(
      memoryPackCitations({ entries: parsed(rate, send), used: ['   ', ''], request: 'x' })
    ).toEqual([]);
  });

  it('takes the entry id as a citation, which is the channel a caller can be precise on', () => {
    expect(
      memoryPackCitations({
        entries: parsed(rate, send),
        used: [`Relied on id=${send.id} for the embargo.`],
        request: 'x'
      })
    ).toEqual([send.id]);
    expect(
      memoryPackCitations({ entries: parsed(rate, send), used: ['done'], named: [rate.id] })
    ).toEqual([rate.id]);
  });

  it('ignores a named id that is not in the block, whoever named it', () => {
    // A citation list arriving from a model is untrusted input like any other: it may name a row
    // this task was never shown, and crediting that row would let a turn raise the salience of a
    // memory it never read.
    expect(
      memoryPackCitations({
        entries: parsed(rate, send),
        used: ['done'],
        named: ['99999999-0000-4000-8000-000000000009']
      })
    ).toEqual([]);
  });

  it('returns citations in pack order, so the same turn always writes the same rows', () => {
    const entries = parsed(rate, send);
    expect(memoryPackCitations({ entries, used: ['x'], named: [send.id, rate.id] })).toEqual([
      rate.id,
      send.id
    ]);
  });

  it('counts the commands the harness ran, not only the prose the owner reads', () => {
    const procedure: MemoryPackEntry = {
      id: '44444444-0000-4000-8000-000000000004',
      kind: 'procedure',
      trust: 'derived',
      observedAt: '2026-07-01T00:00:00.000Z',
      validFrom: '2026-07-01T00:00:00.000Z',
      validTo: null,
      title: 'how this workspace checks a brochure',
      tags: [],
      body: 'In /srv/brochure, `pnpm exec verify-fonts --embedded` is what settles it.'
    };
    // Nobody writes a shell command out to the owner in prose, so a procedure that was followed
    // would be graded identically to one that was ignored if only the answer were read.
    expect(
      memoryPackCitations({
        entries: parsed(procedure, send),
        used: ['Everything checks out.', 'pnpm exec verify-fonts --embedded'],
        request: 'Is the brochure ready?'
      })
    ).toEqual([procedure.id]);
  });
});
