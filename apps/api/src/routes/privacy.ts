/**
 * Everything this box holds about its owner, written out as it is read.
 *
 * Streamed rather than assembled: an export is the whole history and holding it in memory to send
 * it is how a box with a long history fails at the one moment the owner most needs it to work.
 */

import { Readable } from 'node:stream';
import { decryptJson, unwrapDataKey } from '@garden/core';
import { revealedTaskEvent } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { recordSecurityEvent } from '../security-events.js';
import { VoiceStore } from '@garden/data';
import { readVoiceDiscussion } from '../voice/context.js';

export const registerPrivacyRoutes = (context: RouteContext): void => {
  const {
    app,
    store,
    masterKey,
    taskTitle,
    scheduleTitle,
    privateTaskPlanResponse,
    requireRecentStepUp
  } = context;
  /**
   * Everything this box holds about its owner, written out as it is read.
   *
   * Assembled whole and then serialised, it would be every `assistant_delta` frame of every turn of
   * every conversation decrypted into one array, that array into one string, and the string into
   * one response. On a box a year old that is tens of millions of frames, and the failure is the
   * API's heap - the process restarted by systemd, taking every in-flight turn with it, on the one
   * route that exists so an owner can get their data out.
   *
   * So the document is emitted a piece at a time and nothing bigger than one page of one task's
   * events is ever in memory. It is still one JSON document, because the client that reads this
   * parses it whole (`apps/web/src/api.ts` reads it with `.json()` and hands it straight to a
   * Blob). NDJSON would bound the same bytes and break that button.
   *
   * The schedules read sits outside the workspace loop; inside it, it would re-read every schedule
   * the owner has once per workspace and then throw away all but one workspace's worth.
   */
  app.get('/v1/privacy/export', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    const base = await store.exportAccount(user.id);
    const workspaces = await store.listWorkspaceMetadata(user.id);
    const schedules = await store.listTaskSchedules(user.id);
    await recordSecurityEvent(store, {
      userId: user.id,
      kind: 'privacy_export',
      outcome: 'completed'
    });
    /** How many of one task's events are decrypted and held at once. */
    const EXPORT_EVENT_PAGE = 500;
    const document = async function* (): AsyncGenerator<string> {
      yield '{';
      for (const [key, value] of Object.entries(base))
        yield `${JSON.stringify(key)}:${JSON.stringify(value)},`;
      yield '"taskContents":[';
      let firstTask = true;
      // Held back rather than emitted in place: plans belong to their own array in this document,
      // and re-walking every task to collect them would double the read.
      const taskPlans: Array<Record<string, unknown>> = [];
      for (const workspace of workspaces) {
        if (!workspace.wrappedKey) continue;
        const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
        for (const task of await store.listTasks(user.id, workspace.id)) {
          if (task.userId !== user.id || task.workspaceId !== workspace.id) continue;
          /*
           * One unreadable row must not truncate the export.
           *
           * Assembled whole, a task whose title or prompt this key will not open threw and the owner
           * got a 500 - bad, but at least whole-or-nothing. Streamed, the same throw would end the
           * response part-way through a JSON document the client would then fail to parse, and the
           * owner would be left with a file that is not an export and no message saying why. So the
           * row is written with what is known about it and a flag, the same answer the notice log and
           * the memory list give for a sentence they cannot read.
           */
          let head: string;
          try {
            head = `{"taskId":${JSON.stringify(task.id)},"workspaceId":${JSON.stringify(
              workspace.id
            )},"title":${JSON.stringify(await taskTitle(task, workspace))},"prompt":${JSON.stringify(
              decryptJson<{ prompt: string }>(
                task.promptCiphertext,
                key,
                `task-prompt:${workspace.id}`
              ).prompt
            )},"events":[`;
          } catch {
            yield `${firstTask ? '' : ','}{"taskId":${JSON.stringify(
              task.id
            )},"workspaceId":${JSON.stringify(workspace.id)},"unreadable":true}`;
            firstTask = false;
            continue;
          }
          yield `${firstTask ? '' : ','}${head}`;
          firstTask = false;
          let cursor = 0;
          let firstEvent = true;
          for (;;) {
            const page = await store.listTaskEventPage(task.id, {
              after: cursor,
              limit: EXPORT_EVENT_PAGE
            });
            for (const event of page.events) {
              const content = revealedTaskEvent(
                event.summary,
                event.payloadCiphertext
                  ? decryptJson(event.payloadCiphertext, key, `task-event:${task.id}`)
                  : undefined
              );
              yield `${firstEvent ? '' : ','}${JSON.stringify({
                sequence: event.sequence,
                kind: event.kind,
                summary: content.summary,
                payload: content.payload ?? null,
                createdAt: event.createdAt
              })}`;
              firstEvent = false;
            }
            cursor = page.nextCursor;
            if (!page.hasMore) break;
          }
          let discussion: unknown;
          try {
            discussion = await readVoiceDiscussion(
              context,
              user.id,
              task.id,
              new VoiceStore(context.database)
            );
          } catch {
            discussion = { unreadable: true };
          }
          yield `],"voiceDiscussion":${JSON.stringify(discussion)}}`;
          for (const plan of await store.listTaskPlans(task.id))
            taskPlans.push(await privateTaskPlanResponse(plan, workspace));
        }
      }
      yield '],"taskPlanContents":[';
      yield taskPlans.map((plan) => JSON.stringify(plan)).join(',');
      yield '],"scheduleContents":[';
      let firstSchedule = true;
      for (const workspace of workspaces) {
        if (!workspace.wrappedKey) continue;
        const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
        for (const schedule of schedules.filter((item) => item.workspaceId === workspace.id)) {
          let line: string;
          try {
            line = JSON.stringify({
              scheduleId: schedule.id,
              workspaceId: workspace.id,
              title: await scheduleTitle(schedule, workspace),
              prompt: decryptJson<{ prompt: string }>(
                schedule.promptCiphertext,
                key,
                `task-prompt:${workspace.id}`
              ).prompt
            });
          } catch {
            line = JSON.stringify({
              scheduleId: schedule.id,
              workspaceId: workspace.id,
              unreadable: true
            });
          }
          yield `${firstSchedule ? '' : ','}${line}`;
          firstSchedule = false;
        }
      }
      yield ']}';
    };
    return reply
      .header(
        'content-disposition',
        `attachment; filename="garden-export-${new Date().toISOString().slice(0, 10)}.json"`
      )
      .type('application/json; charset=utf-8')
      .send(Readable.from(document()));
  });
};
