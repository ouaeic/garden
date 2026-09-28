import { runtimeNow } from '@garden/core';
/**
 * What the model was actually shown, so a line number means something.
 *
 * A quoted edit carries its own evidence: `oldText` occurring exactly once proves the text was
 * there. A line number carries none - `PUT 41.=42` is as well-formed against a file the model has
 * never opened as against one it just read. So the harness has to keep the evidence itself, and
 * this is where it lives: the exact lines a read put in front of the model, and which numbers they
 * were shown under.
 *
 * That record does three jobs, and only the first is obvious:
 *
 *   1. It bounds the blast radius. An edit to line 400 of a file read to line 120 is a guess, and a
 *      guess that parses is the failure that costs the most, because it lands silently on the wrong
 *      lines. `apply.ts` refuses it and inlines the real text at that anchor into the refusal.
 *   2. It makes a stale anchor RECOVERABLE. When the file has changed since the read, the recorded
 *      lines say exactly what the model was aiming at, so the applier can find that text again in
 *      the live file and apply the shift, rather than reporting a mismatch the model can only
 *      answer with another read.
 *   3. It removes the need for a version tag in the format at all. The reference dialect makes the
 *      model copy a short whole-file hash into every patch, and maintains a list of models that
 *      drop it. Resolution here is by content against this record, which is better evidence than a
 *      hash - it can say where the lines went - and cannot be miscopied because it is never sent.
 *
 * TWO RECORDS, AND THEY ARE NOT THE SAME RECORD. The snapshots above carry text, so they cost what
 * the text costs and are capped at a handful per file; they answer "what did line 300 say when you
 * showed it to me". Coverage carries line numbers only, merged into runs, so it costs nothing to
 * keep all of it; it answers "have you been shown every line of this file". Keeping one structure
 * for both is what made a file read END TO END in twenty windows unwritable: only the last four
 * windows survived the snapshot cap, so the coverage question - answered off those four - said no,
 * and the refusal named a recovery the model had just performed twenty times. Coverage is a
 * question about a set of intervals and is now answered by one.
 *
 * BOUNDS, because this box runs for months. Per-process, per-task, LRU on both axes, and every
 * bound is a memory bound rather than a correctness one: losing a record loses an opinion, never a
 * write. A lost record makes the next edit a refusal that hands over the file's current text, which
 * is a wasted round trip; a record that outlived its truth would vouch for text nobody has seen.
 * The runner carries an independent guard of its own on the write itself
 * (`services/workspace-runner/src/seen-lines.ts`), so this cache being cold is never the only thing
 * standing between a blind anchor and the disk.
 */
import { sameLines, toLines } from './format.js';

/** One read, as the model saw it. */
export interface Snapshot {
  readonly path: string;
  /** One-based line number of `lines[0]` in the file as it was read. */
  readonly startLine: number;
  /** The lines displayed, whole. A line a read cut in half on its byte budget is not here. */
  readonly lines: readonly string[];
  /** Monotonic within the process; only ever compared, never read as a time. */
  readonly at: number;
}

/** A closed, 1-indexed run of lines. `start` and `end` are both lines that exist. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/**
 * One span a write replaced, and what took its place. Both ends 1-indexed and inclusive.
 *
 * `oldTo === oldFrom - 1` removes nothing - a pure insertion before `oldFrom`. `newTo === newFrom -
 * 1` inserts nothing - a pure deletion. `applyEdit` reports these because it knows exactly what it
 * spliced; the runner's guard recovers the same shape by diffing, because nobody tells it.
 */
export interface LineChange {
  readonly oldFrom: number;
  readonly oldTo: number;
  readonly newFrom: number;
  readonly newTo: number;
}

/** A range and when it was recorded, which is the only thing the per-file caps can rank on. */
interface Marked {
  start: number;
  end: number;
  at: number;
}

/**
 * How many versions of one file are remembered per task.
 *
 * A turn that reads, edits, reads and edits again generates a snapshot per read, and only the ones
 * a still-in-flight edit could name matter. Four is two round trips of headroom; beyond that the
 * anchor is old enough that refusing with the file's current text is the right answer anyway.
 *
 * It is a bound on TEXT HELD IN MEMORY, which is why it is small, and it is no longer also the
 * bound on how much of a file may count as read - see the coverage record below.
 */
export const SNAPSHOTS_PER_PATH = 4;

