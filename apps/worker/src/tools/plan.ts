import { type TaskPlanStep } from '@garden/contracts';
import { decryptJson, encryptJson, GardenError } from '@garden/core';
import { type ModelToolCall } from '@garden/model-gateway';
import { event } from '../tool-recording.js';
import { planStepsFromArguments } from '../values.js';
import { type ToolContext } from '../tool-dispatch.js';

/**
 * The plan tool: the one arm that writes the document the owner reads back.
 *
 * On its own rather than folded in with the workspace tools because a plan is not a change to the
 * computer - it is the agent's account of what it is doing, versioned against the owner's own edits,
 * and the conflict handling below is the only place in the table that answers a model with a
 * correction rather than a result.
 */
export async function executePlanTool(context: ToolContext, call: ModelToolCall): Promise<unknown> {
  const { task, key } = context;
  switch (call.name) {
    case 'set_plan': {
      const current = await context.store.getLatestTaskPlan(task.id);
      const previousPlan =
        current?.stepsCiphertext.aad === `task-plan:${task.id}`
          ? decryptJson<{ steps: TaskPlanStep[]; directionEventId?: string }>(
              current.stepsCiphertext,
              key
            )
          : { steps: [] };
      const latestDirection = (
        await context.store.listTaskEvents(task.id, 0, { kind: 'user_message', limit: 1 })
      ).at(-1);
      const directionEventId = latestDirection?.id;
      // A plan made for an earlier direction does not carry its statuses into this one.
      const sameDirection = previousPlan.directionEventId
        ? previousPlan.directionEventId === directionEventId
        : !latestDirection ||
          !current ||
          Date.parse(current.createdAt) >= Date.parse(latestDirection.createdAt);
      const steps = planStepsFromArguments(
        call.arguments.steps,
        sameDirection ? previousPlan.steps : []
      );
      if (!steps.length)
        throw new GardenError(
          'invalid_plan',
          'A plan needs at least one step with a title, as ["Read the brief", …] or [{"title":"Read the brief","status":"in_progress"}, …]. Retire a step by setting it to skipped.'
        );
      try {
        const created = await context.store.createTaskPlan({
          taskId: task.id,
          expectedVersion: current?.version ?? 0,
          branchName: 'Main',
          stepsCiphertext: encryptJson(
            { steps, branchName: 'Main', ...(directionEventId ? { directionEventId } : {}) },
            key,
            `task-plan:${task.id}`
          ),
          createdBy: 'agent'
        });
        await event(context.store, task, key, 'plan', `Plan version ${created.version}`, {
          planId: created.id,
          version: created.version,
          branchName: 'Main',
          steps,
          ...(directionEventId ? { directionEventId } : {})
        });
        return { version: created.version, steps };
      } catch (cause) {
        if (cause instanceof Error && cause.message === 'plan_version_conflict')
          return {
            changedByUser: true,
            instruction: 'The user edited the plan. Reload it and follow their version.'
          };
        throw cause;
      }
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
