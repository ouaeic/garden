/**
 * The files and the edits, chosen so the answer is not decided by the sample.
 *
 * A corpus that only contains the case a format is good at proves nothing, so this one is built
 * from the shapes an editing turn actually contains, including the two shapes where the shipped
 * `file_patch` should win outright: a short unique edit, where quoting three lines is cheaper than
 * a header and a tag, and a rename, which `file_patch` cannot express at all and garden does with
 * a shell `mv` that costs almost nothing.
 *
 * An edit is declared once, as a change to lines, and each format's encoding is DERIVED from it by
 * `encode.ts`. Nothing here is written in either dialect. That matters more than any other decision
 * in this directory: a corpus where the author hand-writes both sides is a corpus where the author
 * decides the winner, and every previous argument about garden's weight has been settled that way.
 *
 * The files are invented but they are not toys - the repetition in `queue.ts` and the duplicated
 * stanzas in `services.yml` are the exact structures that make a uniqueness-guarded search cost
 * what it costs, and a corpus of files without them would report a saving of nearly zero and be
 * wrong about every real repository.
 */

export interface CorpusFile {
  readonly path: string;
  readonly text: string;
}

/** What the model wants to happen, in terms of the numbering of the read it just did. */
export type Change =
  | {
      readonly kind: 'replace';
      readonly from: number;
      readonly to: number;
      readonly lines: string[];
    }
  | { readonly kind: 'block'; readonly at: number; readonly lines: string[] }
  | {
      readonly kind: 'insert';
      readonly at: number;
      readonly side: 'before' | 'after';
      readonly lines: string[];
    }
  | {
      readonly kind: 'move';
      readonly from: number;
      readonly to: number;
      /** Paste after this ORIGINAL line number; 0 means the top of the file. */
      readonly after: number;
    }
  | { readonly kind: 'rename'; readonly to: string };

export interface EditTask {
  readonly id: string;
  /** One line, printed above the row, so a number can be read without opening this file. */
  readonly what: string;
  readonly path: string;
  readonly changes: readonly Change[];
  /** The window the model was shown. Absent means the whole file. */
  readonly read?: { readonly startLine: number; readonly endLine: number };
  /** What happened to the file between the read and the edit, if anything. */
  readonly drift?: (text: string) => string;
  /**
   * `land` - a correct model gets this edit applied.
   * `refuse` - the harness must refuse it; landing is the defect.
   */
  readonly outcome: 'land' | 'refuse';
  /** Set where the change is deliberately addressed at lines outside `read`. */
  readonly note?: string;
}

const QUEUE = `import type { Job, Payload } from './types.js';
import { logger } from '../log.js';

/** Pulls the next ready job off the queue, or nothing if there is not one. */
export const drain = (queue: Job[]): Payload | null => {
  const job = queue.shift();
  if (!job) {
    return null;
  }
  if (!job.ready) {
    return null;
  }
  if (job.expiresAt < Date.now()) {
    logger.warn('job expired', { id: job.id });
    return null;
  }
  return job.payload;
};

/** The next job without taking it, or nothing if the queue is empty. */
export const peek = (queue: Job[]): Payload | null => {
  const job = queue[0];
  if (!job) {
    return null;
  }
  if (!job.ready) {
    return null;
  }
  return job.payload;
};

/** Every job that will never run, so a caller can report them and drop them. */
export const expired = (queue: Job[], now: number): Job[] => {
  const found: Job[] = [];
  for (const job of queue) {
    if (job.expiresAt < now) {
      found.push(job);
    }
  }
  return found;
};

/** How many jobs are ready right now. */
export const readyCount = (queue: Job[]): number => {
  let count = 0;
  for (const job of queue) {
    if (!job.ready) {
      continue;
    }
    if (job.expiresAt < Date.now()) {
      continue;
    }
    count += 1;
  }
  return count;
};
`;

