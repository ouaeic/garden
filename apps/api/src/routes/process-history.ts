import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AthanorError } from '@athanor/core';
import {
  ProcessHistoryQuery,
  type ComputationSession,
  type HistoryPage,
  type ManagedProcess,
  type ProjectProcessHistory
} from '@athanor/contracts';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

const Query = z
  .object({ kind: z.enum(['processes', 'computation']), cursor: z.string().max(2000).optional() })
  .strict();
const Cursor = z
  .object({
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    before: ProcessHistoryQuery.shape.cursor.unwrap()
  })
  .strict();
const PAGE = 20;

export function registerProcessHistoryRoutes({ app, store, runner }: RouteContext): void {
  for (const kind of ['task', 'project', 'workspace'] as const) {
    app.get<{ Params: { id: string } }>(`/v1/${kind}s/:id/processes/history`, async (request) => {
      const user = requireUser(request.user);
      const query = Query.parse(request.query);
      const scopes = new Map<string, Set<string> | null>();
      if (kind === 'workspace') {
        if (!(await store.getWorkspace(user.id, request.params.id)))
          throw new AthanorError('workspace_not_found', 'Workspace not found', 404);
        scopes.set(request.params.id, null);
      } else {
        const members = await store.projectExecutionMembers(user.id, request.params.id, kind);
        if (
          kind === 'project'
            ? !(await store.getProject(user.id, request.params.id))
            : !members.some((member) => member.taskId === request.params.id)
        )
          throw new AthanorError('task_not_found', 'Project not found', 404);
        for (const member of members) {
          const owners = scopes.get(member.workspaceId) ?? new Set<string>();
          owners.add(member.taskId);
          scopes.set(member.workspaceId, owners);
        }
      }
      const workspaces = [...scopes.entries()].sort(([a], [b]) => a.localeCompare(b));
      const scope = createHash('sha256')
        .update(
          JSON.stringify([
            user.id,
            kind,
            request.params.id,
            query.kind,
            workspaces.map(([id, owners]) => [id, owners ? [...owners].sort() : null])
          ])
        )
        .digest('hex');
      const cursor = query.cursor
        ? Cursor.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')))
        : undefined;
      if (cursor && cursor.scope !== scope)
        throw new AthanorError(
          'history_scope_changed',
          'Project membership changed. Refresh saved history.',
          409
        );
      const reads = workspaces.flatMap<{ workspaceId: string; owners: Set<string> | null }>(
        ([workspaceId, owners]) => {
          if (owners === null) return [{ workspaceId, owners }];
          const values = [...owners];
          return Array.from({ length: Math.ceil(values.length / 64) }, (_, index) => ({
            workspaceId,
            owners: new Set(values.slice(index * 64, (index + 1) * 64))
          }));
        }
      );
      let next = 0,
        more = false;
      let entries: { cursor: string; value: ManagedProcess | ComputationSession }[] = [];
      await Promise.all(
        Array.from({ length: Math.min(4, reads.length) }, async () => {
          while (next < reads.length) {
            const { workspaceId, owners } = reads[next++]!;
            const parameters = new URLSearchParams({ limit: String(PAGE + 1) });
            if (owners) parameters.set('owners', JSON.stringify([...owners]));
            if (cursor) parameters.set('cursor', cursor.before);
            const result = await runner.request<HistoryPage<ManagedProcess | ComputationSession>>({
              workspaceId,
              userId: user.id,
              role: 'user',
              scopes: [query.kind === 'processes' ? 'exec' : 'files.read'],
              method: 'GET',
              path: `/v1/workspaces/${workspaceId}/${query.kind}/history?${parameters}`,
              timeoutMs: 15_000
            });
            if (!Array.isArray(result.entries) || result.entries.length > PAGE + 1)
              throw new AthanorError(
                'history_unavailable',
                'Saved history could not be read completely. Try again.',
                503
              );
            for (const entry of result.entries) {
              ProcessHistoryQuery.shape.cursor.parse(entry.cursor);
              const owner = 'taskId' in entry.value ? entry.value.taskId : entry.value.ownerTaskId;
              if (
                entry.value.workspaceId !== workspaceId ||
                !owner ||
                (owners && !owners.has(owner))
              )
                throw new AthanorError(
                  'history_scope_invalid',
                  'Saved history scope could not be verified',
                  503
                );
            }
            entries = [...entries, ...result.entries].sort((a, b) =>
              b.cursor.localeCompare(a.cursor)
            );
            more ||= result.nextCursor !== null || entries.length > PAGE;
            entries = entries.slice(0, PAGE);
          }
        })
      );
      return {
        processes:
          query.kind === 'processes' ? entries.map((entry) => entry.value as ManagedProcess) : [],
        computationSessions:
          query.kind === 'computation'
            ? entries.map((entry) => entry.value as ComputationSession)
            : [],
        nextCursor:
          more && entries.length
            ? Buffer.from(JSON.stringify({ scope, before: entries.at(-1)!.cursor })).toString(
                'base64url'
              )
            : null
      } satisfies ProjectProcessHistory;
    });
  }
}
