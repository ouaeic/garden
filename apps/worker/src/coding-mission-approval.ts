import path from 'node:path';
import { z } from 'zod';
import { CodingMissionChange, CodingMissionStart } from '@garden/contracts';
import { GardenError, decryptJson, unwrapDataKey } from '@garden/core';
import type { TaskRecord } from '@garden/data';
import type { ModelToolCall } from '@garden/model-gateway';
import type { ApprovalFloorDeps } from './approval-floor.js';
import type { AgentState } from './agent-state.js';
import { approvalRequirement, type ApprovalContext } from './approval-policy.js';

export async function codingMissionApproval(
  deps: ApprovalFloorDeps,
  task: TaskRecord,
  call: ModelToolCall,
  state: AgentState | undefined,
  context: ApprovalContext
) {
  const input = z
    .object({
      missionId: z.uuid(),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      generation: z.number().int().positive()
    })
    .parse(call.arguments.options);
  const seen = state?.codingMissionReviews?.[input.missionId];
  if (seen?.digest !== input.digest || seen.generation !== input.generation)
    throw new GardenError(
      'coding_review_required',
      'Inspect the exact coding mission review in this parent context first',
      409
    );
  const mission = await deps.store.getCodingMission(task.userId, input.missionId);
  if (
    !mission ||
    mission.parentTaskId !== task.id ||
    mission.reviewDigest !== input.digest ||
    mission.generation !== input.generation ||
    mission.childStatus !== 'completed'
  )
    throw new GardenError(
      'coding_review_changed',
      'The mission review no longer describes completed work in this parent task',
      409
    );
  const workspace = await deps.store.getWorkspace(task.userId, task.workspaceId);
  if (!workspace?.wrappedKey) throw new Error('Parent workspace key is unavailable');
  const declared = CodingMissionStart.parse(
    decryptJson(
      mission.manifestCiphertext,
      unwrapDataKey(workspace.wrappedKey, deps.masterKey, workspace.id)
    )
  );
  const review = z
    .object({
      digest: z.string(),
      canIntegrate: z.boolean(),
      changes: z.array(CodingMissionChange).max(500)
    })
    .parse(
      await deps.runner.call(
        task.workspaceId,
        task.id,
        'coding.missions.read',
        `/v1/workspaces/${task.workspaceId}/coding-missions/${mission.id}/review`,
        { generation: mission.generation }
      )
    );
  if (
    review.digest !== input.digest ||
    !review.canIntegrate ||
    review.changes.some((c) => c.binary || c.diffOmitted)
  )
    throw new GardenError(
      'coding_review_changed',
      'The source changed after inspection; review it again',
      409
    );
  const source =
    declared.sourceRoot === 'workspace' || declared.sourceRoot.startsWith('workspace/')
      ? declared.sourceRoot
      : `workspace/${declared.sourceRoot}`;
  let result: ReturnType<typeof approvalRequirement> = null;
  const ranks = { workspace_write: 0, external_reversible: 1, external_consequential: 2 };
  for (const change of review.changes) {
    const target = path.posix.join(source, change.path);
    const required =
      change.kind === 'deleted'
        ? approvalRequirement(
            'shell',
            { executable: 'rm', args: ['--', target], cwd: 'workspace' },
            task.securityMode,
            context
          )
        : approvalRequirement(
            'file_write',
            { path: target, content: change.diff ?? '' },
            task.securityMode,
            context
          );
    if (required && (!result || ranks[required.sideEffect] > ranks[result.sideEffect]))
      result = required;
  }
  return result
    ? {
        ...result,
        action: 'Integrate the inspected coding changes',
        preview: `${result.preview}\n\nMission ${declared.name}; generation ${input.generation}; digest ${input.digest}.\n${review.changes.map((c) => `${c.kind}: ${c.path}`).join('\n')}`
      }
    : null;
}