const SERVICES = `version: '3.9'

services:
  api:
    image: garden/api:latest
    restart: unless-stopped
    environment:
      - NODE_ENV=production
      - LOG_LEVEL=info
    healthcheck:
      test: ['CMD', 'curl', '-fsS', 'http://localhost:8080/health']
      interval: 30s
      timeout: 5s
      retries: 3
  worker:
    image: garden/worker:latest
    restart: unless-stopped
    environment:
      - NODE_ENV=production
      - LOG_LEVEL=info
    healthcheck:
      test: ['CMD', 'curl', '-fsS', 'http://localhost:8080/health']
      interval: 30s
      timeout: 5s
      retries: 3
  runner:
    image: garden/runner:latest
    restart: unless-stopped
    environment:
      - NODE_ENV=production
      - LOG_LEVEL=info
    healthcheck:
      test: ['CMD', 'curl', '-fsS', 'http://localhost:8080/health']
      interval: 30s
      timeout: 5s
      retries: 3
`;

const REPORT = `"""Turn the ledger into the weekly figures somebody actually reads."""

from decimal import Decimal


def totals(rows):
    """Sum every row by currency, ignoring anything not yet settled."""
    out = {}
    for row in rows:
        if row.status != "settled":
            continue
        if row.currency not in out:
            out[row.currency] = Decimal(0)
        out[row.currency] += row.amount
    return out


def by_month(rows):
    """Group settled rows by the month they landed in."""
    out = {}
    for row in rows:
        if row.status != "settled":
            continue
        key = row.settled_at.strftime("%Y-%m")
        out.setdefault(key, []).append(row)
    return out


def render(rows):
    """The whole report, as plain text."""
    lines = []
    for currency, amount in sorted(totals(rows).items()):
        lines.append(f"{currency} {amount:.2f}")
    return "\\n".join(lines)
`;

export const FILES: readonly CorpusFile[] = [
  { path: 'src/queue.ts', text: QUEUE },
  { path: 'infra/services.yml', text: SERVICES },
  { path: 'src/report.py', text: REPORT }
];

export const fileText = (path: string): string => {
  const found = FILES.find((file) => file.path === path);
  if (!found) throw new Error(`no corpus file ${path}`);
  return found.text;
};

