import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ExecutionModule from './execution.js';
import type * as HostStorageModule from './host-storage.js';
import type { ComputationSession } from '@athanor/contracts';
import { ensureWorkspace } from './files.js';

vi.mock('./execution.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ExecutionModule>();
  return {
    ...actual,
    prepareInvocation: vi.fn(
      async (root: string, request: { executable: string; args: string[]; cwd: string }) => ({
        executable: request.executable,
        args: request.args,
        cwd: path.join(root, request.cwd),
        env: process.env
      })
    )
  };
});
vi.mock('./host-storage.js', async (importOriginal) => ({
  ...(await importOriginal<typeof HostStorageModule>()),
  hostStorage: vi.fn(async () => ({ totalBytes: 1e12, availableBytes: 1e11, freeBytes: 1e11 })),
  belowHostStorageFloor: vi.fn(() => false)
}));
import { prepareInvocation } from './execution.js';
import { ComputationManager } from './computation.js';
const policy = {
  isolateNetwork: false,
  sandbox: {
    elevate: '/usr/bin/sudo',
    helper: '/fixture/helper',
    specDirectory: '/fixture/spec',
    confineFilesystem: true,
    networkIsolation: true
  },
  systemPackages: { mode: 'refused' as const, helper: undefined }
};
let directory: string, workspaceId: string, owner: string, manager: ComputationManager;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'garden-computation-')));
  workspaceId = randomUUID();
  owner = randomUUID();
  await ensureWorkspace(path.join(directory, workspaceId));
  manager = new ComputationManager(directory, policy);
});
afterEach(async () => {
  await manager.close();
  await rm(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});
async function start(language: 'python' | 'javascript', lifetimeSeconds = 3600) {
  return (await manager.act(workspaceId, owner, {
    action: 'start',
    language,
    lifetimeSeconds
  })) as ComputationSession;
}
async function cell(session: ComputationSession, code: string, cellId: string = randomUUID()) {
  await manager.act(workspaceId, owner, {
    action: 'cell',
    sessionId: session.sessionId,
    cellId,
    code
  });
  await vi.waitFor(
    () => expect(manager.status(workspaceId, owner, session.sessionId).state).toBe('idle'),
    { timeout: 6000, interval: 25 }
  );
  return manager.status(workspaceId, owner, session.sessionId);
}
describe('persistent native computation', () => {
  it.each(['python', 'javascript'] as const)(
    'retains real %s bindings and awaits native asynchronous cells',
    async (language) => {
      const session = await start(language, 129600);
      expect(Date.parse(session.deadlineAt) - Date.parse(session.createdAt)).toBe(129600000);
      expect(
        await cell(session, language === 'python' ? 'values = [2,3,5]' : 'const values = [2,3,5]')
      ).toMatchObject({ state: 'idle', stateRetained: true });
      const result = await cell(
        session,
        language === 'python'
          ? 'import asyncio\nawait asyncio.sleep(0.01)\nsum(values)'
          : 'await Promise.resolve(values.reduce((a,b)=>a+b,0))'
      );
      expect(result.latestCell).toMatchObject({ state: 'completed', result: { value: 10 } });
      expect(result.variables.some((value) => value.name === 'values')).toBe(true);
      expect(vi.mocked(prepareInvocation).mock.calls[0]?.[1]).toMatchObject({
        network: false,
        requireNetworkIsolation: true,
        cwd: 'workspace'
      });
    }
  );
  it.each(['python', 'javascript'] as const)(
    'records the launched %s interpreter and exact declared input snapshots',
    async (language) => {
      const session = await start(language);
      expect(session.runtime?.version).toMatch(/\d/);
      expect(session.runtime?.platform).toBe(process.platform);
      expect(session.runtime?.architecture.length).toBeGreaterThan(0);
      const bytes = Buffer.from('group,value\nA,3\n');
      await writeFile(path.join(directory, workspaceId, 'workspace/input.csv'), bytes);
      const code = language === 'python' ? 'value = 7\nvalue' : 'const value = 7; value';
      const id = randomUUID();
      const request = {
        action: 'cell',
        sessionId: session.sessionId,
        cellId: id,
        code,
        inputs: ['workspace/input.csv']
      };
      await manager.act(workspaceId, owner, request);
      await vi.waitFor(() =>
        expect(manager.status(workspaceId, owner, session.sessionId).state).toBe('idle')
      );
      const completed = manager.status(workspaceId, owner, session.sessionId);
      expect(completed.latestCell?.manifest).toMatchObject({
        format: 'garden-computation-manifest-1',
        sourceSha256: createHash('sha256').update(code).digest('hex'),
        runtime: session.runtime,
        coverage: 'declared_inputs_before_execution',
        inputs: [
          {
            path: 'workspace/input.csv',
            status: 'hashed',
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex')
          }
        ]
      });
      expect(completed.latestCell?.manifest?.predecessorCellId).toBeUndefined();
      await writeFile(path.join(directory, workspaceId, 'workspace/input.csv'), 'changed');
      const replay = (await manager.act(workspaceId, owner, request)) as ComputationSession;
      expect(replay.latestCell?.manifest).toEqual(completed.latestCell?.manifest);
      const next = await cell(session, 'value');
      expect(next.latestCell?.manifest?.predecessorCellId).toBe(id);
      expect(next.latestCell?.manifest?.inputs).toEqual([]);
      expect(next.latestCell?.result).toMatchObject({ value: 7 });
    }
  );
  it('keeps stable cell IDs exactly once, rejects conflicting reuse and does not execute status reads', async () => {
    const session = await start('python');
    const id = randomUUID();
    const code = "count = globals().get('count',0) + 1\ncount";
    expect((await cell(session, code, id)).latestCell?.result).toMatchObject({ value: 1 });
    expect(
      await manager.act(workspaceId, owner, {
        action: 'cell',
        sessionId: session.sessionId,
        cellId: id,
        code
      })
    ).toMatchObject({ latestCell: { result: { value: 1 } } });
    await expect(
      manager.act(workspaceId, owner, {
        action: 'cell',
        sessionId: session.sessionId,
        cellId: id,
        code: 'count += 1'
      })
    ).rejects.toThrow('different code');
    for (let i = 0; i < 3; i++)
      expect(
        manager.status(workspaceId, owner, session.sessionId).latestCell?.result
      ).toMatchObject({ value: 1 });
    expect((await cell(session, 'count')).latestCell?.result).toMatchObject({ value: 1 });
  });
  it('separates workspace/task scope from owner read access', async () => {
    const session = await start('python');
    expect(manager.list(workspaceId, 'other')).toEqual([]);
    expect(manager.list(workspaceId, null)).toHaveLength(1);
    expect(() => manager.status(workspaceId, 'other', session.sessionId)).toThrow('not found');
    await expect(
      manager.act(randomUUID(), owner, { action: 'stop', sessionId: session.sessionId })
    ).rejects.toThrow('not found');
    await expect(
      manager.act(workspaceId, null, {
        action: 'cell',
        sessionId: session.sessionId,
        cellId: 'owner',
        code: '42'
      })
    ).rejects.toThrow('owning task');
  });
  it('interrupts Python while preserving acknowledged state', async () => {
    const session = await start('python');
    await cell(session, 'answer=42');
    await manager.act(workspaceId, owner, {
      action: 'cell',
      sessionId: session.sessionId,
      cellId: 'loop',
      code: 'while True: pass'
    });
    expect(manager.status(workspaceId, owner, session.sessionId).state).toBe('busy');
    await manager.act(workspaceId, null, { action: 'interrupt', sessionId: session.sessionId });
    await vi.waitFor(() =>
      expect(manager.status(workspaceId, owner, session.sessionId)).toMatchObject({
        state: 'idle',
        latestCell: { state: 'interrupted' }
      })
    );
    expect((await cell(session, 'answer')).latestCell?.result).toMatchObject({ value: 42 });
  });
  it('checkpoints selected JSON values explicitly and restores without replaying code', async () => {
    const session = await start('python');
    await cell(session, 'values=[2,3,5]');
    const saved = (await manager.act(workspaceId, owner, {
      action: 'checkpoint',
      sessionId: session.sessionId,
      cellId: 'save',
      variables: ['values'],
      path: 'values.json'
    })) as ComputationSession;
    expect(saved.latestCell).toMatchObject({
      state: 'completed',
      artifacts: [{ path: 'workspace/values.json', mimeType: 'application/json' }]
    });
    const checkpoint: unknown = JSON.parse(
      await readFile(path.join(directory, workspaceId, 'workspace/values.json'), 'utf8')
    );
    expect(checkpoint).toEqual({
      format: 'garden-computation-json-1',
      language: 'python',
      values: { values: [2, 3, 5] }
    });
    await expect(readFile(path.join(directory, workspaceId, 'values.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    expect(
      await manager.act(workspaceId, owner, {
        action: 'checkpoint',
        sessionId: session.sessionId,
        cellId: 'save',
        variables: ['values'],
        path: 'workspace/values.json'
      })
    ).toMatchObject({ latestCell: { state: 'completed', cellId: 'save' } });
    const another = await start('python');
    await manager.act(workspaceId, owner, {
      action: 'restore',
      sessionId: another.sessionId,
      cellId: 'restore',
      path: 'values.json'
    });
    const checkpointBytes = await readFile(
      path.join(directory, workspaceId, 'workspace/values.json')
    );
    expect(
      manager.status(workspaceId, owner, another.sessionId).latestCell?.manifest?.inputs
    ).toEqual([
      {
        path: 'workspace/values.json',
        status: 'hashed',
        bytes: checkpointBytes.length,
        sha256: createHash('sha256').update(checkpointBytes).digest('hex')
      }
    ]);
    expect((await cell(another, 'sum(values)')).latestCell?.result).toMatchObject({ value: 10 });
    await expect(
      manager.act(workspaceId, owner, {
        action: 'restore',
        sessionId: another.sessionId,
        cellId: 'outside',
        path: '../secret'
      })
    ).rejects.toThrow();
  });
  it('produces data-only source-linked plots without interpreting HTML', async () => {
    const session = await start('javascript');
    const result = await cell(
      session,
      `garden.plot({title:'<script>alert(1)</script>',points:[[0,1],[1,4],[2,9]]})`
    );
    expect(result.latestCell?.artifacts).toHaveLength(1);
    const artifact = result.latestCell!.artifacts[0]!;
    expect(artifact).toMatchObject({ mimeType: 'image/svg+xml' });
    const svg = await readFile(path.join(directory, workspaceId, artifact.path), 'utf8');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).not.toContain('<script>');
  });
  it('reports lost memory across runner restart without replay and refuses unavailable isolation', async () => {
    const session = await start('python');
    await cell(session, "open('counter.txt','w').write('once')");
    await manager.close();
    manager = new ComputationManager(directory, policy);
    await manager.restore();
    expect(manager.status(workspaceId, owner, session.sessionId)).toMatchObject({
      state: 'lost',
      stateRetained: false
    });
    expect(await readFile(path.join(directory, workspaceId, 'workspace/counter.txt'), 'utf8')).toBe(
      'once'
    );
    const unavailable = new ComputationManager(directory, {
      ...policy,
      sandbox: { ...policy.sandbox, networkIsolation: false }
    });
    try {
      await expect(
        unavailable.act(workspaceId, owner, { action: 'start', language: 'python' })
      ).rejects.toThrow('network sandbox');
    } finally {
      await unavailable.close();
    }
  });
  it('runs multi-day cells beyond the native timer delay range without immediate interruption', async () => {
    const session = await start('javascript', 60 * 86400);
    expect(Date.parse(session.deadlineAt) - Date.parse(session.createdAt)).toBe(60 * 86400_000);
    await manager.act(workspaceId, owner, {
      action: 'cell',
      sessionId: session.sessionId,
      cellId: 'long',
      timeoutSeconds: 40 * 86400,
      code: 'await new Promise(r=>setTimeout(r,50)); 42'
    });
    await vi.waitFor(() =>
      expect(manager.status(workspaceId, owner, session.sessionId).latestCell).toMatchObject({
        state: 'completed',
        result: { value: 42 }
      })
    );
  });
  it('extends an owned retained session idempotently without shortening, replaying or reviving it', async () => {
    const session = await start('python');
    await cell(session, 'answer=42');
    const request = { action: 'extend', sessionId: session.sessionId, lifetimeSeconds: 7 * 86400 };
    const result = (await manager.act(workspaceId, owner, request)) as ComputationSession;
    expect(Date.parse(result.deadlineAt) - Date.parse(session.createdAt)).toBe(7 * 86400_000);
    expect(await manager.act(workspaceId, owner, request)).toMatchObject({
      deadlineAt: result.deadlineAt,
      state: 'idle',
      stateRetained: true
    });
    for (const invalid of [
      { ...request, lifetimeSeconds: 3600 },
      { ...request, lifetimeSeconds: undefined }
    ])
      await expect(manager.act(workspaceId, owner, invalid)).rejects.toThrow();
    await expect(manager.act(workspaceId, 'other', request)).rejects.toThrow('not found');
    await expect(manager.act(workspaceId, null, request)).rejects.toThrow('owning task');
    expect((await cell(session, 'answer')).latestCell?.result).toMatchObject({ value: 42 });
    await manager.act(workspaceId, owner, { action: 'stop', sessionId: session.sessionId });
    await expect(manager.act(workspaceId, owner, request)).rejects.toThrow('retained session');
  });
  it('does not extend the timeout of an already running cell', async () => {
    const session = await start('python', 10);
    const running = manager.act(workspaceId, owner, {
      action: 'cell',
      sessionId: session.sessionId,
      cellId: 'limited',
      timeoutSeconds: 1,
      code: 'import time\nanswer=42\ntime.sleep(20)'
    });
    await vi.waitFor(() =>
      expect(manager.status(workspaceId, owner, session.sessionId).state).toBe('busy')
    );
    await manager.act(workspaceId, owner, {
      action: 'extend',
      sessionId: session.sessionId,
      lifetimeSeconds: 20
    });
    await running;
    await vi.waitFor(
      () =>
        expect(manager.status(workspaceId, owner, session.sessionId).latestCell?.state).toBe(
          'interrupted'
        ),
      { timeout: 4000 }
    );
  });
  it('does not revive an elapsed retained session before its sweep runs', async () => {
    await manager.close();
    let now = Date.now();
    manager = new ComputationManager(directory, policy, () => now);
    const session = await start('python', 10);
    now += 11000;
    await expect(
      manager.act(workspaceId, owner, {
        action: 'extend',
        sessionId: session.sessionId,
        lifetimeSeconds: 30
      })
    ).rejects.toThrow('expired');
  });
  it('refuses durations outside the supported calendar before starting a process', async () => {
    await expect(start('python', Number.MAX_SAFE_INTEGER)).rejects.toThrow('calendar range');
    expect(prepareInvocation).not.toHaveBeenCalled();
  });
  it('loses an interrupted JavaScript await explicitly when the runtime cannot acknowledge it', async () => {
    const session = await start('javascript');
    await manager.act(workspaceId, owner, {
      action: 'cell',
      sessionId: session.sessionId,
      cellId: 'await',
      code: 'await new Promise(()=>{})'
    });
    await manager.act(workspaceId, null, { action: 'interrupt', sessionId: session.sessionId });
    await vi.waitFor(
      () =>
        expect(manager.status(workspaceId, owner, session.sessionId)).toMatchObject({
          state: 'lost',
          stateRetained: false,
          latestCell: { state: 'interrupted' }
        }),
      { timeout: 4000 }
    );
  });
  it('rejects checkpoint getters and does not silently replace lexical bindings', async () => {
    const session = await start('javascript');
    await cell(
      session,
      "const values=[1,2]; Object.defineProperty(globalThis,'sensitive',{get(){throw Error('getter ran')},configurable:true})"
    );
    const saved = (await manager.act(workspaceId, owner, {
      action: 'checkpoint',
      sessionId: session.sessionId,
      cellId: 'getter',
      variables: ['sensitive'],
      path: 'workspace/getter.json'
    })) as ComputationSession;
    expect(saved.latestCell).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('cannot execute getters') as unknown
    });
    await manager.act(workspaceId, owner, {
      action: 'checkpoint',
      sessionId: session.sessionId,
      cellId: 'save',
      variables: ['values'],
      path: 'workspace/values.json'
    });
    const restored = (await manager.act(workspaceId, owner, {
      action: 'restore',
      sessionId: session.sessionId,
      cellId: 'restore',
      path: 'workspace/values.json'
    })) as ComputationSession;
    expect(restored.latestCell).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('unbound') as unknown
    });
  });
  it('marks a crash journal as lost and retains the spent cell ledger', async () => {
    const session = await start('python');
    await cell(session, 'values=[1,2]', 'once');
    await manager.close();
    const journal = path.join(directory, '.athanor/computation.json');
    const records = JSON.parse(await readFile(journal, 'utf8')) as Array<{
      view: { state: string; stateRetained: boolean };
    }>;
    expect(records).toHaveLength(1);
    records[0]!.view.state = 'busy';
    records[0]!.view.stateRetained = true;
    await writeFile(journal, JSON.stringify(records));
    manager = new ComputationManager(directory, policy);
    await manager.restore();
    expect(manager.status(workspaceId, owner, session.sessionId)).toMatchObject({
      state: 'lost',
      stateRetained: false
    });
    await expect(
      manager.act(workspaceId, owner, {
        action: 'cell',
        sessionId: session.sessionId,
        cellId: 'again',
        code: 'values'
      })
    ).rejects.toThrow('retained state');
    expect(prepareInvocation).toHaveBeenCalledTimes(1);
  });
  it('bounds outputs and expires the explicit session lifetime', async () => {
    const session = await start('python', 3);
    const result = await cell(session, "print('a'*100000)\n42");
    expect(result.latestCell?.stdout.length).toBeLessThan(17000);
    expect(result.latestCell?.stdout).toContain('bytes omitted');
    await vi.waitFor(
      () =>
        expect(manager.status(workspaceId, owner, session.sessionId)).toMatchObject({
          state: 'expired',
          stateRetained: false
        }),
      { timeout: 4000 }
    );
  });
});
