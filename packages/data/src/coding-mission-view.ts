import { CodingMission, CodingMissionStart, type CodingMissionState } from '@garden/contracts';
import { decryptJson } from '@garden/core';
import type { CodingMissionRecord } from './store/coding-missions.js';

export const codingMissionView = (record: CodingMissionRecord, key: Uint8Array): CodingMission => {
  const input = CodingMissionStart.parse(decryptJson(record.manifestCiphertext, key));
  const state: CodingMissionState =
    record.phase === 'active'
      ? record.pendingApprovals > 0
        ? 'awaiting_approval'
        : record.childStatus === 'completed'
          ? record.conflicts
            ? 'conflicted'
            : 'ready'
          : record.childStatus === 'failed'
            ? 'failed'
            : record.childStatus === 'cancelled'
              ? 'cancelled'
              : ['paused', 'awaiting_resource', 'awaiting_user'].includes(record.childStatus)
                ? 'paused'
                : record.childStatus === 'running' || record.childStatus === 'planning'
                  ? 'running'
                  : 'queued'
      : record.phase === 'cancelled' && record.childStatus === 'failed'
        ? 'failed'
        : record.phase;
  return CodingMission.parse({
    id: record.id,
    parentTaskId: record.parentTaskId,
    taskId: record.childTaskId,
    workspaceId: record.childWorkspaceId,
    name: input.name,
    state,
    sourceRoot: input.sourceRoot,
    outputPaths: input.outputPaths,
    allocatedCredits: record.allocatedCredits,
    usedCredits: record.usedCredits,
    reservedCredits: record.reservedCredits,
    spentUsd: record.spentUsd,
    reservedUsd: record.reservedUsd,
    pendingApprovals: record.pendingApprovals,
    changedFiles: record.changedFiles,
    conflicts: record.conflicts,
    generation: record.generation,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    detail: record.detailCiphertext
      ? decryptJson<{ message: string }>(record.detailCiphertext, key).message
      : null
  });
};
