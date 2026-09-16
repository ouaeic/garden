import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signCapabilityToken, capabilityAudience } from '@athanor/core';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { listenProcessSupervisor, connectProcessSupervisor } from './process-supervisor.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  vi.unstubAllEnvs();
});

describe('process lifetime independent of request-serving', () => {
  it('keeps one real job alive across runner replacement and retains its exit receipt', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'garden-supervisor-'));
    cleanup.push(() => rm(base, { recursive: true, force: true }));
    const workspaceId = '00000000-0000-4000-8000-000000000001';
    const root = path.join(base, workspaceId);
    await mkdir(path.join(root, 'workspace'), { recursive: true });
    const secret = 'supervisor-proof-secret-with-at-least-32-characters';
    vi.stubEnv('WORKSPACE_ROOT', base);
    vi.stubEnv('RUNNER_SHARED_SECRET', secret);
    vi.stubEnv('JOB_SUPERVISOR_SOCKET', path.join(base, 'control.sock'));
    vi.stubEnv('ISOLATE_AGENT_NETWORK', 'false');
    vi.stubEnv('CONFINE_AGENT_FILESYSTEM', 'false');
    vi.stubEnv('BROWSER_USE_DESKTOP_DISPLAY', 'false');
    const config = loadConfig();
    const supervisor = await listenProcessSupervisor(config);
    cleanup.push(() => supervisor.close());
    let runner = await buildServer(config);
    cleanup.push(() => runner.close());
    const endpoint = `/v1/workspaces/${workspaceId}/processes/start`;
    const token = signCapabilityToken(
      {
        sub: 'task-1',
        workspaceId,
        role: 'agent',
        scopes: ['exec'],
        aud: capabilityAudience('POST', endpoint),
        nonce: 'start-once'
      },
      secret
    );
    const launch = await runner.inject({
      method: 'POST',
      url: endpoint,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        executable: process.execPath,
        args: [
          '-e',
          "const fs=require('fs');fs.appendFileSync('launches.txt',process.pid+'\\n');console.log('pid='+process.pid);setTimeout(()=>{fs.writeFileSync('done.txt','complete');console.log('completed')},1800)"
        ],
        job: 'Continuity proof'
      }
    });
    expect(launch.statusCode, launch.body).toBe(200);
    const { sessionId } = launch.json<{ sessionId: string }>();
    expect(sessionId).toBeTruthy();
    const client = connectProcessSupervisor(config.JOB_SUPERVISOR_SOCKET!, secret);
    await expect
      .poll(() => readFile(path.join(root, 'workspace/launches.txt'), 'utf8'), { timeout: 5000 })
      .toMatch(/^\d+\n$/);
    const identity = await readFile(path.join(root, 'workspace/launches.txt'), 'utf8');
    await runner.close();
    runner = await buildServer(config);
    await expect
      .poll(
        async () =>
          (await client.action(workspaceId, 'task-1', sessionId, { action: 'poll' })).status,
        { timeout: 10_000 }
      )
      .toBe('completed');
    const result = await client.action(workspaceId, 'task-1', sessionId, { action: 'log' });
    expect(result.stdout).toContain(`pid=${identity.trim()}`);
    expect(result.stdout).toContain('completed');
    expect(await readFile(path.join(root, 'workspace/launches.txt'), 'utf8')).toBe(identity);
    expect(await readFile(path.join(root, 'workspace/done.txt'), 'utf8')).toBe('complete');
    await expect(
      connectProcessSupervisor(config.JOB_SUPERVISOR_SOCKET!, 'incorrect').backgroundWork()
    ).rejects.toThrow('Unauthorized');
    await expect(
      client.action('00000000-0000-4000-8000-000000000002', 'another-task', sessionId, {
        action: 'poll'
      })
    ).rejects.toThrow();
  }, 30_000);
});
