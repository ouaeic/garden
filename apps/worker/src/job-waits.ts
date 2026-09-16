import { randomUUID } from 'node:crypto';
import { decryptJson, encryptJson, unwrapDataKey } from '@athanor/core';
import type { DataStore, TaskRecord } from '@athanor/data';
import type { ModelRelease, WebToolPlan } from '@athanor/contracts';
import type { ModelToolCall } from '@athanor/model-gateway';
import { z } from 'zod';
import type { AgentState } from './agent-state.js';
import type { TurnDispatchDeps } from './turn/dispatch.js';
import { AgentRunnerClient, withRunnerAbort } from './runner-client.js';

const Observation = z.object({
  sessionId: z.string(),
  startedAt: z.string(),
  status: z.enum([
    'running',
    'completed',
    'failed',
    'timed_out',
    'stopped',
    'interrupted',
    'restarting',
    'crash_looped'
  ]),
  lifetime: z.enum(['job', 'task', 'service']).optional()
});
const Dependencies = z.object({
  turn: z.number().int().nonnegative(),
  jobs: z
    .array(z.object({ sessionId: z.string().min(1).max(128), startedAt: z.string() }))
    .min(1)
    .max(32)
});

export async function parkProcessWait(
  deps: TurnDispatchDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  call: ModelToolCall,
  deferred: readonly ModelToolCall[],
  run: { model: ModelRelease; catalog: ModelRelease[]; webPlan: WebToolPlan }
): Promise<boolean> {
  const ids = z
    .array(z.string().min(1).max(128))
    .min(1)
    .max(32)
    .parse(call.arguments.sessionIds ?? [call.arguments.sessionId]);
  const observed: z.infer<typeof Observation>[] = [];
  for (const sessionId of new Set(ids)) {
    const result = await deps.resume.execute(
      task,
      { ...call, arguments: { action: 'poll', sessionId } },
      key,
      false,
      run.webPlan,
      state
    );
    const item = Observation.parse(result);
    if (item.lifetime === 'service')
      throw new Error('A service runs until stopped. Wait on a finite job instead.');
    observed.push(item);
  }
  const waiting = observed.some(
    (item) => item.status === 'running' || item.status === 'restarting'
  );
  await deps.recordToolResult(
    task,
    key,
    state,
    call,
    {
      waiting,
      processes: observed,
      instruction: waiting
        ? 'Execution will resume when these processes stop. No model polling is needed.'
        : 'These processes have stopped. Inspect their logs and outputs before interpreting the outcome.'
    },
    run.model,
    run.catalog
  );
  if (!waiting) return false;
  for (const later of deferred)
    state.messages.push({
      role: 'tool',
      toolCallId: later.id,
      content:
        'Deferred while waiting for background work. Request again after it finishes if still needed.'
    });
  delete state.inFlight;
  state.step += 1;
  const id = randomUUID();
  state.jobWaitId = id;
  await deps.store.parkTaskForJobs({
    id,
    taskId: task.id,
    workerId: deps.config.WORKER_ID,
    dependenciesCiphertext: encryptJson(
      {
        turn: state.turn ?? 0,
        jobs: observed.map(({ sessionId, startedAt }) => ({ sessionId, startedAt }))
      },
      key,
      `job-wait:${task.id}`
    ),
    agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`),
    eventCiphertext: encryptJson(
      {
        __athanorEventVersion: 1,
        summary: 'Background work is running',
        payload: { jobWait: { id, processes: observed } }
      },
      key,
      `task-event:${task.id}`
    ),
    actualComputeCredits: state.credits
  });
  return true;
}

export async function reconcileJobWaits(
  store: DataStore,
  runner: AgentRunnerClient,
  masterKey: Buffer,
  signal: AbortSignal,
  onError?: (error: unknown) => void
): Promise<number> {
  let woken = 0;
  const errors: unknown[] = [];
  for (const wait of await store.claimJobWaits()) {
    if (signal.aborted) break;
    try {
      const task = await store.getTask(wait.userId, wait.taskId);
      const workspace = await store.getWorkspaceById(wait.workspaceId);
      if (
        !task?.agentStateCiphertext ||
        !workspace?.wrappedKey ||
        task.status !== 'awaiting_resource'
      )
        continue;
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      const dependencies = Dependencies.parse(
        decryptJson(wait.dependenciesCiphertext, key, `job-wait:${task.id}`)
      );
      const state = decryptJson<AgentState>(
        task.agentStateCiphertext,
        key,
        `task-state:${task.id}`
      );
      if ((state.turn ?? 0) !== dependencies.turn || state.jobWaitId !== wait.id) continue;
      const inventory = z
        .object({ processes: z.array(z.unknown()) })
        .parse(
          await withRunnerAbort(AbortSignal.any([signal, AbortSignal.timeout(15_000)]), () =>
            runner.call(
              task.workspaceId,
              task.id,
              'exec',
              `/v1/workspaces/${task.workspaceId}/processes`
            )
          )
        );
      const outcomes = [];
      let ready = true;
      for (const job of dependencies.jobs) {
        const entry = inventory.processes.find(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            'sessionId' in item &&
            item.sessionId === job.sessionId
        );
        if (!entry) {
          outcomes.push({ ...job, status: 'missing', outcomeUnknown: true });
          continue;
        }
        const observed = Observation.parse(entry);
        const replaced = observed.startedAt !== job.startedAt;
        if (!replaced && ['running', 'restarting'].includes(observed.status)) ready = false;
        outcomes.push({ ...observed, ...(replaced ? { generationChanged: true } : {}) });
      }
      if (!ready) continue;
      // Only schema-checked process metadata enters the window. Command output is read through its normal taint path.
      delete state.jobWaitId;
      state.messages.push({
        role: 'system',
        content: `Background process wait ended: ${JSON.stringify(outcomes)}. Inspect current logs and outputs, then continue the original task. A missing, stopped, failed, interrupted or replaced process is not a successful result. Do not relaunch a command without establishing its outcome.`
      });
      const changed = await store.wakeTaskFromJobs({
        id: wait.id,
        taskId: task.id,
        expectedState: task.agentStateCiphertext,
        agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`),
        outcomeCiphertext: encryptJson(
          {
            __athanorEventVersion: 1,
            summary: 'Background work is ready to review',
            payload: { jobWait: { id: wait.id, processes: outcomes, resumed: true } }
          },
          key,
          `task-event:${task.id}`
        )
      });
      if (changed) woken += 1;
    } catch (cause) {
      // A broken workspace must not delay unrelated completed work in the same scan.
      if (onError) onError(cause);
      else errors.push(cause);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, 'Some background waits could not be inspected');
  return woken;
}

export async function runJobWaitLoop(options: {
  store: DataStore;
  runnerBaseUrl: string;
  runnerSecret: string;
  masterKey: Buffer;
  signal: AbortSignal;
  onError: (error: unknown) => void;
}): Promise<void> {
  const runner = new AgentRunnerClient(options.runnerBaseUrl, options.runnerSecret);
  while (!options.signal.aborted) {
    try {
      await reconcileJobWaits(
        options.store,
        runner,
        options.masterKey,
        options.signal,
        options.onError
      );
    } catch (cause) {
      if (!options.signal.aborted) options.onError(cause);
    }
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        options.signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, 15_000);
      options.signal.addEventListener('abort', finish, { once: true });
      if (options.signal.aborted) finish();
    });
  }
}
