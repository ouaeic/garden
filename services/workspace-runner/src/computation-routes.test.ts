import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { capabilityAudience, signCapabilityToken } from '@garden/core';
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
      for (const action of [
        'start',
        'cell',
        'checkpoint',
        'restore',
        'extend',
        'interrupt',
        'stop'
      ])
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
      for (const action of ['start', 'cell', 'checkpoint', 'restore', 'extend'])
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

describe('saved history route authority', () => {
  it('ignores agent attempts to widen history owners and enforces workspace and read scope', async () => {
    const workspaceId = randomUUID(),
      secret = 'history-test-secret-at-least-thirty-two-characters';
    const url = `/v1/workspaces/${workspaceId}/computation/history`;
    const app = Fastify();
    const history = vi.fn(async () => ({ entries: [], nextCursor: null }));
    app.addHook('preHandler', authenticateRunnerRequest(secret));
    registerComputationRoutes(app, { history } as unknown as ComputationManager);
    const auth = (role: 'agent' | 'user', scopes = ['files.read'], workspace = workspaceId) => ({
      authorization: `Bearer ${signCapabilityToken({ sub: 'task', workspaceId: workspace, role, scopes, nonce: randomUUID(), aud: capabilityAudience('GET', url) }, secret)}`
    });
    try {
      const forged = `${url}?owners=${encodeURIComponent(JSON.stringify(['other-task']))}&limit=7`;
      expect((await app.inject({ url: forged, headers: auth('agent') })).statusCode).toBe(200);
      expect(history).toHaveBeenLastCalledWith(workspaceId, ['task'], {
        cursor: undefined,
        limit: 7
      });
      expect((await app.inject({ url: forged, headers: auth('user') })).statusCode).toBe(200);
      expect(history).toHaveBeenLastCalledWith(workspaceId, ['other-task'], {
        cursor: undefined,
        limit: 7
      });
      for (const headers of [auth('agent', []), auth('user', ['files.read'], randomUUID())])
        expect((await app.inject({ url, headers })).statusCode).toBeGreaterThanOrEqual(400);
      expect(history).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});