/**
 * How many separate runs of seen lines one file may accumulate.
 *
 * Two numbers per run, so this is cheap where a snapshot is not, and reads that continue one
 * another merge into a single run - a file paged through from the top holds exactly one entry
 * however many windows it took. The cap only binds on reads that leave gaps between them, and what
 * it drops is the run FURTHEST FROM THE START of the file, never the earliest: every question asked
 * of this record is "has line 1 to N been shown", and the answer is computed from the front, so
 * dropping from the front would make reading the file again fail to lift the refusal. Dropping from
 * the far end costs at worst a re-read of a region past the first gap, which is exactly what the
 * refusal asks for.
 */
const MAX_COVERED_RUNS = 128;

/**
 * Files remembered across all live tasks, and how long a record may vouch for a read.
 *
 * The path cap is a working set, not a history. The horizon exists so a task that is abandoned
 * mid-turn does not hold its reads for the life of the worker process; it is generous because it is
 * not what makes a record safe - comparing the recorded lines against the live file is.
 */
const MAX_TRACKED_FILES = 512;
export const SNAPSHOT_HORIZON_MS = 60 * 60_000;

interface Entry {
  snapshots: Snapshot[];
  /** Every line of this file the task has been shown, merged, ascending. */
  covered: Marked[];
  recordedAt: number;
}

const displayed = new Map<string, Entry>();
let sequence = 0;

const keyOf = (taskId: string, path: string): string => `${taskId} ${path}`;

const evict = (now: number): void => {
  for (const [key, entry] of displayed)
    if (now - entry.recordedAt > SNAPSHOT_HORIZON_MS) displayed.delete(key);
  // Insertion order is recency order: recording a file deletes and re-sets its key.
  while (displayed.size > MAX_TRACKED_FILES) {
    const oldest = displayed.keys().next();
    if (oldest.done) break;
    displayed.delete(oldest.value);
  }
};

/** Adjacent runs merge: lines 1-50 and 51-60 are one run of seen lines, not two. */
const merge = (ranges: readonly Marked[]): Marked[] => {
  const merged: Marked[] = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
      last.at = Math.max(last.at, range.at);
    } else merged.push({ ...range });
  }
  return merged;
};

/** The runs nearest the start of the file, which is where every coverage question is answered. */
const capCovered = (ranges: Marked[]): Marked[] =>
  ranges.length <= MAX_COVERED_RUNS ? ranges : ranges.slice(0, MAX_COVERED_RUNS);

const live = (key: string, now: number): Entry | undefined => {
  const entry = displayed.get(key);
  if (!entry) return undefined;
  if (now - entry.recordedAt > SNAPSHOT_HORIZON_MS) {
    displayed.delete(key);
    return undefined;
  }
  return entry;
};

/**
 * Notes that these lines of this file were put in front of the model under these numbers.
 *
 * `startLine` is the number the first line was shown as, so a windowed read records the window and
 * nothing else. A read that was cut short by its byte budget must pass only the lines that arrived
 * whole - counting the half-line would vouch for the half that never got there.
 */
export const recordRead = (
  taskId: string,
  path: string,
  startLine: number,
  text: string,
  now = runtimeNow()
): void => {
  if (startLine < 1) return;
  const lines = toLines(text);
  if (!lines.length) return;
  const key = keyOf(taskId, path);
  const existing = live(key, now);
  sequence += 1;
  const fresh: Snapshot = { path, startLine, lines, at: sequence };
  // A re-read that shows exactly the same window of exactly the same text is the same snapshot, not
  // a second one; keeping both would spend the per-path budget on duplicates and push out the older
  // version an in-flight edit is actually addressed against.
  const kept = (existing?.snapshots ?? []).filter(
    (snapshot) => !(snapshot.startLine === startLine && sameLines(snapshot.lines, lines))
  );
  displayed.delete(key);
  displayed.set(key, {
    recordedAt: now,
    snapshots: [...kept, fresh].slice(-SNAPSHOTS_PER_PATH),
    covered: capCovered(
      merge([
        ...(existing?.covered ?? []),
        { start: startLine, end: startLine + lines.length - 1, at: sequence }
      ])
    )
  });
  evict(now);
};

/** Every remembered read of this file, newest last. Empty means no opinion, never "nothing seen". */
export const readsOf = (taskId: string, path: string, now = runtimeNow()): readonly Snapshot[] =>
  live(keyOf(taskId, path), now)?.snapshots ?? [];

/**
 * Every line of this file the task has been shown, merged and ascending.
 *
 * Empty means no opinion for the same reason `readsOf` empty does: nothing was recorded, or the
 * record expired. It is never "nothing has been seen" - a caller with no opinion behaves exactly as
 * it did before this module existed.
 */
