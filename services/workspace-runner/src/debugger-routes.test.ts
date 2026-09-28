import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { capabilityAudience, signCapabilityToken } from '@garden/core';
import { authenticateRunnerRequest } from './auth.js';
import { registerDebuggerRoutes } from './debugger-routes.js';
import type { DebuggerManager } from './debugger.js';
describe('signed native debugger authority', () => {
  it('requires task execution authority for live operations and permits owner cached reads and stop only', async () => {
    const workspaceId = randomUUID(),
      sessionId = `debug-${randomUUID()}`,
      secret = 'debugger-test-secret-thirty-two-characters',
      url = `/v1/workspaces/${workspaceId}/debugger`;
    const app = Fastify(),
      act = vi.fn(async () => ({})),
      list = vi.fn(() => []),
      availability = vi.fn(async () => ({ python: true, javascript: true }));
    app.addHook('preHandler', authenticateRunnerRequest(secret));
    registerDebuggerRoutes(app, { act, list, availability } as unknown as DebuggerManager);
    const auth = (
      scopes: string[],
      role: 'user' | 'agent' = 'agent',
      workspace = workspaceId,
      method = 'POST'
    ) => ({
      authorization: `Bearer ${signCapabilityToken({ sub: 'task', workspaceId: workspace, role, scopes, nonce: randomUUID(), aud: capabilityAudience(method, url) }, secret, 60)}`
    });
    try {
      const launch = { action: 'launch', language: 'python', program: 'workspace/main.py' },
        evaluate = { action: 'evaluate', sessionId, epoch: 1, frameId: 1, expression: 'answer' };
      for (const payload of [launch, evaluate]) {
        expect(
          (await app.inject({ method: 'POST', url, headers: auth(['files.read']), payload }))
            .statusCode
        ).toBeGreaterThanOrEqual(400);
        expect(
          (await app.inject({ method: 'POST', url, headers: auth(['exec'], 'user'), payload }))
            .statusCode
        ).toBeGreaterThanOrEqual(400);
      }
      expect(act).not.toHaveBeenCalled();
      expect(
        (await app.inject({ method: 'POST', url, headers: auth(['exec']), payload: launch }))
          .statusCode
      ).toBe(200);
      expect(act).toHaveBeenLastCalledWith(
        workspaceId,
        'task',
        expect.objectContaining({ program: 'workspace/main.py' }) as unknown
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: auth(['exec'], 'user'),
            payload: { action: 'stop', sessionId }
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
            payload: launch
          })
        ).statusCode
      ).toBeGreaterThanOrEqual(400);
      expect(act).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});
