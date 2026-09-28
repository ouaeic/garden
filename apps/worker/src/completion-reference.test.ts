import { describe, expect, it } from 'vitest';
import type { ModelToolCall } from '@garden/model-gateway';
import { completionVerification, processObservation } from './completion.js';
import type { AgentState } from './agent-state.js';

const task = { id: 'task', workspaceId: 'workspace' };
const job = `job_${'a'.repeat(64)}`;
const call: ModelToolCall = {
  id: 'call-verify',
  name: 'shell',
  arguments: { executable: 'python3', args: ['verify.py'] }
};
const result = {
  sessionId: job,
  ownerTaskId: task.id,
  workspaceId: task.workspaceId,
  status: 'completed',
  exitCode: 0
};
const state = (rows: NonNullable<AgentState['turnToolResults']>): AgentState => ({
  messages: [],
  step: 1,
  credits: 0,
  turnToolResults: rows
});
const verify = (value: AgentState, reference: string) =>
  completionVerification(value, { status: 'verified', evidence: [reference] });

describe('completion process references', () => {
  it('uses the exact native receipt when a completed process ID is cited', () => {
    const observation = processObservation(task, call, result);
    expect(observation).not.toBeNull();
    const checked = verify(
      state({ [call.id]: { name: call.name, success: true, mutating: true, ...observation } }),
      job
    );
    expect(checked).toMatchObject({
      ok: true,
      verification: { evidence: [{ toolCallId: call.id }] }
    });
  });
  it('refuses ongoing, failed, foreign and untrusted process identities', () => {
    for (const altered of [
      { status: 'running', exitCode: null },
      { exitCode: 1 },
      { timedOut: true }
    ]) {
      const observation = processObservation(task, call, { ...result, ...altered });
      expect(
        verify(state({ [call.id]: { name: call.name, success: true, ...observation } }), job).ok
      ).toBe(false);
    }
    expect(processObservation(task, call, { ...result, ownerTaskId: 'foreign' })).toBeNull();
    expect(processObservation(task, call, { ...result, workspaceId: 'foreign' })).toBeNull();
    expect(processObservation(task, { ...call, name: 'file_read' }, result)).toBeNull();
    expect(verify(state({}), job).ok).toBe(false);
  });
  it('keeps the normal freshness rule and rejects a later observed restart or failed run', () => {
    const completed = { name: 'shell', success: true, ...processObservation(task, call, result) };
    expect(
      verify(
        state({ old: completed, edit: { name: 'file_write', success: true, mutating: true } }),
        job
      ).ok
    ).toBe(false);
    expect(
      verify(
        state({
          old: completed,
          restarted: {
            name: 'process',
            success: true,
            ...processObservation(
              task,
              { ...call, name: 'process' },
              { ...result, status: 'running', exitCode: null }
            )
          }
        }),
        job
      ).ok
    ).toBe(false);
    expect(verify(state({ old: { ...completed, skipped: true } }), job).ok).toBe(false);
  });
});
