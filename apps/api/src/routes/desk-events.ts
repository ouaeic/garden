/**
 * The desk, as a live stream: every conversation the owner has, told to the device as it changes.
 *
 * The transcript stream beside this one follows one conversation a frame at a time. The desk does
 * not want frames; it wants to know that a conversation now reads differently - it is waiting on
 * the owner, it has finished, it has a name - and to know it when it happens rather than at the
 * next poll. So this sends the conversation's summary, in the shape the bootstrap lists it in, and
 * nothing else. A client applies it to the list it already holds.
 *
 * Three frames, each one JSON object:
 *
 * - `task` - `{ task, moves }`: the conversation as `GET /v1/bootstrap` would list it now. `moves`
 *   is true when what `GET /v1/moves` reads from this conversation may have changed with it.
 * - `removed` - `{ taskId }`: a conversation this stream has already told the device about is gone.
 * - `moves` - `{ taskId }`: a conversation the desk does not list - a coding specialist's - changed
 *   in a way the moves may show.
 *
 * A device that reconnects reads the desk afresh once and then follows this again: nothing is
 * replayed, because a summary is the current state and not a history.
 */

import { sha256 } from '@garden/core';
import type { TaskListingRecord, WorkspaceRecord } from '@garden/data';
import { STREAM_TOKEN_RECHECK_MS, maxDeskStreamsPerUser } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import { writeEventFrame } from '../http/event-stream-write.js';
import type { RouteContext } from '../http/server-context.js';
import { errorFields } from '../log.js';
import { sessionCookieName } from '../session.js';

/**
 * The most often one conversation is re-read and re-sent on one stream.
 *
 * Every timeline write is a signal, and a streamed reply writes several a second, none of which
 * changes the summary. The read after the window is the one that matters: whatever was written
 * during it is in that read, so nothing is lost by waiting, only repeated.
 */
export const DESK_FRAME_INTERVAL_MS = 300;

/**
 * How long a signal waits before its read even when the window is open.
 *
 * On PostgreSQL a write is heard twice in this process - once locally, once back over the LISTEN
 * bridge a few milliseconds later - and a write that announces itself is often followed at once by
 * the one beside it, the event and then the status. A short wait reads them together.
 */
const DESK_FRAME_SETTLE_MS = 40;

/** Proxies and sleeping phones leave connections that look open; a comment frame finds them. */
const DESK_KEEPALIVE_MS = 20_000;

/**
 * Past this many conversations remembered on one stream, the memory starts again.
 *
 * What is remembered is whose each conversation is, the last frame sent for it and when it was
 * last read. Forgetting costs a re-read and possibly one repeated frame; never a missed change.
 */
const DESK_MEMORY_LIMIT = 2_048;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What `/v1/moves` reads from one conversation, as one string to compare: whether it is waiting on
 * the owner or on a ceiling, and the name it would be listed under there.
 *
 * Empty for a conversation that is doing neither, so a reply streaming into a running conversation
 * never asks a device to read the moves again, and the moment it starts or stops waiting does.
 * The title is compared sealed - its ciphertext changes whenever the name does.
 */
const movesKey = (task: TaskListingRecord): string =>
  task.status === 'awaiting_user' || task.spendPausedAt
    ? [
        task.status,
        task.spendPausedAt ?? '',
        task.hasOpenQuestion ? 'question' : '',
        task.updatedAt,
        task.titleCiphertext?.ciphertext ?? task.legacyTitle ?? ''
      ].join('|')
    : '';

interface Watched {
  timer: ReturnType<typeof setTimeout> | undefined;
  reading: boolean;
  /** A signal arrived while this conversation was being read, so the read may already be stale. */
  again: boolean;
  readAt: number;
}

