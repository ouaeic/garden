/**
 * The questions the agent stopped to ask, and the answers that start it again.
 *
 * Pending is the default listing because that is the list with something to answer.
 */

import {
  APPROVAL_NOTE_MAX_CHARS,
  approvalDenialMessage,
  TaskApprovalOffer,
  canonicalApprovalScope,
  describeApprovalScope
} from '@athanor/contracts';
import { createHmac } from 'node:crypto';
import { AthanorError, decryptJson, encryptJson, unwrapDataKey } from '@athanor/core';
import { z } from 'zod';
import { textValue } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

export const registerApprovalRoutes = (context: RouteContext): void => {
  const { app, store, masterKey, idempotent } = context;
  /**
   * Pending is the default because that is the list with something to answer, but an approval
   * that lapsed is exactly what a returning owner is looking for: it explains why a task is
   * paused, and the wording of what was asked is the only record of it.
   */
  app.get<{ Querystring: { status?: string; limit?: string; cursor?: string } }>(
    '/v1/approvals',
    async (request) => {
      const user = requireUser(request.user);
      const query = z
        .object({
          status: z.enum(['pending', 'approved', 'denied', 'expired']).default('pending'),
          /*
           * The store has taken a page and a cursor since the read was bounded, and every row it
           * returns carries the `cursor` for the row after it - this route passed neither, so the
           * answer was always the first page and the cursor on every row pointed at a page nothing
           * could ask for. An owner going back through what they approved last month reached the
           * store's own ceiling and stopped there, with no way to say "keep going".
           */
          limit: z.coerce.number().int().min(1).max(200).optional(),
          cursor: z.string().min(1).max(200).optional()
        })
        .parse(request.query);
      const status = query.status;
      const approvals = await store.listApprovals(user.id, status, {
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor })
      });
      return Promise.all(
        approvals.map(async (approval) => {
          const task = await store.getTask(user.id, String(approval.taskId));
          const workspace = task ? await store.getWorkspace(user.id, task.workspaceId) : null;
          if (!workspace?.wrappedKey)
            return { ...approval, preview: '[unavailable]', previewCiphertext: undefined };
          const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
          const decryptedPreview = decryptJson<Record<string, unknown>>(
            approval.previewCiphertext as Parameters<typeof decryptJson>[0],
            key,
            `approval:${String(approval.taskId)}`
          );
          const offered = TaskApprovalOffer.safeParse(decryptedPreview.taskGrant);
          return {
            ...approval,
            action: textValue(decryptedPreview.action, textValue(approval.action)),
            preview: {
              ...decryptedPreview,
              securityMode: task?.securityMode,
              taskGrant:
                approval.sideEffect !== 'external_consequential' &&
                offered.success &&
                offered.data.scope.tool === decryptedPreview.tool &&
                offered.data.securityMode === task?.securityMode &&
                !task?.parentMissionId
                  ? { ...offered.data, description: describeApprovalScope(offered.data.scope) }
                  : undefined
            },
            previewCiphertext: undefined
          };
        })
      );
    }
  );

  app.post<{ Params: { approvalId: string; decision: string } }>(
    '/v1/approvals/:approvalId/:decision',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const decision = z.enum(['approve', 'deny']).parse(request.params.decision);
        const input = (
          decision === 'deny'
            ? z.object({ note: z.string().max(APPROVAL_NOTE_MAX_CHARS).optional() }).strict()
            : z.object({ scope: z.enum(['once', 'run']).optional() }).strict()
        ).parse(request.body ?? {});
        const approval = await store.getApproval(request.params.approvalId);
        if (!approval || approval.userId !== user.id)
          throw new AthanorError(
            'approval_unavailable',
            'Approval is missing, resolved, or expired'
          );
        if (
          decision === 'approve' &&
          approval.action === 'secure_input_handoff' &&
          approval.status === 'approved'
        )
          return { ok: true };
        const note = approvalDenialMessage({
          tool: textValue(approval.action),
          ...('note' in input && typeof input.note === 'string' ? { note: input.note } : {})
        });
        let correction: Parameters<typeof store.resolveApproval>[3];
        let grant: Parameters<typeof store.resolveApproval>[4];
        if ('scope' in input && input.scope === 'run') {
          if (request.apiToken)
            throw new AthanorError(
              'approval_grant_owner_required',
              'Reusable permissions require the owner’s session',
              403
            );
          const task = await store.getTask(user.id, String(approval.taskId));
          const workspace = task ? await store.getWorkspace(user.id, task.workspaceId) : null;
          if (
            !task ||
            task.parentMissionId ||
            approval.sideEffect === 'external_consequential' ||
            !workspace?.wrappedKey ||
            !task.agentStateCiphertext
          )
            throw new AthanorError(
              'approval_grant_unavailable',
              'This action supports approval once only',
              409
            );
          const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
          const preview = decryptJson<Record<string, unknown>>(
            approval.previewCiphertext as Parameters<typeof decryptJson>[0],
            key,
            `approval:${task.id}`
          );
          const offer = TaskApprovalOffer.safeParse(preview.taskGrant);
          const state = decryptJson<{ turn?: number }>(
            task.agentStateCiphertext,
            key,
            `task-state:${task.id}`
          );
          if (
            !offer.success ||
            offer.data.scope.tool !== preview.tool ||
            offer.data.turn !== (state.turn ?? 0) ||
            offer.data.securityMode !== task.securityMode
          )
            throw new AthanorError(
              'approval_grant_unavailable',
              'This permission no longer matches the current run',
              409
            );
          grant = {
            turn: offer.data.turn,
            securityMode: offer.data.securityMode,
            scopeHash: createHmac('sha256', key)
              .update(canonicalApprovalScope(offer.data.scope))
              .digest('hex'),
            scopeCiphertext: encryptJson(
              offer.data.scope,
              key,
              `task-approval:${task.id}:${request.params.approvalId}`
            )
          };
        }
        if (note) {
          const task = await store.getTask(user.id, String(approval.taskId));
          const workspace = task ? await store.getWorkspace(user.id, task.workspaceId) : null;
          if (!task || !workspace?.wrappedKey)
            throw new AthanorError('approval_unavailable', 'Approval workspace is unavailable');
          const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
          correction = {
            promptCiphertext: encryptJson({ prompt: note }, key, `task-message:${task.id}`),
            queuedEventCiphertext: encryptJson({ markdown: note }, key, `task-event:${task.id}`)
          };
        }
        if (
          decision === 'approve' &&
          approval.action === 'secure_input_handoff' &&
          approval.status === 'pending'
        ) {
          if (request.apiToken)
            throw new AthanorError(
              'session_required',
              'Complete the handoff from a signed-in device',
              403
            );
          const task = await store.getTask(user.id, String(approval.taskId));
          const workspace = task ? await store.getWorkspace(user.id, task.workspaceId) : null;
          if (!task || !workspace?.wrappedKey)
            throw new AthanorError('approval_unavailable', 'Handoff workspace unavailable', 409);
          const preview = decryptJson<{ tool: string }>(
            approval.previewCiphertext as Parameters<typeof decryptJson>[0],
            unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id)
          );
          const surface = preview.tool === 'desktop_action' ? 'desktop' : 'browser';
          const sessions = await context.runner.request<{
            browser: { holder: string } | null;
            desktop: { holder: string } | null;
          }>({
            workspaceId: workspace.id,
            userId: user.id,
            role: 'user',
            scopes: ['browser.read', 'desktop.read'],
            path: `/v1/workspaces/${workspace.id}/computer-sessions`
          });
          if (sessions[surface]?.holder === 'secure_input')
            throw new AthanorError(
              'private_input_active',
              'End private input before continuing',
              409
            );
          if (!sessions[surface])
            throw new AthanorError(
              'handoff_unavailable',
              'Open the computer and complete the requested action first',
              409
            );
          await context.runner.request({
            workspaceId: workspace.id,
            userId: user.id,
            role: 'user',
            scopes: [`${surface}.takeover`],
            path: `/v1/workspaces/${workspace.id}/${surface}/holder`,
            method: 'POST',
            body: JSON.stringify({ holder: 'agent' }),
            contentType: 'application/json'
          });
        }
        const settlement: [
          Parameters<typeof store.resolveApproval>[3]?,
          Parameters<typeof store.resolveApproval>[4]?
        ] = grant ? [undefined, grant] : correction ? [correction] : [];
        const changed = await store.resolveApproval(
          user.id,
          request.params.approvalId,
          decision === 'approve' ? 'approved' : 'denied',
          ...settlement
        );
        if (!changed)
          throw new AthanorError(
            'approval_unavailable',
            'Approval is missing, resolved, or expired'
          );
        return { ok: true };
      });
    }
  );

  app.get<{ Params: { taskId: string }; Querystring: { before?: string } }>(
    '/v1/approvals/tasks/:taskId/permissions',
    async (request) => {
      const user = requireUser(request.user);
      const { before } = z.object({ before: z.string().uuid().optional() }).parse(request.query);
      const task = await store.getTask(user.id, request.params.taskId);
      if (!task) throw new AthanorError('task_not_found', 'Work not found', 404);
      const workspace = await store.getWorkspace(user.id, task.workspaceId);
      if (!workspace?.wrappedKey || !task.agentStateCiphertext) return [];
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      const state = decryptJson<{ turn?: number }>(
        task.agentStateCiphertext,
        key,
        `task-state:${task.id}`
      );
      const grants = await store.listTaskApprovalGrants(user.id, task.id, state.turn ?? 0, before);
      return grants.map((grant) => {
        const scope = decryptJson<TaskApprovalOffer['scope']>(
          grant.scopeCiphertext,
          key,
          `task-approval:${task.id}:${grant.id}`
        );
        return {
          id: grant.id,
          description: describeApprovalScope(scope),
          createdAt: grant.createdAt
        };
      });
    }
  );
  app.post<{ Params: { taskId: string; grantId: string } }>(
    '/v1/approvals/tasks/:taskId/permissions/:grantId/revoke',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        z.object({})
          .strict()
          .parse(request.body ?? {});
        if (
          !(await store.revokeTaskApprovalGrant(
            user.id,
            request.params.taskId,
            request.params.grantId
          ))
        )
          throw new AthanorError('approval_grant_unavailable', 'Permission not found', 404);
        return { ok: true };
      });
    }
  );
};