export const displayedRanges = (
  taskId: string,
  path: string,
  now = runtimeNow()
): readonly LineRange[] =>
  (live(keyOf(taskId, path), now)?.covered ?? []).map(({ start, end }) => ({ start, end }));

/**
 * The first line at or before `through` that these runs do not cover, or `undefined` when they
 * cover all of it.
 *
 * A number rather than a yes-or-no because it is what the refusal has to say. "You have not been
 * shown all of them" leaves the model to guess where to start; "read from line 201" is a recovery
 * it can perform once and be done with.
 */
export const firstUnshownLine = (
  covered: readonly LineRange[],
  through: number
): number | undefined => {
  let reached = 0;
  for (const range of [...covered].sort((left, right) => left.start - right.start)) {
    if (range.start > reached + 1) break;
    reached = Math.max(reached, range.end);
    if (reached >= through) return undefined;
  }
  return reached >= through ? undefined : reached + 1;
};

/**
 * Carries the record across a write this vertical just made, and adds what the write authored.
 *
 * Without it the format is one edit deep per file: the model reads, edits, and the second edit in
 * the same turn addresses numbers from a file that has since moved under it. So every stretch the
 * write left alone keeps its lines, at the numbers the changes before it shifted them to, and every
 * span the write authored is recorded as shown - it is text the model wrote.
 *
 * `changed` IS THE SPANS AND NOT THE FILE, and the difference is the whole of this function. It
 * re-recorded the entire new text on the argument that "text a caller authored is text it has been
 * shown by definition" - true of a caller that supplied every line, and false of a line-addressed
 * patch, which authors a span and reproduces the rest from a file it may have seen two hundred
 * lines of. Measured on the shipped arm: a windowed read of lines 1-200 followed by one `PUT 10:`
 * left all 8,332 lines of the file recorded as shown, so `PUT 8000:` - refused by name without the
 * patch in front of it - landed silently, and a whole-file write destroying 576,512 bytes was
 * accepted. Omitting `changed` still means the whole text: that is a caller that supplied all of
 * it, which is what `file_write` and the eval arms do.
 */
export const recordWrite = (
  taskId: string,
  path: string,
  text: string,
  changed?: readonly LineChange[],
  now = runtimeNow()
): void => {
  const key = keyOf(taskId, path);
  const lines = toLines(text);
  const existing = live(key, now);
  const marked: Marked[] = [];
  if (!changed) {
    sequence += 1;
    marked.push({ start: 1, end: lines.length, at: sequence });
  } else {
    const previous = existing?.covered ?? [];
    let cursor = 1;
    let shift = 0;
    /** The seen lines inside one untouched stretch of the old file, at their new numbers. */
    const carry = (from: number, to: number, by: number): void => {
      for (const range of previous) {
        const start = Math.max(range.start, from);
        const end = Math.min(range.end, to);
        if (end >= start) marked.push({ start: start + by, end: end + by, at: range.at });
      }
    };
    for (const change of changed) {
      if (change.oldFrom - 1 >= cursor) carry(cursor, change.oldFrom - 1, shift);
      if (change.newTo >= change.newFrom) {
        sequence += 1;
        marked.push({ start: change.newFrom, end: change.newTo, at: sequence });
      }
      shift += change.newTo - change.newFrom - (change.oldTo - change.oldFrom);
      cursor = change.oldTo + 1;
    }
    carry(cursor, Number.MAX_SAFE_INTEGER, shift);
  }
  const covered = merge(
    marked
      .map((range) => ({
        start: Math.max(1, range.start),
        end: Math.min(lines.length, range.end),
        at: range.at
      }))
      .filter((range) => range.end >= range.start)
  );
  displayed.delete(key);
  displayed.set(key, {
    recordedAt: now,
    // The text of every run comes out of what was just written, which is what the file says now -
    // for a carried run because the write left it alone, and for an authored one because the write
    // is where it came from.
    snapshots: [...covered]
      .sort((left, right) => left.at - right.at)
      .slice(-SNAPSHOTS_PER_PATH)
      .map((range) => ({
        path,
        startLine: range.start,
        lines: lines.slice(range.start - 1, range.end),
        at: range.at
      })),
    covered: capCovered(covered)
  });
  evict(now);
};

/** A file is gone; its numbers mean nothing now. */
export const forgetPath = (taskId: string, path: string): void => {
  displayed.delete(keyOf(taskId, path));
};

/** Drops every record. Only a test that wants a cold store has any business calling it. */
export const forgetReads = (): void => displayed.clear();
