import { runtimeValue } from '@athanor/core';
import { textValue } from './values.js';
import { createHmac } from 'node:crypto';
import { posix } from 'node:path';
import { canonicalApprovalScope, TaskApprovalScope } from '@athanor/contracts';
import { reachOfHttpUrl, unwrapDataKey } from '@athanor/core';
import type { TaskRecord } from '@athanor/data';
import {
  callDestinations,
  effectiveCommands,
  reachesAnUnreadableFarEnd
} from './command-classification.js';
import { writtenPaths } from './write-classification.js';
import type { ApprovalRequirement } from './approval-common.js';
import type { ApprovalFloorDeps } from './approval-floor.js';
import type { AgentState } from './agent-state.js';

/** Only explicit policy branches may offer reusable authority. */
export const withTaskApproval = (
  requirement: ApprovalRequirement,
  tool: string,
  args: Record<string, unknown>,
  permission: TaskApprovalScope['permissions'][number]
): ApprovalRequirement => {
  if (requirement.sideEffect === 'external_consequential') return requirement;
  if (permission === 'commands' && args.network !== false) return requirement;
  if (tool === 'shell' && reachesAnUnreadableFarEnd(args)) return requirement;
  const addresses = callDestinations(tool, args);
  const origins: string[] = [];
  for (const address of addresses) {
    try {
      const url = new URL(address);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        reachOfHttpUrl(address) !== 'internet'
      )
        return requirement;
      origins.push(url.origin);
    } catch {
      return requirement;
    }
  }
  if (permission === 'network' && !origins.length) return requirement;
  const directProgram = textValue(args.executable).split('/').pop() ?? '';
  const directInterpreter =
    /^(?:sh|bash|dash|zsh|python(?:[0-9](?:\.[0-9]+)?)?|node|nodejs|ruby|perl|Rscript|R|julia|php)$/.test(
      directProgram
    );
  const programs =
    tool !== 'shell'
      ? []
      : directInterpreter
        ? [directProgram]
        : effectiveCommands(args).map(([program]) => program ?? '');
  if (tool === 'shell' && (!programs.length || programs.some((program) => !program)))
    return requirement;
  const paths =
    permission === 'files'
      ? writtenPaths(tool, args)
      : permission === 'analysis'
        ? [textValue(args.path, 'workspace')]
        : [];
  if (
    paths.some(
      (path) =>
        path !== posix.normalize(path) ||
        !(
          path === 'workspace' ||
          path.startsWith('workspace/') ||
          path.startsWith('.athanor/artifacts/')
        )
    )
  )
    return requirement;
  if (permission === 'files' && !paths.length) return requirement;
  const parsed = TaskApprovalScope.safeParse({
    tool,
    permissions:
      origins.length && permission !== 'network' ? [permission, 'network'] : [permission],
    programs: [...new Set(programs)].sort(),
    origins: [...new Set(origins)].sort(),
    directories: [
      ...new Set(paths.map((path) => (permission === 'files' ? posix.dirname(path) : path)))
    ].sort()
  });
  return parsed.success ? { ...requirement, taskGrant: parsed.data } : requirement;
};

export const mergeTaskApproval = (
  left: TaskApprovalScope | undefined,
  right: TaskApprovalScope | undefined
): TaskApprovalScope | undefined => {
  if (!left || !right || left.tool !== right.tool) return undefined;
  const parsed = TaskApprovalScope.safeParse({
    tool: left.tool,
    permissions: [...new Set([...left.permissions, ...right.permissions])].sort(),
    programs: [...new Set([...left.programs, ...right.programs])].sort(),
    origins: [...new Set([...left.origins, ...right.origins])].sort(),
    directories: [...new Set([...left.directories, ...right.directories])].sort()
  });
  return parsed.success ? parsed.data : undefined;
};

/** Fresh indexed lookup: a revoked grant must not survive in a worker cache or a copied state. */
export const useTaskApproval = async (
  deps: ApprovalFloorDeps,
  task: TaskRecord,
  state: AgentState | undefined,
  requirement: ApprovalRequirement
): Promise<boolean> => {
  if (
    !state ||
    task.parentMissionId ||
    !requirement.taskGrant ||
    requirement.sideEffect === 'external_consequential'
  )
    return false;
  const workspace = await deps.store.getWorkspaceById(task.workspaceId);
  if (!workspace?.wrappedKey) return false;
  const key = unwrapDataKey(workspace.wrappedKey, deps.masterKey, workspace.id);
  const scope = canonicalApprovalScope(requirement.taskGrant);
  const hash = runtimeValue(`approval.scope:${scope}`, () =>
    createHmac('sha256', key).update(scope).digest('hex')
  );
  return deps.store.hasTaskApprovalGrant(
    task.userId,
    task.id,
    state.turn ?? 0,
    task.securityMode,
    hash
  );
};
