import { runtimeNow } from '@garden/core';
/**
 * The bound on a patch sent again byte for byte after it was refused.
 *
 * Watched on the box: a turn wrote the same register misuse four times in a row and was told the
 * same thing four times, until the turn's repeated-failure bound stopped it. The refusal was right
 * every time and it was the wrong sentence by the second: a model that has just read the reason
 * and sent the identical bytes back has not understood the reason, and restating it is what a
 * loop looks like from the inside. The field's record is the same across every harness that
 * measures itself - the identical failing call retried with no diagnosis is the commonest shape
 * of an editing spiral, and every survivor bounds it with a per-file counter.
 *
 * So the second identical patch gets a DIFFERENT message, and the difference is that it names the
 * one change that fixes it and nothing else. `apply.ts` computes that change beside every refusal
 * (`fix`), because the applier is the one thing that knows what would have landed. For a short
 * file the model has seen all of, the message also names the way out that needs no dialect at
 * all: write the whole file with `file_write`. It is offered only there, because a whole-file
 * write of a file the model has not been shown all of is the write the ledger refuses by name.
 *
 * Bounded the way `snapshots.ts` is bounded: per task and path, a working set and a horizon, and
 * cleared the moment a patch to that file lands. Losing a record here loses a better sentence,
 * never a write.
 */
import { createHash } from 'node:crypto';
import { type EditRefusal } from './apply.js';

/**
 * Below this many lines, a refused-twice patch is told that `file_write` is the way out.
 *
 * Sixty lines is a file a model can retype from what it has been shown without the whole-file
 * write costing more than the two refused patches already did. Above it, retyping the file is the
 * expensive thing this whole format exists to avoid, and the message stays with the fix.
 */
export const WHOLE_FILE_FALLBACK_LINES = 60;

const MAX_REMEMBERED = 512;
const HORIZON_MS = 60 * 60_000;

interface Remembered {
  readonly digest: string;
  readonly kind: string;
  readonly at: number;
}

const remembered = new Map<string, Remembered>();

const keyOf = (taskId: string, path: string): string => `${taskId} ${path}`;

const digestOf = (edit: string): string => createHash('sha256').update(edit).digest('hex');

const evict = (now: number): void => {
  for (const [key, entry] of remembered) if (now - entry.at > HORIZON_MS) remembered.delete(key);
  while (remembered.size > MAX_REMEMBERED) {
    const oldest = remembered.keys().next();
    if (oldest.done) break;
    remembered.delete(oldest.value);
  }
};

/** The numbered rows a refusal quoted, so the bounded message can carry the same file text. */
const quotedRows = (message: string): string =>
  message
    .split('\n')
    .filter((row) => /^\s*\d+:/.test(row))
    .join('\n');

/**
 * The refusal to hand back for this patch, which is the applier's own unless the identical bytes
 * were refused for the same reason a moment ago.
 *
 * `fullyShown` is whether every line of the file has been displayed to the model, which is what
 * decides whether `file_write` can be offered; `lines` is the file as it reads now.
 */
export const boundRepeatedRefusal = (
  taskId: string,
  path: string,
  edit: string,
  refusal: EditRefusal,
  lines: readonly string[],
  fullyShown: boolean,
  now = runtimeNow()
): EditRefusal => {
  const key = keyOf(taskId, path);
  const digest = digestOf(edit);
  const previous = remembered.get(key);
  remembered.delete(key);
  remembered.set(key, { digest, kind: refusal.kind, at: now });
  evict(now);
  if (!previous || previous.digest !== digest || previous.kind !== refusal.kind) return refusal;

  const wayOut =
    fullyShown && lines.length < WHOLE_FILE_FALLBACK_LINES
      ? ` Or send the whole ${lines.length}-line file with file_write.`
      : '';
  const rows = quotedRows(refusal.message);
  const message = `This is byte-for-byte the patch just refused, and it fails for the same reason. Do not resend it. The one change that fixes it: ${refusal.fix}.${wayOut}\n\n${rows || refusal.message}`;
  return { ...refusal, message };
};

/** A patch to this file landed; whatever was refused before it is no longer the last word. */
export const forgetRefusal = (taskId: string, path: string): void => {
  remembered.delete(keyOf(taskId, path));
};

/** Drops every record. Only a test or a rig that wants a cold store has any business calling it. */
export const forgetRefusals = (): void => remembered.clear();