export const registerDeskEventRoutes = (context: RouteContext): void => {
  const {
    app,
    log,
    database,
    store,
    secure,
    privateTaskResponse,
    openDeskStreams,
    nextEventStreamId
  } = context;

  app.get('/v1/events/stream', async (request, reply) => {
    const user = requireUser(request.user);
    /**
     * Which credential opened this stream, so it can be asked again while the stream is open.
     *
     * The transcript stream re-asks only about a bearer token, and ends when its conversation
     * does. This one has no end of its own - it lasts as long as the tab - so a session that was
     * signed out from another device is asked about too, or a phone left open on the desk would go
     * on hearing every conversation's name after its owner had cut it off.
     */
    const streamToken = request.apiToken?.id ?? null;
    const sessionCookie = streamToken ? undefined : request.cookies[sessionCookieName(secure)];
    const sessionHash = sessionCookie ? sha256(sessionCookie) : null;
    let credentialCheckedAt = Date.now();

    const streams = openDeskStreams.get(user.id) ?? new Map<number, () => void>();
    openDeskStreams.set(user.id, streams);
    // The newest connection is the device in front of the owner, so a full house closes the
    // oldest, as the transcript streams do - from a count of its own, so that a desk open on every
    // device never closes the conversation somebody is watching.
    while (streams.size >= maxDeskStreamsPerUser) {
      const oldest = streams.keys().next();
      if (oldest.done) break;
      const closeOldest = streams.get(oldest.value);
      streams.delete(oldest.value);
      closeOldest?.();
    }
    const streamId = nextEventStreamId();

    let closed = false;
    const streamAbort = new AbortController();
    const watched = new Map<string, Watched>();
    /** Whose each conversation is, as far as this stream has had to ask. */
    const owned = new Map<string, boolean>();
    /** The last summary sent for each conversation, and what the moves read from it then. */
    const sent = new Map<string, { frame: string; moves: string }>();
    /**
     * The workspace each conversation is sealed under. Only the key and the parent link are read
     * from it, and neither changes while the workspace exists.
     */
    const workspaces = new Map<string, Promise<WorkspaceRecord | undefined>>();

    const close = (): void => {
      if (closed) return;
      closed = true;
      streamAbort.abort();
      unsubscribe();
      clearInterval(heartbeat);
      for (const entry of watched.values()) clearTimeout(entry.timer);
      watched.clear();
      streams.delete(streamId);
      if (streams.size === 0) openDeskStreams.delete(user.id);
      if (!reply.raw.destroyed) reply.raw.end();
    };

    /**
     * One frame at a time, in order. Reads for different conversations finish in any order, and a
     * peer that has stopped reading must stall the next frame rather than let them pile up.
     */
    let writing: Promise<boolean> = Promise.resolve(true);
    const write = (frame: string): Promise<boolean> => {
      writing = writing.then(async (open) => {
        if (!open || closed) return false;
        if (await writeEventFrame(reply.raw, frame, streamAbort.signal)) return true;
        close();
        // A peer that cannot drain must not retain the final buffer indefinitely after end().
        if (!reply.raw.destroyed) reply.raw.destroy();
        return false;
      });
      return writing;
    };

    const credentialStillGood = async (): Promise<boolean> => {
      if (Date.now() - credentialCheckedAt < STREAM_TOKEN_RECHECK_MS) return true;
      credentialCheckedAt = Date.now();
      if (streamToken)
        return (await store.listApiTokens(user.id)).some((token) => token.id === streamToken);
      if (!sessionHash) return false;
      // Read-only on purpose: resolving the session would slide its expiry, and a tab left open
      // is not the owner using the device.
      const session = await database.query(
        'SELECT 1 FROM sessions WHERE id_hash=$1 AND user_id=$2 AND expires_at > NOW()',
        [sessionHash, user.id]
      );
      return session.rows.length > 0;
    };

    const workspaceFor = (workspaceId: string): Promise<WorkspaceRecord | undefined> => {
      let found = workspaces.get(workspaceId);
      if (!found) {
        found = store
          .listWorkspaceMetadata(user.id, [workspaceId])
          .then((rows) => rows[0])
          .catch((error: unknown) => {
            workspaces.delete(workspaceId);
            throw error;
          });
        workspaces.set(workspaceId, found);
      }
      return found;
    };

    const remember = (): void => {
      if (owned.size <= DESK_MEMORY_LIMIT && sent.size <= DESK_MEMORY_LIMIT) return;
      owned.clear();
      sent.clear();
    };

    /** Reads one conversation and says what changed about it, if anything did. */
    const deliver = async (taskId: string): Promise<void> => {
      // The join to the owner's workspaces is the ownership check, so this one read answers both
      // whether the conversation is theirs and what it now says.
      const task = await store.getTaskListing(user.id, taskId);
      if (closed) return;
      if (!task) {
        const told = Boolean(sent.get(taskId)?.frame);
        owned.set(taskId, false);
        sent.delete(taskId);
        remember();
        // Only a conversation this stream has already shown is reported gone: an id nobody can
        // prove was the owner's is not this device's business, gone or not.
        if (told) await write(`event: removed\ndata: ${JSON.stringify({ taskId })}\n\n`);
        return;
      }
      owned.set(taskId, true);
      const moves = movesKey(task);
      const previous = sent.get(taskId);
      // A conversation this stream has not described yet may have been waiting when the device last
      // read its moves, so its first frame always says the moves may have changed.
      const movesChanged = previous === undefined || previous.moves !== moves;
      if (task.parentMissionId) {
        // A specialist's conversation is never on the desk, but what it asks of the owner is.
        sent.set(taskId, { frame: '', moves });
        remember();
        if (movesChanged) await write(`event: moves\ndata: ${JSON.stringify({ taskId })}\n\n`);
        return;
      }
      const summary = JSON.stringify(
        await privateTaskResponse(task, await workspaceFor(task.workspaceId))
      );
      if (closed) return;
      if (previous?.frame === summary && !movesChanged) return;
      sent.set(taskId, { frame: summary, moves });
      remember();
      await write(`event: task\ndata: {"task":${summary},"moves":${movesChanged}}\n\n`);
    };

    const read = async (taskId: string, entry: Watched): Promise<void> => {
      if (closed) return;
      entry.reading = true;
      entry.again = false;
      entry.readAt = Date.now();
      try {
        if (!(await credentialStillGood())) {
          close();
          return;
        }
        await deliver(taskId);
      } catch (error) {
        // The device reconnects and reads the desk afresh, which is the recovery this would
        // otherwise have to invent.
        log.warn('desk.stream_failed', { taskId, ...errorFields(error) });
        close();
        return;
      } finally {
        entry.reading = false;
      }
      if (entry.again) touch(taskId);
    };

    /** A conversation changed: read it once the window allows, unless a read is already coming. */
    const touch = (taskId: string): void => {
      if (closed || !uuidPattern.test(taskId) || owned.get(taskId) === false) return;
      let entry = watched.get(taskId);
      if (!entry) {
        if (watched.size >= DESK_MEMORY_LIMIT)
          for (const [id, idle] of watched) if (!idle.timer && !idle.reading) watched.delete(id);
        entry = { timer: undefined, reading: false, again: false, readAt: 0 };
        watched.set(taskId, entry);
      }
      if (entry.reading) {
        entry.again = true;
        return;
      }
      // The read already scheduled has not started, so it will see this write too.
      if (entry.timer) return;
      const due = entry;
      const wait = Math.max(DESK_FRAME_SETTLE_MS, due.readAt + DESK_FRAME_INTERVAL_MS - Date.now());
      due.timer = setTimeout(() => {
        due.timer = undefined;
        void read(taskId, due);
      }, wait);
      due.timer.unref();
    };

    // Subscribed before the headers go, so a device that has seen this response can rely on every
    // change from here on reaching it, and reads the desk once to cover everything before.
    const unsubscribe = store.onAnyTaskEvent(touch);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'private, no-cache, no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    reply.raw.flushHeaders();
    const heartbeat = setInterval(() => {
      if (closed || reply.raw.destroyed) return;
      void (async () => {
        if (!(await credentialStillGood())) {
          close();
          return;
        }
        await write(': keepalive\n\n');
      })().catch((error: unknown) => {
        log.warn('desk.stream_failed', errorFields(error));
        close();
      });
    }, DESK_KEEPALIVE_MS);
    heartbeat.unref();
    streams.set(streamId, close);
    reply.raw.on('close', close);
    // A socket that faults is as finished as one that closed, and the same function releases the
    // subscription, the timers and the slot.
    reply.raw.on('error', () => close());
    await write(': connected\n\n');
    return reply;
  });
};
