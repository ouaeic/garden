import type { TaskRecord } from '@athanor/data';
import type { AcceptanceCheck } from './acceptance.js';
import type { AgentRunnerClient } from './runner-client.js';

/** A narrow syntax check, not a verdict on whether arbitrary generated tests prove the task. */
export async function inspectAcceptanceChecks(
  runner: AgentRunnerClient,
  task: TaskRecord,
  checks: readonly AcceptanceCheck[]
): Promise<string[]> {
  const issues: string[] = [];
  for (const check of checks) {
    if (
      check.kind !== 'command' ||
      ![check.executable, ...check.args].some((part) => /\bpython(?:[23](?:\.\d+)?)?\b/.test(part))
    )
      continue;
    const result = await runner.call<{ inspected: number; issues: string[] }>(
      task.workspaceId,
      task.id,
      'files.read',
      `/v1/workspaces/${task.workspaceId}/acceptance/inspect`,
      { executable: check.executable, args: check.args }
    );
    issues.push(...result.issues.map((issue) => `${check.id}: ${issue}`));
  }
  return issues;
}
