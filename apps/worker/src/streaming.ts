import { runtimeNow } from '@garden/core';
/**
 * Turning a model's output into something the timeline can show and the window can hold.
 *
 * Two different bounds meet here. A reply is flushed to the timeline on an interval rather than per
 * token, because the owner is reading it and a write per token is a write per frame; reasoning is
 * flushed on a slower one, because it is not the answer. And a tool result is bounded before it
 * ever reaches the window, because the model asked for a file and the file has no size limit.
 *
 * The assistant-text normalisation is here for the same reason as the flushers: it is the last
 * thing that touches text on its way out of the provider, and the control tokens it strips are an
 * artefact of the transport rather than anything the model meant to say.
 */

/**
 * How often a streaming reply is written to the timeline, and the smallest frame worth a row.
 *
 * Time is the right axis: a frame at a steady cadence reads as continuous text at any token rate,
 * whereas a character threshold writes more rows the faster the route is. The character floor stops
 * a route that trickles a few characters a second from writing an almost empty row on every tick;
 * the closing drain ignores it, so no text is ever left unshown.
 *
 * Both were set when a frame had to survive a one-second reader poll on the way to the client and
 * had to be worth the round trip. Delivery is event-driven now and the client concatenates
 * fragments, so the only thing the old 400 ms / 24-character floor bought was fewer rows - at the
 * cost of the reply arriving in visible steps. At this cadence it reads as prose being written.
 */
export const STREAM_FLUSH_INTERVAL_MS = 120;
const STREAM_FLUSH_MIN_CHARS = 8;

/**
 * The thinking flushes slower than the answer, because it is not read the same way.
 *
 * The answer is watched word by word; the thinking is a fold-away block read as texture, and a
 * frame of it is worth exactly as much at three a second as at eight. Every frame is its own
 * encrypted, row-locked, NOTIFY-ing write, so the cadence that makes prose read well is pure cost
 * here - a forty-second think spent it a few hundred times over.
 */
export const REASONING_FLUSH_INTERVAL_MS = 500;

/**
 * The longest silence the channel accepts before it puts something on the screen again.
 *
 * A tool step that runs long and a reasoning pass between flushes both leave the "Now" line
 * showing whatever last landed; nothing in the flush path knows the turn is still alive, so
 * the owner reads a frozen line as a dead one. A re-assert at this interval keeps the line
 * moving without writing anything new to the transcript.
 */
export const STALL_HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Batches streamed text into timed frames, each carrying only what arrived since the last one.
 *
 * Every frame becomes its own encrypted, row-locked timeline event, so what a frame contains is a
 * storage decision, not a display one. Repeating the whole reply so far in each frame - as this
 * did - makes the bytes written quadratic in reply length: a 64,000-character answer wrote 12.77 MB
 * across 400 rows, all of which is then replayed to the client. An increment is linear, and the
 * client reassembles the same text by concatenation.
 */
export const createStreamFlusher = (
  intervalMs = STREAM_FLUSH_INTERVAL_MS,
  now: () => number = () => runtimeNow()
): { push: (delta: string) => string | null; drain: () => string | null } => {
  let pending = '';
  let lastFlush: number | null = null;
  const take = (): string => {
    const frame = pending;
    pending = '';
    return frame;
  };
  return {
    push: (delta: string): string | null => {
      pending += delta;
      if (!pending) return null;
      const at = now();
      // The first frame goes out immediately, so the reply starts appearing as soon as it starts.
      if (lastFlush === null) {
        lastFlush = at;
        return take();
      }
      if (at - lastFlush < intervalMs || pending.length < STREAM_FLUSH_MIN_CHARS) return null;
      lastFlush = at;
      return take();
    },
    drain: (): string | null => (pending ? take() : null)
  };
};

/**
 * Image bytes reach the model as an attached data URL, so the serialised tool result carries only
 * metadata; repeating the base64 here would burn most of the context window.
 */
const withoutScreenshotBytes = (result: unknown): unknown => {
  if (Array.isArray(result)) return result.map(withoutScreenshotBytes);
  if (!result || typeof result !== 'object') return result;
  return Object.fromEntries(
    Object.entries(result).map(([key, value]) => [
      key,
      key === 'screenshotBase64'
        ? '[screenshot available in timeline]'
        : withoutScreenshotBytes(value)
    ])
  );
};

export const boundedToolResultForModel = (
  toolName: string,
  result: unknown,
  imageSummary?: { mimeType: string; bytes: number; path: string; convertedFrom?: string }
): unknown => {
  if (imageSummary)
    return { ...imageSummary, image: '[attached to this conversation for inspection]' };
  if (
    ['browser_snapshot', 'desktop_observe', 'browser_action', 'desktop_action'].includes(toolName)
  )
    return withoutScreenshotBytes(result);
  return result;
};

/**
 * The control tokens a model marks its own turns with, which are not words it said.
 *
 * They surface when a completion is continued after being cut off at the output limit: the model
 * starts the next piece the way it starts any turn, and that opener is decoded as ordinary text.
 * Seen in the owner's own transcript - a correct, cited answer about the front page of a news site
 * that began `<｜begin▁of▁sentence｜>`, four times over. Matched with both the ASCII bar and the
 * fullwidth one, and bounded to short token-shaped runs so that a pipe inside real prose or a code
 * block is left alone.
 */
const MODEL_CONTROL_TOKEN = /<[|｜][a-zA-Z0-9_▁\-. ]{0,40}[|｜]>/g;

/**
 * A model that has stopped writing and started looping, caught while it is still doing it.
 *
 * Twice in one evening a cheap model answered correctly and then repeated a single sentence until
 * the provider's own 900-second ceiling stopped it - "The user is not watching the screen right
 * now.", seventeen thousand output tokens of it, a quarter of an hour, and a run the owner was
 * shown as a failure. There was nothing watching for it: the counters in this file bound how often
 * a turn may be refused, never whether it is still saying anything new.
 *
 * The tail is examined rather than the whole answer, and only the last chunk of it: find where the
 * final forty characters last occurred, take the gap as the period, and count how many times that
 * unit tiles the end. Five consecutive repeats of at least fifteen characters is the bar. Prose,
 * code and tables do not do that - a table's rows differ, a loop's body differs - and a shorter
 * unit is left alone because "ha ha ha ha ha" is a thing people write.
 */
export const degenerateRepeat = (text: string): string => {
  const tail = text.slice(-4_000);
  const probeLength = 40;
  if (tail.length < probeLength * 2) return '';
  const probe = tail.slice(-probeLength);
  const previous = tail.lastIndexOf(probe, tail.length - probeLength - 1);
  if (previous < 0) return '';
  const period = tail.length - probeLength - previous;
  if (period < 15) return '';
  const unit = tail.slice(tail.length - period);
  let repeats = 1;
  while (repeats < 12 && tail.endsWith(unit.repeat(repeats + 1))) repeats += 1;
  return repeats >= 5 ? unit.trim() : '';
};

export const normalizeAssistantText = (value: string): string => {
  const normalized = value
    .replace(MODEL_CONTROL_TOKEN, '')
    .trim()
    .replace(/^into chat\s*/i, '')
    .trim();
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length &&
    lines.every((line) => /^\d+\.\s*\[(pending|in_progress|completed|skipped)\]\s+/i.test(line))
    ? ''
    : normalized;
};
