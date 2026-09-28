import { runtimeClearTimer, runtimeSetTimeout } from '@garden/core';
import type { CodingMissionRecord, DataStore } from '@garden/data';
import { AgentRunnerClient } from './runner-client.js';

export async function reconcileCodingMission(
  store: DataStore,
  runner: AgentRunnerClient,
  mission: CodingMissionRecord
): Promise<void> {
  const base = `/v1/workspaces/${mission.parentWorkspaceId}/coding-missions/${mission.id}`;
  if (mission.phase === 'integrating') {
    const status = await runner.call<{ phase: string; generation: number; digest: string | null }>(
      mission.parentWorkspaceId,
      mission.parentTaskId,
      'coding.missions.read',
      `${base}/status`
    );
    if (status.generation !== mission.generation) return;
    if (status.phase === 'integrated' && status.digest === mission.reviewDigest)
      await store.finishCodingMissionIntegration(
        mission.userId,
        mission.id,
        mission.generation,
        mission.reviewDigest!,
        true
      );
    else if (['active', 'ready'].includes(status.phase) && mission.reviewDigest)
      await store.finishCodingMissionIntegration(
        mission.userId,
        mission.id,
        mission.generation,
        mission.reviewDigest,
        false
      );
    return;
  }
  if (
    mission.phase === 'active' &&
    mission.childStatus === 'completed' &&
    !['failed', 'cancelled'].includes(mission.parentStatus)
  ) {
    await runner.call(
      mission.parentWorkspaceId,
      mission.parentTaskId,
      'coding.missions.write',
      `${base}/seal`,
      { generation: mission.generation }
    );
    await store.acknowledgeCodingMissionRunner(
      mission.userId,
      mission.id,
      mission.generation,
      true
    );
    return;
  }
  const stopped =
    mission.phase !== 'cancelled'
      ? await store.cancelCodingMission(mission.userId, mission.id)
      : mission;
  if (!stopped) return;
  await runner.call(
    stopped.parentWorkspaceId,
    stopped.parentTaskId,
    'coding.missions.write',
    `${base}/cancel`,
    { generation: stopped.generation, childWorkspaceId: stopped.childWorkspaceId }
  );
  await store.acknowledgeCodingMissionRunner(stopped.userId, stopped.id, stopped.generation, true);
}

export async function runCodingMissionLoop(options: {
  store: DataStore;
  runnerBaseUrl: string;
  runnerSecret: string;
  signal: AbortSignal;
  onError: (error: unknown) => void;
}): Promise<void> {
  const runner = new AgentRunnerClient(options.runnerBaseUrl, options.runnerSecret);
  while (!options.signal.aborted) {
    try {
      for (const mission of await options.store.codingMissionsNeedingSync()) {
        if (options.signal.aborted) break;
        try {
          await reconcileCodingMission(options.store, runner, mission);
        } catch (error) {
          options.onError(error);
        }
      }
      await options.store.wakeCodingMissionParents();
    } catch (error) {
      options.onError(error);
    }
    await new Promise<void>((resolve) => {
      const finish = () => {
        runtimeClearTimer(timer);
        options.signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = runtimeSetTimeout(finish, 2000);
      options.signal.addEventListener('abort', finish, { once: true });
      if (options.signal.aborted) finish();
    });
  }
}
