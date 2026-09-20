import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { capabilityAudience, signCapabilityToken } from '@athanor/core';
import { authenticateRunnerRequest } from './auth.js';
import { registerComputationRoutes } from './computation-routes.js';
import type { ComputationManager } from './computation.js';
describe('signed computation route authority', () => {
  it('keeps read scopes and owner controls separate from task execution', async () => {
    const workspaceId = randomUUID(),
      secret = 'computation-secret-at-least-thirty-two-characters',
      url = `/v1/workspaces/${workspaceId}/computation`;
    const app = Fastify(),
      act = vi.fn(async () => ({ state: 'idle' })),
      list = vi.fn(() => []);
    app.addHook('preHandler', authenticateRunnerRequest(secret));
    registerComputationRoutes(app, {
      act,
      list,
      refreshResources: vi.fn(async () => undefined)
    } as unknown as ComputationManager);
    const auth = (
      scopes: string[],
      role: 'user' | 'agent' = 'agent',
      workspace = workspaceId,
      method = 'POST'
    ) => ({
      authorization: `Bearer ${signCapabilityToken({ sub: 'task', workspaceId: workspace, role, scopes, nonce: randomUUID(), aud: capabilityAudience(method, url) }, secret, 60)}`
    });
    try {
      for (const action of ['start', 'cell', 'checkpoint', 'restore', 'interrupt', 'stop'])
        expect(
          (
            await app.inject({
              method: 'POST',
              url,
              headers: auth(['files.read']),
              payload: { action }
            })
          ).statusCode
        ).toBeGreaterThanOrEqual(400);
      for (const action of ['start', 'cell', 'checkpoint', 'restore'])
        expect(
          (
            await app.inject({
              method: 'POST',
              url,
              headers: auth(['exec'], 'user'),
              payload: { action }
            })
          ).statusCode
        ).toBeGreaterThanOrEqual(400);
      expect(act).not.toHaveBeenCalled();
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: auth(['exec']),
            payload: { action: 'cell', sessionId: 'session', cellId: 'cell', code: '42' }
          })
        ).statusCode
      ).toBe(200);
      expect(act).toHaveBeenLastCalledWith(
        workspaceId,
        'task',
        expect.objectContaining({ code: '42' }) as unknown
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: auth(['exec'], 'user'),
            payload: { action: 'stop', sessionId: 'session' }
          })
        ).statusCode
      ).toBe(200);
      expect(act).toHaveBeenLastCalledWith(
        workspaceId,
        null,
        expect.objectContaining({ action: 'stop' }) as unknown
      );
      expect(
        (
          await app.inject({
            method: 'GET',
            url,
            headers: auth(['files.read'], 'user', workspaceId, 'GET')
          })
        ).statusCode
      ).toBe(200);
      expect(list).toHaveBeenCalledWith(workspaceId, null);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: auth(['exec'], 'agent', randomUUID()),
            payload: { action: 'start' }
          })
        ).statusCode
      ).toBeGreaterThanOrEqual(400);
      expect(act).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});
