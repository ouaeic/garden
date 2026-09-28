import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { capabilityAudience, signCapabilityToken } from '@garden/core';
import type * as Sandbox from './sandbox.js';
const measured = vi.hoisted(() => ({ processIsolation: true, networkIsolation: true }));
vi.mock('./sandbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Sandbox>();
  return {
    ...actual,
    resolveAgentSandbox: vi.fn(async (helper: string, directory: string, confined: boolean) => {
      await mkdir(directory, { recursive: true });
      return actual.agentSandbox(helper, confined, directory);
    }),
    probeNativeIsolation: vi.fn(async () => ({ ...measured }))
  };
});
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});
it.each([
  { processIsolation: true, networkIsolation: true, available: true },
  { processIsolation: true, networkIsolation: false, available: false },
  { processIsolation: false, networkIsolation: true, available: false }
])(
  'serves measured mission capability under global false: $processIsolation / $networkIsolation',
  async (support) => {
    Object.assign(measured, support);
    const root = await realpath(await mkdtemp('/tmp/garden-isolation-server-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const secret = 'garden-native-capability-test-secret-longer-than-32';
    vi.stubEnv('RUNNER_SHARED_SECRET', secret);
    vi.stubEnv('WORKSPACE_ROOT', root);
    vi.stubEnv('AGENT_SANDBOX_HELPER', '/fixture/helper');
    vi.stubEnv('CONFINE_AGENT_FILESYSTEM', 'true');
    vi.stubEnv('ISOLATE_AGENT_NETWORK', 'false');
    vi.stubEnv('BROWSER_USE_DESKTOP_DISPLAY', 'false');
    vi.stubEnv('SNAPSHOT_EXECUTABLE', path.resolve('../../scripts/garden-snapshot'));
    const app = await buildServer(loadConfig());
    cleanups.push(() => app.close());
    const health = await app.inject('/healthz');
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      agentNetworkIsolated: false,
      missionProcessIsolation: support.processIsolation,
      nativeNetworkIsolation: support.networkIsolation
    });
    const url = '/v1/coding-missions/capabilities';
    const token = signCapabilityToken(
      {
        sub: randomUUID(),
        workspaceId: randomUUID(),
        role: 'agent',
        scopes: ['coding.missions.read'],
        aud: capabilityAudience('GET', url),
        nonce: randomUUID()
      },
      secret
    );
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ available: support.available });
    const denied = await app.inject({ method: 'GET', url });
    expect(denied.statusCode).toBe(400);
    expect(denied.body).toContain('Missing runner capability token');
  }
);