export const TASKS: readonly EditTask[] = [
  {
    id: 'one-line-repetitive',
    what: 'one line changed inside a function whose file says `return null;` six times',
    path: 'src/queue.ts',
    changes: [
      {
        kind: 'replace',
        from: 14,
        to: 14,
        lines: ["    logger.error('job expired', { id: job.id, at: job.expiresAt });"]
      }
    ],
    outcome: 'land'
  },
  {
    id: 'repeated-statement',
    what: 'one of six identical `return null;` lines changed, in the middle of a function',
    path: 'src/queue.ts',
    changes: [{ kind: 'replace', from: 11, to: 11, lines: ['    return undefined;'] }],
    outcome: 'land'
  },
  {
    id: 'repeated-guard',
    what: 'a two-line guard changed in the first of two byte-identical loops',
    path: 'src/report.py',
    changes: [
      {
        kind: 'replace',
        from: 10,
        to: 11,
        lines: ['        if row.status != "settled" or row.amount == 0:', '            continue']
      }
    ],
    outcome: 'land'
  },
  {
    id: 'deep-stanza',
    what: 'a field changed deep inside the second of three byte-identical stanzas',
    path: 'infra/services.yml',
    changes: [{ kind: 'replace', from: 20, to: 20, lines: ['      - LOG_LEVEL=debug'] }],
    outcome: 'land'
  },
  {
    id: 'one-line-unique',
    what: 'one line changed where the surrounding text is already unique - the incumbent’s best case',
    path: 'src/queue.ts',
    changes: [
      {
        kind: 'replace',
        from: 1,
        to: 1,
        lines: ["import type { Job, Payload } from './queue-types.js';"]
      }
    ],
    outcome: 'land'
  },
  {
    id: 'block-replace',
    what: 'a whole function body replaced by a shorter one',
    path: 'src/queue.ts',
    changes: [
      {
        kind: 'block',
        at: 21,
        lines: [
          'export const peek = (queue: Job[]): Payload | null =>',
          '  queue[0]?.ready ? queue[0].payload : null;'
        ]
      }
    ],
    outcome: 'land'
  },
  {
    id: 'insert-at-gap',
    what: 'a new import added at the top, touching nothing',
    path: 'src/queue.ts',
    changes: [
      { kind: 'insert', at: 2, side: 'after', lines: ["import { metrics } from '../metrics.js';"] }
    ],
    outcome: 'land'
  },
  {
    id: 'three-hunks',
    what: 'three small edits to one file in one call - the ordinary bulk of an editing turn',
    path: 'src/queue.ts',
    changes: [
      {
        kind: 'replace',
        from: 5,
        to: 5,
        lines: ['export const drain = (queue: Job[]): Payload | undefined => {']
      },
      {
        kind: 'replace',
        from: 21,
        to: 21,
        lines: ['export const peek = (queue: Job[]): Payload | undefined => {']
      },
      {
        kind: 'replace',
        from: 44,
        to: 44,
        lines: ['export const readyCount = (queue: Job[], now = Date.now()): number => {']
      }
    ],
    outcome: 'land'
  },
  {
    id: 'move-function',
    what: 'an eleven-line function moved above the one it is used by',
    path: 'src/queue.ts',
    changes: [{ kind: 'move', from: 31, to: 41, after: 2 }],
    outcome: 'land'
  },
  {
    id: 'rename-file',
    what: 'a file renamed - the incumbent cannot express this and reaches for the shell',
    path: 'src/queue.ts',
    changes: [{ kind: 'rename', to: 'src/jobs.ts' }],
    outcome: 'land'
  },
  {
    id: 'python-block',
    what: 'an indentation-delimited function replaced, with no braces to count',
    path: 'src/report.py',
    changes: [
      {
        kind: 'block',
        at: 18,
        lines: [
          'def by_month(rows):',
          '    """Group settled rows by the month they landed in."""',
          '    out = {}',
          '    for row in rows:',
          '        if row.status == "settled":',
          '            out.setdefault(row.settled_at.strftime("%Y-%m"), []).append(row)',
          '    return out'
        ]
      }
    ],
    outcome: 'land'
  },
  {
    id: 'duplicated-stanza',
    what: 'one field changed in the second of three byte-identical stanzas',
    path: 'infra/services.yml',
    changes: [{ kind: 'replace', from: 25, to: 25, lines: ['      retries: 5'] }],
    outcome: 'land'
  },
  {
    id: 'stale-anchor',
    what: 'the file grew by two lines between the read and the edit',
    path: 'src/queue.ts',
    changes: [
      {
        kind: 'replace',
        from: 14,
        to: 14,
        lines: ["    logger.error('job expired', { id: job.id });"]
      }
    ],
    drift: (text) => `// added by another task\n// while this one was thinking\n${text}`,
    outcome: 'land'
  },
  {
    id: 'stale-target-rewritten',
    what: 'the exact lines being edited were rewritten by somebody else first',
    path: 'src/queue.ts',
    changes: [{ kind: 'replace', from: 14, to: 14, lines: ["    logger.error('job expired');"] }],
    drift: (text) =>
      text.replace("    logger.warn('job expired', { id: job.id });", '    metrics.expired(job);'),
    outcome: 'refuse',
    note: 'both formats must refuse; landing here overwrites somebody else’s change'
  },
  {
    id: 'unseen-line',
    what: 'an edit to a line outside the window the model was shown',
    path: 'src/queue.ts',
    changes: [{ kind: 'replace', from: 47, to: 49, lines: ['    if (!job.ready) continue;'] }],
    read: { startLine: 1, endLine: 20 },
    outcome: 'refuse',
    note: 'the model is addressing lines it never read'
  }
];
