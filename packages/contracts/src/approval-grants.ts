import { z } from 'zod';

const entries = z
  .array(
    z
      .string()
      .min(1)
      .max(512)
      .refine(
        (value) =>
          [...value].every((character) => {
            const code = character.codePointAt(0) ?? 0;
            return (
              code >= 32 &&
              !(code >= 127 && code <= 159) &&
              !(code >= 8234 && code <= 8238) &&
              !(code >= 8294 && code <= 8297)
            );
          }),
        'Permission labels must not contain control characters'
      )
  )
  .max(12);
export const TaskApprovalScope = z
  .object({
    tool: z.enum(['shell', 'parallel_web_read', 'file_write', 'file_patch', 'code_diagnostics']),
    permissions: z
      .array(z.enum(['network', 'push', 'commands', 'files', 'install', 'analysis']))
      .min(1)
      .max(6),
    programs: entries,
    origins: entries,
    directories: entries
  })
  .strict();
export type TaskApprovalScope = z.infer<typeof TaskApprovalScope>;

export const canonicalApprovalScope = (scope: TaskApprovalScope): string =>
  JSON.stringify({
    tool: scope.tool,
    permissions: [...new Set(scope.permissions)].sort(),
    programs: [...new Set(scope.programs)].sort(),
    origins: [...new Set(scope.origins)].sort(),
    directories: [...new Set(scope.directories)].sort()
  });

export const describeApprovalScope = (scope: TaskApprovalScope): string =>
  [
    scope.permissions.includes('network')
      ? scope.tool === 'shell'
        ? 'Network commands'
        : 'Web reads'
      : '',
    scope.permissions.includes('push') ? 'Pushing Git changes' : '',
    scope.permissions.includes('commands') ? 'Local commands' : '',
    scope.permissions.includes('install') ? 'Install or update software' : '',
    scope.permissions.includes('files')
      ? scope.tool === 'file_patch'
        ? 'Apply file patches'
        : 'Create or replace files'
      : '',
    scope.permissions.includes('analysis') ? 'Code analysis' : '',
    scope.programs.length ? `using ${scope.programs.join(', ')}` : '',
    scope.origins.length ? `referencing ${scope.origins.join(', ')}` : '',
    scope.directories.length ? `in ${scope.directories.join(', ')}` : ''
  ]
    .filter(Boolean)
    .join(' · ');

export const TaskApprovalOffer = z
  .object({
    scope: TaskApprovalScope,
    turn: z.number().int().nonnegative(),
    securityMode: z.enum(['review', 'balanced', 'autonomous'])
  })
  .strict();
export type TaskApprovalOffer = z.infer<typeof TaskApprovalOffer>;

/**
 * Whether a permission the owner gave covers a call asking for `requested`: the same tool, and
 * nothing beyond what was allowed - no permission, site or program it did not name, and only
 * folders inside the ones it did. Reaching a site is about the site, so a grant that is only for
 * network access holds whichever program makes the request; every other kind holds only the
 * programs it was given for.
 */
export const approvalScopeCovers = (
  granted: TaskApprovalScope,
  requested: TaskApprovalScope
): boolean => {
  if (granted.tool !== requested.tool) return false;
  const within = (inner: readonly string[], outer: readonly string[]) =>
    inner.every((entry) => outer.includes(entry));
  const onlyNetwork = requested.permissions.every((permission) => permission === 'network');
  return (
    within(requested.permissions, granted.permissions) &&
    within(requested.origins, granted.origins) &&
    (onlyNetwork || within(requested.programs, granted.programs)) &&
    requested.directories.every((directory) =>
      granted.directories.some(
        (allowed) => directory === allowed || directory.startsWith(`${allowed}/`)
      )
    )
  );
};
