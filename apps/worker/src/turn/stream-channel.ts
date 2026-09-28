import {
  runtimeClearTimer,
  runtimeNow,
  runtimeSetInterval,
  runtimeSetTimeout,
  runtimeUUID
} from '@garden/core';
/** Stream writes stay ordered and stop when the worker loses ownership. */

import type { DataStore, TaskRecord } from '@garden/data';
import type { AgentState } from '../agent-state.js';
import {
  REASONING_FLUSH_INTERVAL_MS,
  STALL_HEARTBEAT_INTERVAL_MS,
  STREAM_FLUSH_INTERVAL_MS,
  createStreamFlusher
} from '../streaming.js';
import { event } from '../tool-recording.js';

/** What writing frames needs from the worker that owns the turn. */
export interface StreamChannelDeps {
  readonly store: DataStore;
  /**
   * Injected so a test can run the stall heartbeat without waiting on the wall clock; the
   * production caller takes both defaults.
   */
  readonly stallIntervalMs?: number;
  readonly now?: () => number;
}

/** The three channels, plus the two things the loop does with them once the response lands. */
export interface StreamChannel {
  /** The answer's flusher; the loop drains it when the generation ends, however it ended. */
  readonly streamFlusher: ReturnType<typeof createStreamFlusher>;
  /** The thinking's flusher, separate because the two arrive interleaved. */
  readonly reasoningFlusher: ReturnType<typeof createStreamFlusher>;
  readonly emitStreamFrame: (frame: string) => void;
  readonly emitReasoningFrame: (frame: string) => void;
  readonly emitWholeReasoning: (markdown: string) => void;
  /** Says once per turn that frames were lost, if any were. */
  readonly noteDroppedFrames: () => Promise<void>;
  /** The write chain as it stands, for the loop to await before it bills or moves on. */
  readonly settle: () => Promise<void>;
  /** Stops the stall heartbeat; awaited inside `settle`, so the loop already runs it. */
  readonly close: () => void;
}

