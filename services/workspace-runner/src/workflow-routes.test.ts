import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { capabilityAudience, signCapabilityToken } from '@athanor/core';
import { authenticateRunnerRequest } from './auth.js';
import { registerWorkflowRoutes } from './workflow-routes.js';
import type { WorkflowManager } from './workflows.js';
describe('workflow route authority', () => {
  it('requires execution scope and a task for starts/resumes, and isolates plan reads', async () => {
    const workspaceId = randomUUID(),
      workflowId = randomUUID(),
      secret = 'workflow-secret-at-least-thirty-two-characters',
      url = `/v1/workspaces/${workspaceId}/workflows`;
    const app = Fastify(),
      act = vi.fn(async () => ({})),
      plan = vi.fn(async () => ({})),
      resumeByOwner = vi.fn(async () => ({}));
    app.addHook('preHandler', authenticateRunnerRequest(secret));
    registerWorkflowRoutes(app, { act, plan, resumeByOwner } as unknown as WorkflowManager);
    const auth = (
      scopes: string[],
      role: 'user' | 'agent' = 'agent',
      workspace = workspaceId,
      route = url,
      method = 'POST'
    ) => ({
      authorization: `Bearer ${signCapabilityToken({ sub: 'task', workspaceId: workspace, role, scopes, nonce: randomUUID(), aud: capabilityAudience(method, route) }, secret, 60)}`
    });
    try {
      for (const action of ['start', 'resume', 'cancel']) {
        const request =
          action === 'start'
            ? { action, name: 'analysis', script: 'main.nf' }
            : { action, workflowId };
        expect(
          (
            await app.inject({
              method: 'POST',
              url,
              headers: auth(['files.read']),
              payload: { request, requestId: 'call' }
            })
          ).statusCode
        ).toBeGreaterThanOrEqual(400);
        if (action !== 'cancel')
          expect(
            (
              await app.inject({
                method: 'POST',
                url,
                headers: auth(['exec'], 'user'),
                payload: { request, requestId: 'call' }
              })
            ).statusCode
          ).toBeGreaterThanOrEqual(400);
      }
      expect(act).not.toHaveBeenCalled();
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: auth(['exec']),
            payload: {
              request: { action: 'start', name: 'analysis', script: 'main.nf' },
              requestId: 'call'
            }
          })
        ).statusCode
      ).toBe(200);
      expect(act).toHaveBeenLastCalledWith(
        workspaceId,
        'task',
        expect.objectContaining({ action: 'start' }) as unknown,
        'call'
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: auth(['files.read'], 'user'),
            payload: { request: { action: 'status', workflowId } }
          })
        ).statusCode
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: auth(['exec'], 'agent', randomUUID()),
            payload: {
              request: { action: 'start', name: 'x', script: 'main.nf' },
              requestId: 'call'
            }
          })
        ).statusCode
      ).toBeGreaterThanOrEqual(400);
      const target = `${url}/${workflowId}/plan`;
      expect(
        (
          await app.inject({
            method: 'GET',
            url: target,
            headers: auth(['files.read'], 'user', workspaceId, target, 'GET')
          })
        ).statusCode
      ).toBeGreaterThanOrEqual(400);
      expect(plan).not.toHaveBeenCalled();
      expect(
        (
          await app.inject({
            method: 'GET',
            url: target,
            headers: auth(['files.read'], 'agent', workspaceId, target, 'GET')
          })
        ).statusCode
      ).toBe(200);
      expect(plan).toHaveBeenLastCalledWith(workspaceId, 'task', workflowId);
      const resumeUrl = `${url}/${workflowId}/resume`;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: resumeUrl,
            headers: auth(['exec'], 'agent', workspaceId, resumeUrl),
            payload: { attempt: 1 }
          })
        ).statusCode
      ).toBeGreaterThanOrEqual(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: resumeUrl,
            headers: auth(['files.read'], 'user', workspaceId, resumeUrl),
            payload: { attempt: 1 }
          })
        ).statusCode
      ).toBeGreaterThanOrEqual(400);
      expect(resumeByOwner).not.toHaveBeenCalled();
      expect(
        (
          await app.inject({
            method: 'POST',
            url: resumeUrl,
            headers: auth(['exec'], 'user', workspaceId, resumeUrl),
            payload: { attempt: 1 }
          })
        ).statusCode
      ).toBe(200);
      expect(resumeByOwner).toHaveBeenLastCalledWith(workspaceId, workflowId, 1);
    } finally {
      await app.close();
    }
  });
});
