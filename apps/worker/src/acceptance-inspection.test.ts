import { describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '@garden/data';
import type { AgentState } from './agent-state.js';
import {
  declareAcceptance,
  type AcceptanceDeclarationDeps
} from './turn/acceptance-declaration.js';
import { acceptanceChecks, type AcceptanceRunnerDeps } from './acceptance-runner.js';
import { commandFingerprint, parseAcceptanceChecks } from './acceptance.js';

const task = { id: 'task', workspaceId: 'workspace' } as TaskRecord;
const check = {
  kind: 'command',
  label: 'Result records match',
  executable: 'python3',
  args: ['-c', 'assert len(rows) == 12 or True']
};
const issue = 'Python assertion on line 1 always passes';
describe('unfalsifiable acceptance commands', () => {
  it.each([false, true])(
    'rejects the declaration before running checks, including after mutation: %s',
    async (mutatedBeyondProse) => {
      const run = vi.fn();
      const call = vi.fn(async () => ({ inspected: 1, issues: [issue] }));
      const state = { messages: [], step: 3, mutatedBeyondProse } as unknown as AgentState;
      const deps = {
        runner: { call },
        store: {},
        runAcceptanceChecks: run
      } as unknown as AcceptanceDeclarationDeps;
      await declareAcceptance(
        deps,
        task,
        new Uint8Array(32),
        state,
        { id: 'declaration', name: 'set_acceptance', arguments: { checks: [check] } },
        0
      );
      expect(run).not.toHaveBeenCalled();
      expect(state.acceptance).toBeUndefined();
      expect(state.turnToolResults?.declaration?.success).toBe(false);
      expect(state.messages.at(-1)?.content).toContain(issue);
      expect(call).toHaveBeenCalledWith(
        'workspace',
        'task',
        'files.read',
        '/v1/workspaces/workspace/acceptance/inspect',
        { executable: check.executable, args: check.args }
      );
    }
  );
  it('rechecks persisted declarations before reusing an observed successful exit', async () => {
    const parsed = parseAcceptanceChecks([check]);
    if (!parsed.ok) throw new Error(parsed.reason);
    const call = vi.fn(async () => ({ inspected: 1, issues: [issue] }));
    const deps = {
      runner: { call },
      store: { appendTaskEvent: vi.fn(async () => ({})) }
    } as unknown as AcceptanceRunnerDeps;
    const results = await acceptanceChecks(
      deps,
      task,
      new Uint8Array(32),
      { checks: parsed.checks, revisions: 1, declaredAtStep: 0 },
      {
        purpose: 'finish',
        observed: new Map([
          [
            commandFingerprint({
              executable: check.executable,
              args: check.args,
              cwd: 'workspace'
            }),
            0
          ]
        ])
      }
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.detail).toContain(issue);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
