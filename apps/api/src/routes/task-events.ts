/**
 * The transcript, as a window and as a live stream.
 *
 * Moved last in Wave 6 and only once `event-stream.test.ts` was green, because the promise this
 * makes is the one a refactor cannot see itself break: a client that reconnects with
 * `Last-Event-ID` gets everything it missed, once each, with no gap. Replay is served from the
 * same page reader the windowed route uses, which is what keeps the two from disagreeing about
 * where the window ends.
 */

import { TaskEventWindowQuery } from '@garden/contracts';
import type { TaskEvent } from '@garden/contracts';
import { GardenError, decryptJson, unwrapDataKey } from '@garden/core';
import { STREAM_TOKEN_RECHECK_MS, maxEventStreamsPerUser, revealedTaskEvent } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { errorFields } from '../log.js';
import { writeEventFrame } from '../http/event-stream-write.js';

export const registerTaskEventRoutes = (context: RouteContext): void => {
  const { log, app, database, store, masterKey, openEventStreams, nextEventStreamId } = context;
  /**
   * A window onto one conversation's trajectory, always oldest first.
   *
   * `after` reads forward from a cursor, which is what a poll resumes with. `before` reads the
   * page immediately preceding a sequence, which is how a reader walks back into history. `limit`
   * on its own asks for the newest N, which is what opening an hour-long conversation wants
   * instead of every frame ever recorded. Naming none of the three still returns everything, so
   * an export or a sync reads the whole trajectory as it always has. A backwards page shorter
   * than `limit` is the beginning of the conversation.
   */
  app.get<{
    Params: { taskId: string };
    Querystring: { after?: string; before?: string; limit?: string; page?: string };
  }>('/v1/tasks/:taskId/events', async (request) => {
    const user = requireUser(request.user);
    const task = await store.getTask(user.id, request.params.taskId);
    if (!task) throw new GardenError('task_not_found', 'Task not found');
    const workspace = await store.getWorkspace(user.id, task.workspaceId);
    if (!workspace?.wrappedKey) throw new GardenError('workspace_not_found', 'Workspace not found');
    const dataKey = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
    const query = TaskEventWindowQuery.parse(request.query);
    /*
     * The store has answered `hasMore`, `oldestSequence` and `nextCursor` for every windowed read
     * since the window existed, and this route threw all three away and returned the bare array - so
     * a reader walking back through a long conversation could not tell "this is the beginning" from
     * "this page happens to be short", and a forward reader had to infer its next cursor from the
     * last row it happened to receive.
     *
     * Opt-in, not the new default. `apps/web`'s `api.events` is typed `TaskEvent[]` and lives in
     * files no lane in this wave may touch; flipping the shape here would ship a client that reads
     * `.map` off an object. The client switches to `?page=1` in the wave that owns it, and the
     * default follows once nothing is left reading the array.
     */
    // Compared against the two literals rather than coerced: `z.coerce.boolean()` reads the string
    // "0" as true, because `Boolean('0')` is true, and a caller asking for `page=0` would have got
    // the envelope.
    const asPage = request.query.page === '1' || request.query.page === 'true';
    const page =
      query.before !== undefined
        ? await store.listTaskEventPage(task.id, {
            before: query.before,
            limit: query.limit ?? 200
          })
        : query.limit === undefined
          ? null
          : query.after === undefined
            ? await store.listRecentTaskEvents(task.id, query.limit)
            : await store.listTaskEventPage(task.id, { after: query.after, limit: query.limit });
    // The unwindowed read stays exactly what it was: everything from the cursor, in one answer.
    const records = page ? page.events : await store.listTaskEvents(task.id, query.after ?? 0);
    const events = records.map((event): TaskEvent => {
      const revealed = revealedTaskEvent(
        event.summary,
        event.payloadCiphertext
          ? decryptJson(event.payloadCiphertext, dataKey, `task-event:${task.id}`)
          : undefined
      );
      return {
        id: event.id,
        taskId: event.taskId,
        sequence: event.sequence,
        kind: event.kind,
        summary: revealed.summary,
        ...(revealed.payload === undefined ? {} : { payload: revealed.payload }),
        createdAt: event.createdAt
      };
    });
    if (!asPage) return events;
    return {
      events,
      hasMore: page?.hasMore ?? false,
      oldestSequence: page?.oldestSequence ?? events[0]?.sequence ?? null,
      nextCursor: page?.nextCursor ?? events.at(-1)?.sequence ?? query.after ?? 0
    };
  });

  app.get<{ Params: { taskId: string }; Querystring: { after?: string } }>(
    '/v1/tasks/:taskId/events/stream',
    async (request, reply) => {
      const user = requireUser(request.user);
      // Which credential opened this stream, so it can be re-checked while it is still open. A
      // session's own revocation already closes it - the cookie stops resolving on the next
      // request - but this connection makes no further requests, and a bearer token was checked
      // only at the moment it began.
      const streamToken = request.apiToken?.id ?? null;
      const task = await store.getTask(user.id, request.params.taskId);
      if (!task) throw new GardenError('task_not_found', 'Task not found');
      const workspace = await store.getWorkspace(user.id, task.workspaceId);
      if (!workspace?.wrappedKey)
        throw new GardenError('workspace_not_found', 'Workspace not found');
      const dataKey = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      const lastEventId = Array.isArray(request.headers['last-event-id'])
        ? request.headers['last-event-id'][0]
        : request.headers['last-event-id'];
      /**
       * The same schema `/v1/tasks/:taskId/events` parses its window with, rather than a bare
       * `Number()`. A repeated parameter - `?after=500&after=600` - arrives as an array, and
       * `Number(['500','600'])` is `NaN`, which `|| 0` turned into a cursor of zero: the
       * connection then replayed the whole conversation instead of refusing a query it could not
       * read. Every `assistant_delta` frame is a row, and one measured turn wrote 1,015 of them.
       */
      const { after } = TaskEventWindowQuery.parse(request.query);
      const resumed = TaskEventWindowQuery.parse({ after: lastEventId }).after;
      let cursor = Math.max(0, after ?? 0, resumed ?? 0);
      let sending = false;
      let resend = false;
      let closed = false;
      const streamAbort = new AbortController();
      let idleTerminalChecks = 0;
      // The credential was checked to open this connection; the clock for re-checking it starts
      // there rather than at zero, so the first re-check is one interval away and not immediate.
      let tokenCheckedAt = Date.now();
      const streams = openEventStreams.get(user.id) ?? new Map<number, () => void>();
      openEventStreams.set(user.id, streams);
      // A phone that went to sleep holds its half of the connection until TCP notices, which can
      // outlast the walk to the desk. Dropping the oldest is the only outcome that keeps the
      // device in front of the owner working.
      while (streams.size >= maxEventStreamsPerUser) {
        const oldest = streams.keys().next();
        if (oldest.done) break;
        const closeOldest = streams.get(oldest.value);
        streams.delete(oldest.value);
        closeOldest?.();
      }
      const streamId = nextEventStreamId();
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'private, no-cache, no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      reply.raw.flushHeaders();

      /**
       * Where this task has got to, and whether this caller may still be told - the two questions
       * `send()` asks after every batch of frames.
       *
       * `store.getTask` answered both, and answered them with `SELECT t.*` plus two correlated
       * subqueries per row: the whole task record, including the encrypted agent trajectory the
       * worker checkpoints on every step. `send()` runs once per timeline write, a streamed model
       * call writes `assistant_delta` in the hundreds, and every one of those decoded a growing
       * blob of ciphertext to read one status string - measured at hundreds of megabytes per model
       * call, per open stream.
       *
       * Two columns and the same workspace join, because the join is the access check: swapping to
       * `store.taskClaim`, which reads the status by id alone, would have made this cheap and
       * quietly turned a stream that ends when the workspace stops being the caller's into one that
       * never asks again. The comment at the call site is about that join, not about the row.
       *
       * Wave 6 folds this into the store; it is a local query here because the step that needed it
       * did not own that file.
       */
      const streamTaskStatus = async (): Promise<string | null> => {
        const result = await database.query<{ status: string }>(
          `SELECT t.status FROM tasks t JOIN workspaces w ON w.id=t.workspace_id
           WHERE t.id=$1 AND w.user_id=$2 LIMIT 1`,
          [task.id, user.id]
        );
        const row = result.rows[0];
        return row ? String(row.status) : null;
      };

      const close = () => {
        if (closed) return;
        closed = true;
        streamAbort.abort();
        clearInterval(timer);
        clearInterval(heartbeat);
        unsubscribe();
        streams.delete(streamId);
        if (streams.size === 0) openEventStreams.delete(user.id);
        if (!reply.raw.destroyed) reply.raw.end();
      };
      const write = async (frame: string): Promise<boolean> => {
        if (await writeEventFrame(reply.raw, frame, streamAbort.signal)) return true;
        close();
        // A peer that cannot drain must not retain the final buffer indefinitely after end().
        if (!reply.raw.destroyed) reply.raw.destroy();
        return false;
      };
      const send = async () => {
        if (closed) return;
        if (sending) {
          resend = true;
          return;
        }
        sending = true;
        try {
          do {
            resend = false;
            // Check authority between bounded pages, including a long reconnect replay.
            if (streamToken && Date.now() - tokenCheckedAt >= STREAM_TOKEN_RECHECK_MS) {
              tokenCheckedAt = Date.now();
              const stillValid = (await store.listApiTokens(user.id)).some(
                (candidate) => candidate.id === streamToken
              );
              if (!stillValid) {
                close();
                return;
              }
            }
            const status = await streamTaskStatus();
            if (status === null || closed) {
              close();
              return;
            }
            const page = await store.listTaskEventPage(task.id, { after: cursor, limit: 250 });
            for (const event of page.events) {
              if (closed) return;
              const revealed = revealedTaskEvent(
                event.summary,
                event.payloadCiphertext
                  ? decryptJson(event.payloadCiphertext, dataKey, `task-event:${task.id}`)
                  : undefined
              );
              const response: TaskEvent = {
                id: event.id,
                taskId: event.taskId,
                sequence: event.sequence,
                kind: event.kind,
                summary: revealed.summary,
                ...(revealed.payload === undefined ? {} : { payload: revealed.payload }),
                createdAt: event.createdAt
              };
              if (!(await write(`id: ${event.sequence}\ndata: ${JSON.stringify(response)}\n\n`)))
                return;
              cursor = event.sequence;
            }
            if (['completed', 'failed', 'cancelled'].includes(status)) {
              idleTerminalChecks = page.events.length === 0 ? idleTerminalChecks + 1 : 0;
              if (idleTerminalChecks >= 2) {
                await write(`event: terminal\ndata: ${JSON.stringify({ status })}\n\n`);
                close();
                return;
              }
            } else {
              idleTerminalChecks = 0;
            }
            // Drain consecutive pages in this loop; recursive sends would retain their buffers.
            if (page.hasMore) resend = true;
          } while (resend && !closed);
        } catch (error) {
          log.warn('events.stream_failed', { taskId: task.id, ...errorFields(error) });
          close();
        } finally {
          sending = false;
        }
      };
      /**
       * The stream is fed by the write itself; the timer behind it is a safety net for the window
       * where a notification connection is re-establishing, and for the terminal check. Before
       * this, delivery was the timer, which put up to a second between the agent producing text
       * and the owner seeing it - and delivered several 400 ms flushes in one lump when it fired.
       */
      const unsubscribe = store.onTaskEvent(task.id, () => void send());
      const timer = setInterval(() => void send(), 1_000);
      timer.unref();
      // Proxies and sleeping phones both leave a connection that looks open and is not. A comment
      // frame is the cheapest thing that makes the socket fail, which is what releases the slot.
      const heartbeat = setInterval(() => {
        if (!closed && !sending && !reply.raw.destroyed) void write(': keepalive\n\n');
      }, 20_000);
      heartbeat.unref();
      streams.set(streamId, close);
      reply.raw.on('close', close);
      // Fastify's own `onResFinished` is still listening here after `hijack()`, so an error on this
      // response is not lost - but it is absorbed by the reply's bookkeeping, which knows nothing
      // about the timer, the subscription and the slot this stream is holding. A socket that faults
      // is as finished as one that closed, and the same function releases all three.
      reply.raw.on('error', () => close());
      reply.raw.write(': connected\n\n');
      await send();
      return reply;
    }
  );
};
