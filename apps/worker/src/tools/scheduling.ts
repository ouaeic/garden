import { runtimeDate } from '@athanor/core';
import { TaskScheduleSpec } from '@athanor/contracts';
import { decryptJson, encryptJson, nextScheduleRun, AthanorError } from '@athanor/core';
import { type ModelToolCall } from '@athanor/model-gateway';
import { boundedKnowledge, textValue } from '../values.js';
import { type ToolContext } from '../tool-dispatch.js';
import { clampNumber } from './numbers.js';

/**
 * The schedule tool: work this computer will do when nobody is watching.
 *
 * One arm with four branches, on its own because of what it is rather than how big it is: it is the
 * only tool that commits the owner to spending money on a turn they will not be present for.
 */
export async function executeSchedulingTool(
  context: ToolContext,
  call: ModelToolCall
): Promise<unknown> {
  const { task, key } = context;
  switch (call.name) {
    case 'schedule': {
      const action = textValue(call.arguments.action);
      const records = await context.store.listTaskSchedules(task.userId);
      const materialize = (record: (typeof records)[number]) => ({
        id: record.id,
        title:
          record.titleCiphertext.aad === `task-title:${task.workspaceId}`
            ? decryptJson<{ title: string }>(record.titleCiphertext, key).title
            : 'Private schedule',
        prompt:
          record.promptCiphertext.aad === `task-prompt:${task.workspaceId}`
            ? decryptJson<{ prompt: string }>(record.promptCiphertext, key).prompt
            : undefined,
        modelId: record.modelId,
        maxComputeCredits: record.maxComputeCredits,
        spec: record.spec,
        enabled: record.enabled,
        nextRunAt: record.nextRunAt,
        lastRunAt: record.lastRunAt,
        lastTaskId: record.lastTaskId,
        lastErrorCode: record.lastErrorCode
      });
      if (action === 'list')
        return {
          schedules: records
            .filter((record) => record.workspaceId === task.workspaceId)
            .map(materialize)
        };
      if (action === 'create') {
        const prompt = boundedKnowledge(call.arguments.prompt, 200_000);
        const title = boundedKnowledge(
          call.arguments.title || prompt.replace(/\s+/g, ' ').slice(0, 120),
          160
        );
        const spec = TaskScheduleSpec.parse(call.arguments.spec);
        const nextRunAt = nextScheduleRun(spec);
        if (!nextRunAt)
          throw new AthanorError('schedule_in_past', 'A one-time schedule must be in the future');
        const maxSchedules = 1_000;
        const created = await context.store.createTaskSchedule({
          userId: task.userId,
          workspaceId: task.workspaceId,
          titleCiphertext: encryptJson({ title }, key, `task-title:${task.workspaceId}`),
          promptCiphertext: encryptJson({ prompt }, key, `task-prompt:${task.workspaceId}`),
          modelId: task.modelId,
          privacyRoute: task.privacyRoute,
          /*
           * Read through the shared clamp, and this is the reason that clamp exists.
           *
           * `Math.max(0.01, Number('abc'))` is `NaN` and `Math.min(100, NaN)` is `NaN` again, so
           * the floor and the cap written here were both transparent to a ceiling the model
           * spelled wrong. `createTaskSchedule` validates nothing, the dispatcher copies
           * `max_compute_credits` onto every task the schedule creates, and the loop's ceiling is
           * `state.credits >= task.maxComputeCredits` - false for every value of credits when the
           * right-hand side is `NaN`. A schedule created with a mistyped ceiling therefore ran at
           * 3am with no compute ceiling in force at all, until the step budget stopped it.
           */
          maxComputeCredits: clampNumber(call.arguments.maxComputeCredits, {
            min: 0.01,
            max: 100,
            fallback: 5
          }),
          /*
           * The run's own money ceiling, carried onto the work it is scheduling, and this line is
           * the other half of the same unattended-spend hole.
           *
           * `createTaskSchedule` writes `max_spend_usd` from `input.maxSpendUsd ?? null`, so
           * leaving it out here wrote NULL - and the dispatcher copies that null onto the task.
           * `spendGuardIn` does not read a null ceiling as a low one: it drops the task window
           * from the guard entirely, so a corrupt or absent money column is not a tight cap, it is
           * no cap. Composed with the `NaN` above, an agent-created schedule was running unattended
           * with neither money bound in force, while a schedule the owner created through
           * `POST /v1/schedules` got their default per-task cap from `resolveSpendCeiling`.
           *
           * The tool takes no `maxSpendUsd` argument - the same reason the update branch below
           * carries the stored value forward rather than preferring one - so what is carried is
           * the ceiling the run doing the creating is itself held to. The agent may commit the
           * owner to later work, and may not commit them to more per run than they are being held
           * to now.
           */
          maxSpendUsd: task.maxSpendUsd ?? null,
          spec,
          nextRunAt,
          maxSchedules
        });
        return materialize(created);
      }
      const id = textValue(call.arguments.id);
      const existing = records.find(
        (record) => record.id === id && record.workspaceId === task.workspaceId
      );
      if (!existing) throw new AthanorError('schedule_not_found', 'Schedule not found');
      if (action === 'update') {
        const currentTitle =
          existing.titleCiphertext.aad === `task-title:${task.workspaceId}`
            ? decryptJson<{ title: string }>(existing.titleCiphertext, key).title
            : 'Scheduled task';
        const currentPrompt =
          existing.promptCiphertext.aad === `task-prompt:${task.workspaceId}`
            ? decryptJson<{ prompt: string }>(existing.promptCiphertext, key).prompt
            : '';
        const hasChange =
          typeof call.arguments.title === 'string' ||
          typeof call.arguments.prompt === 'string' ||
          call.arguments.spec !== undefined ||
          call.arguments.maxComputeCredits !== undefined;
        if (!hasChange)
          throw new AthanorError(
            'schedule_update_empty',
            'Provide a new title, instruction, timing, or compute limit'
          );
        const title = boundedKnowledge(call.arguments.title ?? currentTitle, 160);
        const prompt = boundedKnowledge(call.arguments.prompt ?? currentPrompt, 200_000);
        const spec =
          call.arguments.spec === undefined
            ? existing.spec
            : TaskScheduleSpec.parse(call.arguments.spec);
        const nextRunAt = existing.enabled ? nextScheduleRun(spec) : null;
        if (existing.enabled && !nextRunAt)
          throw new AthanorError(
            'schedule_in_past',
            'An enabled one-time schedule must be in the future'
          );
        const updated = await context.store.updateTaskSchedule(task.userId, existing.id, {
          titleCiphertext: encryptJson({ title }, key, `task-title:${task.workspaceId}`),
          promptCiphertext: encryptJson({ prompt }, key, `task-prompt:${task.workspaceId}`),
          spec,
          // Same clamp, same reason: an edit may not turn a live ceiling into one that never
          // fires either. The fallback is the stored value rather than the tool's default, because
          // this branch is an edit and an unreadable new ceiling means the old one stands.
          maxComputeCredits: clampNumber(call.arguments.maxComputeCredits, {
            min: 0.01,
            max: 100,
            fallback: existing.maxComputeCredits
          }),
          /*
           * Carried forward explicitly, and this line is a money fix rather than a tidy-up.
           *
           * `updateTaskSchedule` writes `max_spend_usd` on every call from
           * `input.maxSpendUsd ?? null`, so a caller that leaves it out does not leave the column
           * alone - it clears it. This arm is the agent editing a schedule on an unattended run,
           * so the ceiling on the owner's watcher was being removed by an edit to its wording,
           * with nobody awake to see it happen. The API half of the same bug is fixed and pinned
           * at `server.ts`'s `PATCH /v1/schedules/:scheduleId`; this is the worker half.
           *
           * The tool takes no `maxSpendUsd` argument, so there is nothing to prefer over the
           * stored value: the agent may retime and reword a schedule, and may not touch what it
           * is allowed to spend.
           */
          maxSpendUsd: existing.maxSpendUsd,
          nextRunAt
        });
        if (!updated) throw new AthanorError('schedule_not_found', 'Schedule not found');
        return materialize(updated);
      }
      if (action === 'run') {
        /*
         * The same in-flight check the dispatcher takes, because this is the second door onto the
         * same act and it was left without one. Without it the arm answered `queuedNow: true` for a
         * run that never happened - the dispatcher's own overlap policy skips the occurrence a
         * moment later - so the model told the owner in their own conversation that a run had
         * started, and the schedule row was then stamped with a code the client renders as a
         * failure. Two wrong sentences about one non-event.
         *
         * Refused rather than silently skipped, and the difference is who asked: a clock that finds
         * the previous run still going should stand down quietly, and a model that asked for a run
         * now is owed a reason it can act on and repeat to the owner.
         */
        if (await context.store.taskScheduleRunInFlight(existing.id))
          throw new AthanorError(
            'previous_run_active',
            'This schedule already has a run that has not finished; open that conversation and let it finish or cancel it, then run this again'
          );
        const updated = await context.store.setTaskScheduleEnabled(
          task.userId,
          existing.id,
          true,
          runtimeDate()
        );
        if (!updated) throw new AthanorError('schedule_not_found', 'Schedule not found');
        return { ...materialize(updated), queuedNow: true };
      }
      if (action === 'pause' || action === 'resume') {
        const nextRunAt = action === 'resume' ? nextScheduleRun(existing.spec) : null;
        if (action === 'resume' && !nextRunAt)
          throw new AthanorError(
            'schedule_finished',
            'This one-time schedule has passed; create a new schedule instead'
          );
        const updated = await context.store.setTaskScheduleEnabled(
          task.userId,
          existing.id,
          action === 'resume',
          nextRunAt
        );
        if (!updated) throw new AthanorError('schedule_not_found', 'Schedule not found');
        return materialize(updated);
      }
      if (action === 'remove')
        return {
          removed: await context.store.deleteTaskSchedule(task.userId, existing.id),
          id: existing.id
        };
      throw new AthanorError('schedule_action_invalid', 'Unknown schedule action');
    }
    default:
      /*
       * Unreachable: the table in `tool-dispatch.ts` is what chooses this module, and it only
       * names the tools above. Kept so that a tool added to the table and forgotten here fails
       * loudly on the first call rather than returning `undefined` to the model.
       */
      throw new Error(`Unknown tool ${call.name}`);
  }
}