export const createStreamChannel = (
  deps: StreamChannelDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  /**
   * Whether this run still owns the trajectory it is writing on. Asked at the door of every write
   * and again inside the queue: the frames are written one at a time behind an awaited chain, so a
   * halt that lands while three are queued would otherwise still write all three.
   */
  disowned: () => boolean
): StreamChannel => {
  const stallIntervalMs = deps.stallIntervalMs ?? STALL_HEARTBEAT_INTERVAL_MS;
  const now = deps.now ?? (() => runtimeNow());
  const streamFlusher = createStreamFlusher(STREAM_FLUSH_INTERVAL_MS, now);
  const streamId = runtimeUUID();
  let streamEvents = Promise.resolve();
  /*
   * One lost frame is not a lost turn.
   *
   * `await streamEvents` sits above the billing block, so a single failed insert among several
   * hundred delta rows - pglite under contention, a Postgres failover - used to reject there
   * and kill a turn the owner had already watched succeed on screen, taking the ledger row for
   * a model call the provider had already charged for with it. The frames are the least
   * durable thing in this file by design: they are superseded by the assistant message that
   * closes the turn, so losing one costs a fragment of a paragraph that is about to be written
   * again in full. The reasoning channel beside this has been swallowing its own failures for
   * exactly this reason; the answer channel was the one that did not.
   *
   * It is not silent. `droppedFrames` is counted and said once per turn, because a frame
   * channel that has started failing is worth knowing about even though it is not worth
   * failing for.
   */
  let droppedFrames = 0;
  const noteDroppedFrames = async (): Promise<void> => {
    if (!droppedFrames || state.frameLossNoted) return;
    state.frameLossNoted = true;
    await event(
      deps.store,
      task,
      key,
      'warning',
      'Some of the reply arrived on screen but could not be written to the transcript',
      { count: droppedFrames }
    ).catch(() => undefined);
  };
  const emitStreamFrame = (frame: string, heartbeat = false): void => {
    if (disowned()) return;
    hasFrame = true;
    streamEvents = streamEvents.then(async () => {
      // Checked again inside the queue as well as at the door: the frames are written one at a
      // time behind an awaited chain, so a halt that lands while three are queued would
      // otherwise still write all three.
      if (disowned()) return;
      const write = () =>
        event(deps.store, task, key, 'assistant_delta', 'Agent response', {
          markdown: frame,
          append: true,
          streamId,
          ...(heartbeat ? { heartbeat: true } : {})
        });
      /*
       * A failed frame is retried once on the next tick before it is counted lost, because the
       * failure this chain swallows is a transient one - the store under contention, a reconnect
       * in flight - and the frame is the line the owner is watching. Retrying inline would leave
       * the error unhandled past this `catch`, so the retry waits a tick and goes through the
       * same counter: only a frame that fails twice is ever said to be dropped.
       */
      touched();
      await write().catch(async () => {
        await new Promise<void>((resolve) => runtimeSetTimeout(resolve, STREAM_FLUSH_INTERVAL_MS));
        if (disowned()) return;
        await write().catch(() => {
          droppedFrames += 1;
        });
      });
    });
  };
  // An empty heartbeat keeps transport activity visible without repeating answer text.
  let heartbeat: NodeJS.Timeout | undefined;
  let hasFrame = false;
  let lastWriteAt = now();
  const touched = (): void => {
    lastWriteAt = now();
  };
  const close = (): void => {
    runtimeClearTimer(heartbeat);
    heartbeat = undefined;
  };
  /*
   * Armed unconditionally, and `disowned` asked only from inside the tick.
   *
   * Asking it here instead cost the whole turn: the caller builds this channel before it starts
   * the claim watch the accessor reads, so a synchronous call reached `stopWatch` inside its own
   * temporal dead zone and threw a ReferenceError out of channel construction - every generation
   * on the process, not merely a stalled one. Nothing is lost by deferring the question. The first
   * tick is a whole interval away, by which time the watch exists, and the tick's own guard closes
   * the timer the moment the answer is yes.
   */
  heartbeat = runtimeSetInterval(() => {
    if (disowned()) {
      close();
      return;
    }
    if (!hasFrame || now() - lastWriteAt < stallIntervalMs) return;
    emitStreamFrame('', true);
  }, stallIntervalMs);
  /* Settled with the write chain below, which is what stops it; never keep a worker alive. */
  heartbeat.unref();
  /**
   * The reasoning, on its own channel and on its own flusher.
   *
   * A high-effort step on a full window routinely thinks for the better part of a minute before
   * the first word of the answer, and the owner was shown a spinner for all of it. The route
   * already produces this and the stream parser already read it; it was accumulated and thrown
   * into the response, arriving all at once after the fact when it was no longer of use.
   *
   * Its own flusher because the two arrive interleaved and sharing one would splice the thinking
   * into the answer.
   */
  const reasoningFlusher = createStreamFlusher(REASONING_FLUSH_INTERVAL_MS, now);
  const emitReasoningFrame = (frame: string): void => {
    if (disowned()) return;
    streamEvents = streamEvents.then(async () => {
      if (disowned()) return;
      touched();
      await event(deps.store, task, key, 'assistant_reasoning', 'Agent thinking', {
        markdown: frame,
        append: true
      }).catch(() => undefined);
    });
  };
  /**
   * One row for the whole of the thinking, in place of the frames that streamed it.
   *
   * The answer's frames are superseded by the assistant_message that closes the turn; the
   * thinking had no such row, so every frame it ever wrote was kept forever and decrypted again
   * on every reopen of the conversation - and the thinking is routinely the longer of the two.
   * The route accumulated the same text on the way past, so this costs nothing to obtain, and
   * writing it as a replace is what lets the store drop the frames underneath it.
   */
  const emitWholeReasoning = (markdown: string): void => {
    // The worst of the three to write on a disowned run: it is a *replace*, so it does not add
    // a stray paragraph to the other claimant's trajectory, it drops the frames underneath it.
    if (disowned()) return;
    streamEvents = streamEvents.then(async () => {
      if (disowned()) return;
      touched();
      await event(
        deps.store,
        task,
        key,
        'assistant_reasoning',
        'Agent thinking',
        { markdown, replace: true },
        { replacesEarlierFrames: true }
      ).catch(() => undefined);
    });
  };

  return {
    streamFlusher,
    reasoningFlusher,
    emitStreamFrame,
    emitReasoningFrame,
    emitWholeReasoning,
    noteDroppedFrames,
    close,
    settle: async () => {
      // The chain settles the timer with it: a heartbeat that outlived the turn would keep
      // re-asserting a frame for a generation that has closed.
      await streamEvents.finally(close);
    }
  };
};
