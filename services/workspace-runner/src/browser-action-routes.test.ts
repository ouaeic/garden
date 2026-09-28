import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { capabilityAudience, signCapabilityToken } from '@garden/core';
import { authenticateRunnerRequest } from './auth.js';
import { registerBrowserActionRoutes } from './browser-action-routes.js';
import type { BrowserManager } from './browser.js';

it('keeps receipt reads bound to the workspace, actor and task while enforcing action scopes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-receipt-route-'));
  const app = Fastify();
  const secret = 'browser-receipt-route-secret-at-least-32';
  const workspaceId = randomUUID(),
    id = 'c'.repeat(64);
  const base = `/v1/workspaces/${workspaceId}/browser`;
  const act = vi.fn<(workspace: string) => Promise<{ url: string; title: string; tabId: string }>>(
    async () => ({
      url: 'https://forms.invalid/receipt',
      title: 'Received',
      tabId: 'tab-unique'
    })
  );
  app.addHook('preHandler', authenticateRunnerRequest(secret));
  registerBrowserActionRoutes(
    app,
    root,
    { act } as unknown as BrowserManager,
    secret,
    async () => ({
      hostStorageTotalBytes: 100 * 1024 ** 3,
      hostStorageAvailableBytes: 50 * 1024 ** 3
    })
  );
  async function call(
    scopes: string[],
    body?: unknown,
    sub = 'one',
    workspace = workspaceId,
    role: 'agent' | 'user' = 'agent'
  ) {
    const method = body ? 'POST' : 'GET';
    const url = body ? base + '/action' : base + '/receipts/' + id;
    return app.inject({
      method,
      url,
      ...(body ? { payload: body } : {}),
      headers: {
        authorization:
          'Bearer ' +
          signCapabilityToken(
            {
              sub,
              workspaceId: workspace,
              role,
              scopes,
              aud: capabilityAudience(method, url),
              nonce: randomUUID()
            },
            secret,
            60
          )
      }
    });
  }
  try {
    expect(
      (await call(['browser.read'], { type: 'click', selector: '#submit', requestId: id }))
        .statusCode
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await call(['browser.control'], {
          type: 'screenshot',
          path: 'workspace/a.png',
          requestId: id
        })
      ).statusCode
    ).toBeGreaterThanOrEqual(400);
    expect(act).not.toHaveBeenCalled();
    for (let n = 0; n < 2; n++)
      expect(
        (
          await call(['browser.control', 'browser.consequential'], {
            type: 'click',
            selector: '#submit',
            requestId: id
          })
        ).statusCode
      ).toBe(200);
    expect(act).toHaveBeenCalledOnce();
    expect(act.mock.calls[0]?.[0]).toBe(workspaceId);
    expect((await call(['browser.read'])).json()).toMatchObject({
      receipt: { requestId: id, status: 'completed', result: { title: 'Received' } }
    });
    expect((await call(['browser.read'], undefined, 'two')).json()).toEqual({ receipt: null });
    expect((await call(['browser.read'], undefined, 'one', workspaceId, 'user')).json()).toEqual({
      receipt: null
    });
    expect(
      (await call(['browser.read'], undefined, 'one', randomUUID())).statusCode
    ).toBeGreaterThanOrEqual(400);
    expect((await call(['files.read'])).statusCode).toBeGreaterThanOrEqual(400);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
