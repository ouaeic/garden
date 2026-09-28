import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { capabilityAudience, signCapabilityToken } from '@garden/core';
import { authenticateRunnerRequest } from './auth.js';
import { registerCodeIntelligenceRoutes } from './code-intelligence-routes.js';
import type { CodeIntelligenceManager } from './code-intelligence.js';

describe('signed code intelligence routes', () => {
  it('requires exec for launch/stop and workspace-bound read authority for queries', async () => {
    const workspaceId = '00000000-0000-4000-8000-000000000001';
    const secret = 'code-intelligence-test-secret-at-least-thirty-two';
    const url = `/v1/workspaces/${workspaceId}/code-intelligence`;
    const app = Fastify();
    const act = vi.fn(async () => ({ running: true }));
    app.addHook('preHandler', authenticateRunnerRequest(secret));
    registerCodeIntelligenceRoutes(app, '/tmp/code', { act } as unknown as CodeIntelligenceManager);
    const auth = (scopes: string[], workspace = workspaceId) => ({
      authorization: `Bearer ${signCapabilityToken({ sub: 'task-1', workspaceId: workspace, role: 'agent', scopes, nonce: randomUUID(), aud: capabilityAudience('POST', url) }, secret, 60)}`
    });
    try {
      for (const action of ['start', 'stop']) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url,
              headers: auth(['files.read']),
              payload: { action, language: 'python' }
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
            payload: { action: 'start', language: 'python' }
          })
        ).statusCode
      ).toBe(200);
      expect(act).toHaveBeenLastCalledWith(`/tmp/code/${workspaceId}`, 'task-1', {
        action: 'start',
        language: 'python',
        root: 'workspace'
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: auth(['files.read']),
            payload: { action: 'diagnostics', language: 'python', path: 'a.py' }
          })
        ).statusCode
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: auth(['exec'], '00000000-0000-4000-8000-000000000002'),
            payload: { action: 'start', language: 'python' }
          })
        ).statusCode
      ).toBeGreaterThanOrEqual(400);
      expect(act).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});
