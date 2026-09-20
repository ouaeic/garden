import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessManager } from './processes.js';
import { JOB_LOG_BYTES, ServiceRegistry, newServiceRecord } from './services.js';

const roots: string[] = [];
const managers: ProcessManager[] = [];
const manager = () => {
  const current = new ProcessManager();
  managers.push(current);
  return current;
};
const setup = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'garden-jobs-'));
  roots.push(root);
  await mkdir(path.join(root, 'workspace'));
  return { root, current: manager() };
};
const command = (script: string) => ({ executable: process.execPath, args: ['-e', script] });
const start = (
  current: ProcessManager,
  root: string,
  script: string,
  extra: Record<string, unknown> = {}
) =>
  current.start(
    root,
    'workspace-1',
    'task-1',
    { ...command(script), job: 'Genome analysis', timeoutSeconds: 60, ...extra },
    120,
    false
  );
const poll = (current: ProcessManager, id: string) =>
  current.action('workspace-1', 'task-1', id, { action: 'poll' });
const settled = async (current: ProcessManager, id: string) => {
  await expect
    .poll(() => poll(current, id).status, { interval: 10, timeout: 10_000 })
    .not.toBe('running');
  await current.flush();
  return poll(current, id);
};
afterEach(async () => {
  await Promise.all(managers.splice(0).map((current) => current.close()));
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }))
  );
});

describe('durable finite jobs', () => {
  it('returns a quick command output and exit receipt within its foreground wait', async () => {
    const { root, current } = await setup();
    const result = await start(current, root, "console.log('fast output')", {
      yieldAfterMs: 5000,
      timeoutSeconds: undefined
    });
    expect(result).toMatchObject({
      status: 'completed',
      stdout: 'fast output\n',
      exitCode: 0,
      lifetime: 'job'
    });
    expect(result).not.toHaveProperty('yielded');
    expect(result).not.toHaveProperty('deadlineAt');
  });

  it('yields a slow command once and preserves its eventual output under the same handle', async () => {
    const { root, current } = await setup();
    const result = await start(
      current,
      root,
      "require('fs').appendFileSync('launches','one\\n');setTimeout(()=>console.log('done'),500)",
      { yieldAfterMs: 10, timeoutSeconds: undefined }
    );
    expect(result).toMatchObject({ status: 'running', yielded: true, lifetime: 'job' });
    expect(result).not.toHaveProperty('deadlineAt');
    const finished = await settled(current, result.sessionId);
    expect(finished).toMatchObject({ status: 'completed', exitCode: 0, stdout: 'done\n' });
    expect(await readFile(path.join(root, 'workspace/launches'), 'utf8')).toBe('one\n');
  });

  it('reconciles a repeated command request after a lost response without launching again', async () => {
    const { root, current } = await setup();
    const script = "require('fs').appendFileSync('runs','one\\n');setTimeout(()=>{},100)";
    const first = await start(current, root, script, { requestId: 'one-call', yieldAfterMs: 5000 });
    const again = await start(current, root, script, { requestId: 'one-call', yieldAfterMs: 5000 });
    expect(again.sessionId).toBe(first.sessionId);
    expect(await readFile(path.join(root, 'workspace/runs'), 'utf8')).toBe('one\n');
    await expect(start(current, root, 'console.log(2)', { requestId: 'one-call' })).rejects.toThrow(
      'different arguments'
    );
  });

  it('allows a finite job without a deadline and recovers only its checkpoint', async () => {
    const { root, current } = await setup();
    const launched = await start(current, root, "console.log('ready'); setInterval(()=>{},1000)", {
      timeoutSeconds: undefined,
      checkpointResume: command("console.log('checkpoint recovered')")
    });
    expect(launched).not.toHaveProperty('deadlineAt');
    expect(launched).not.toHaveProperty('remainingMs');
    await expect.poll(() => poll(current, launched.sessionId).stdout).toContain('ready');
    expect(current.backgroundWork()).toMatchObject({ commands: 1, longestRemainingMs: null });
    await current.close();
    const resumed = manager();
    expect(await resumed.resumeWorkspace(root, 'workspace-1', false)).toBe(1);
    const result = await settled(resumed, launched.sessionId);
    expect(result.status).toBe('completed');
    expect(result.stdout).toContain('checkpoint recovered');
    expect(result).not.toHaveProperty('deadlineAt');
  });

  it('accepts a multi-month named job deadline without applying the unnamed session ceiling', async () => {
    const { root, current } = await setup();
    const timeoutSeconds = 90 * 24 * 3600;
    const before = Date.now();
    const launched = await start(current, root, "console.log('ready'); setInterval(()=>{},1000)", {
      timeoutSeconds
    });
    await expect.poll(() => poll(current, launched.sessionId).stdout).toContain('ready');
    expect(poll(current, launched.sessionId).status).toBe('running');
    expect(Date.parse(launched.deadlineAt!)).toBeGreaterThanOrEqual(before + timeoutSeconds * 1000);
    expect(launched.ownerTaskId).toBe('task-1');
    current.action('workspace-1', null, launched.sessionId, { action: 'kill' });
    expect((await settled(current, launched.sessionId)).status).toBe('stopped');
  });

  it('persists successful identity and logs without repeating completed work after restart', async () => {
    const { root, current } = await setup();
    const launched = await start(
      current,
      root,
      "require('node:fs').appendFileSync('runs.txt','initial\\n'); console.log('analysis complete')",
      {
        checkpointResume: command(
          "require('node:fs').appendFileSync('runs.txt','unexpected recovery\\n')"
        )
      }
    );
    expect(launched.lifetime).toBe('job');
    expect((await settled(current, launched.sessionId)).status).toBe('completed');
    await current.close();
    const resumed = manager();
    expect(await resumed.resumeWorkspace(root, 'workspace-1', false)).toBe(0);
    expect(resumed.listWorkspace('workspace-1')).toHaveLength(1);
    expect(poll(resumed, launched.sessionId)).toMatchObject({
      status: 'completed',
      stdout: 'analysis complete\n',
      job: { state: 'completed', restarts: 0 }
    });
    expect(await readFile(path.join(root, 'workspace/runs.txt'), 'utf8')).toBe('initial\n');
  });

  it('surfaces an interrupted command without a checkpoint instead of duplicating it', async () => {
    const { root, current } = await setup();
    const launched = await start(
      current,
      root,
      "require('node:fs').appendFileSync('runs.txt','initial\\n'); console.log('working'); setInterval(()=>{},1000)"
    );
    await expect.poll(() => poll(current, launched.sessionId).stdout).toContain('working');
    expect(current.backgroundWork().commands).toBe(1);
    await current.close();
    const resumed = manager();
    expect(await resumed.resumeWorkspace(root, 'workspace-1', false)).toBe(0);
    expect(poll(resumed, launched.sessionId)).toMatchObject({
      status: 'interrupted',
      job: { checkpointResumable: false }
    });
    expect(await readFile(path.join(root, 'workspace/runs.txt'), 'utf8')).toBe('initial\n');
    expect(resumed.stopOwner('workspace-1', 'task-1', {}).stopped).toEqual([launched.sessionId]);
    await resumed.flush();
    expect(poll(resumed, launched.sessionId).status).toBe('stopped');
  });

  it('resumes only the declared checkpoint command and keeps the original deadline', async () => {
    const { root, current } = await setup();
    const launched = await start(
      current,
      root,
      "require('node:fs').appendFileSync('runs.txt','initial\\n'); console.log('checkpoint saved'); setInterval(()=>{},1000)",
      {
        checkpointResume: command(
          "require('node:fs').appendFileSync('runs.txt','checkpoint\\n'); console.log('resume complete')"
        )
      }
    );
    await expect.poll(() => poll(current, launched.sessionId).stdout).toContain('checkpoint saved');
    await current.close();
    const resumed = manager();
    expect(await resumed.resumeWorkspace(root, 'workspace-1', false)).toBe(1);
    const result = await settled(resumed, launched.sessionId);
    expect(result).toMatchObject({
      status: 'completed',
      deadlineAt: launched.deadlineAt,
      job: { restarts: 1 }
    });
    expect(result.stdout).toContain('checkpoint saved');
    expect(result.stdout).toContain('resume complete');
    expect(await readFile(path.join(root, 'workspace/runs.txt'), 'utf8')).toBe(
      'initial\ncheckpoint\n'
    );
    await resumed.close();
    const again = manager();
    expect(await again.resumeWorkspace(root, 'workspace-1', false)).toBe(0);
    expect(await readFile(path.join(root, 'workspace/runs.txt'), 'utf8')).toBe(
      'initial\ncheckpoint\n'
    );
  });

  it('preserves failure and bounded head/tail logs rather than entering service restart backoff', async () => {
    const { root, current } = await setup();
    const launched = await start(
      current,
      root,
      `process.stdout.write('HEAD'+ 'x'.repeat(${JOB_LOG_BYTES * 4}) + 'TAIL'); process.exitCode=7`
    );
    const result = await settled(current, launched.sessionId);
    expect(result).toMatchObject({ status: 'failed', exitCode: 7 });
    const registry = new ServiceRegistry(root);
    const records = await registry.load();
    expect(records).toHaveLength(1);
    expect(records[0]!.output!.stdout.length).toBeLessThan(JOB_LOG_BYTES * 2);
    expect(records[0]!.output!.stdout).toMatch(/^HEAD[\s\S]*TAIL$/);
    await current.close();
    const resumed = manager();
    expect(await resumed.resumeWorkspace(root, 'workspace-1', false)).toBe(0);
    expect(poll(resumed, launched.sessionId).status).toBe('failed');
  });

  it('cancels finite jobs while preserving separately declared services', async () => {
    const { root, current } = await setup();
    const job = await start(current, root, 'setInterval(()=>{},1000)');
    const service = await current.start(
      root,
      'workspace-1',
      'task-1',
      { ...command('setInterval(()=>{},1000)'), service: 'Preview server' },
      120,
      false
    );
    expect(current.stopOwner('workspace-1', 'task-1', {})).toMatchObject({
      stopped: [job.sessionId],
      services: ['Preview server']
    });
    expect((await settled(current, job.sessionId)).status).toBe('stopped');
    expect(poll(current, service.sessionId).status).toBe('running');
  });

  it('retains and enforces a finite deadline', async () => {
    const { root, current } = await setup();
    const job = await start(current, root, 'setInterval(()=>{},1000)', { timeoutSeconds: 1 });
    expect(job.deadlineAt).toBeDefined();
    expect((await settled(current, job.sessionId)).status).toBe('timed_out');
    expect(current.backgroundWork().commands).toBe(0);
  });

  it('refuses an unjournalled job before executing any command', async () => {
    const { root, current } = await setup();
    await mkdir(path.join(root, '.athanor/services.json'), { recursive: true });
    await expect(
      start(current, root, "require('node:fs').writeFileSync('must-not-run.txt','wrong')")
    ).rejects.toThrow();
    await expect(readFile(path.join(root, 'workspace/must-not-run.txt'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    expect(current.listWorkspace('workspace-1')).toEqual([]);
  });

  it('refuses ambiguous lifetimes and checkpoint commands without a finite job', async () => {
    const { root, current } = await setup();
    await expect(start(current, root, '', { service: 'server' })).rejects.toThrow(
      'Choose a service or a finite job'
    );
    await expect(
      current.start(
        root,
        'workspace-1',
        'task-1',
        { ...command(''), checkpointResume: command('') },
        120,
        false
      )
    ).rejects.toThrow('requires a finite job');
    expect(current.listWorkspace('workspace-1')).toEqual([]);
  });

  it('applies the workspace boundary again to checkpoint recovery', async () => {
    const { root, current } = await setup();
    const launched = await start(current, root, "console.log('ready');setInterval(()=>{},1000)", {
      checkpointResume: {
        ...command("require('node:fs').writeFileSync('outside-write','wrong')"),
        cwd: '../outside'
      }
    });
    await expect.poll(() => poll(current, launched.sessionId).stdout).toContain('ready');
    await current.close();
    const resumed = manager();
    expect(await resumed.resumeWorkspace(root, 'workspace-1', false)).toBe(0);
    expect(poll(resumed, launched.sessionId)).toMatchObject({
      status: 'interrupted',
      job: { restarts: 0 }
    });
    expect(poll(resumed, launched.sessionId).job?.lastExit?.reason).toMatch(
      /workspace|outside|path/i
    );
    expect(resumed.backgroundWork().commands).toBe(0);
  });

  it('permits an owner to retry interrupted checkpoint recovery once after fixing its workspace', async () => {
    const { root, current } = await setup();
    const launched = await start(current, root, "console.log('ready');setInterval(()=>{},1000)", {
      checkpointResume: {
        ...command("require('node:fs').appendFileSync('resumed.txt','once\\n')"),
        cwd: 'workspace/recovery',
        env: { PYTHONUNBUFFERED: '1' }
      }
    });
    await expect.poll(() => poll(current, launched.sessionId).stdout).toContain('ready');
    await current.close();
    const resumed = manager();
    expect(await resumed.resumeWorkspace(root, 'workspace-1', false)).toBe(0);
    expect(() => resumed.recoveryPlan('workspace-2', null, launched.sessionId)).toThrow(
      'not found'
    );
    expect(() => resumed.recoveryPlan('workspace-1', 'task-2', launched.sessionId)).toThrow(
      'not found'
    );
    expect(
      resumed.recoveryPlan('workspace-1', null, launched.sessionId).checkpointResume
    ).not.toHaveProperty('env');
    await mkdir(path.join(root, 'workspace/recovery'));
    await Promise.all([
      resumed.resumeJob('workspace-1', null, launched.sessionId),
      resumed.resumeJob('workspace-1', null, launched.sessionId)
    ]);
    expect((await settled(resumed, launched.sessionId)).status).toBe('completed');
    expect(await readFile(path.join(root, 'workspace/recovery/resumed.txt'), 'utf8')).toBe(
      'once\n'
    );
    await expect(resumed.resumeJob('workspace-1', null, launched.sessionId)).rejects.toThrow(
      'Only an interrupted'
    );
  });

  it('refuses checkpoint recovery after the original deadline is spent', async () => {
    const { root, current } = await setup();
    const launched = await start(current, root, "console.log('ready');setInterval(()=>{},1000)", {
      timeoutSeconds: 1,
      checkpointResume: {
        ...command("require('node:fs').writeFileSync('too-late.txt','wrong')"),
        cwd: 'workspace/recovery'
      }
    });
    await expect.poll(() => poll(current, launched.sessionId).stdout).toContain('ready');
    await current.close();
    const resumed = manager();
    expect(await resumed.resumeWorkspace(root, 'workspace-1', false)).toBe(0);
    await mkdir(path.join(root, 'workspace/recovery'));
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, Date.parse(launched.deadlineAt!) - Date.now() + 20))
    );
    const expired = await resumed.resumeJob('workspace-1', null, launched.sessionId);
    expect(expired.status).toBe('timed_out');
    expect(expired.job?.restarts).toBe(0);
    await expect(
      readFile(path.join(root, 'workspace/recovery/too-late.txt'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('honors an explicitly declared multi-day job within the configured owner ceiling', async () => {
    const { root, current } = await setup();
    const launched = await current.start(
      root,
      'workspace-1',
      'task-1',
      {
        ...command('setInterval(()=>{},1000)'),
        job: 'Multi-day assembly',
        timeoutSeconds: 129_600
      },
      172_800,
      false
    );
    expect(Date.parse(launched.deadlineAt!) - Date.parse(launched.startedAt)).toBeGreaterThan(
      129_590_000
    );
    expect(current.backgroundWork().longestRemainingMs).toBeGreaterThan(129_590_000);
    expect(current.stopOwner('workspace-1', 'task-1', {}).stopped).toEqual([launched.sessionId]);
  });
});

describe('saved process history beyond the recent list', () => {
  it('keeps older jobs readable after restart and never replays their original request', async () => {
    const { root, current } = await setup();
    const script = "require('fs').appendFileSync('runs','one\\n');console.log('original output')";
    const first = await start(current, root, script, {
      requestId: 'archived-request',
      yieldAfterMs: 5000
    });
    await settled(current, first.sessionId);
    await current.close();
    const registry = new ServiceRegistry(root);
    const [original] = await registry.load();
    expect(original).toBeDefined();
    for (let index = 0; index < 70; index++) {
      await registry.put(
        {
          ...original!,
          id: `job-saved-${index}`,
          name: `Finished ${index}`,
          createdAt: new Date(Date.now() + index + 1).toISOString(),
          lastExit: { ...original!.lastExit!, at: new Date(Date.now() + index + 1).toISOString() }
        },
        true
      );
    }
    const restored = manager();
    expect(await restored.resumeWorkspace(root, 'workspace-1', false)).toBe(0);
    expect(restored.listWorkspace('workspace-1')).toHaveLength(64);
    const archive = await restored.history('workspace-1', ['task-1'], { limit: 3 });
    expect(archive.entries).toHaveLength(3);
    expect(archive.nextCursor).not.toBeNull();
    const outputs = [...archive.entries];
    let cursor = archive.nextCursor;
    while (cursor) {
      const page = await restored.history('workspace-1', ['task-1'], { cursor, limit: 3 });
      outputs.push(...page.entries);
      cursor = page.nextCursor;
    }
    expect(outputs).toHaveLength(7);
    expect(new Set(outputs.map((entry) => entry.value.sessionId)).size).toBe(7);
    expect(outputs.some((entry) => entry.value.sessionId === first.sessionId)).toBe(true);
    const retried = await start(restored, root, script, {
      requestId: 'archived-request',
      yieldAfterMs: 5000
    });
    expect(retried).toMatchObject({
      sessionId: first.sessionId,
      status: 'completed',
      stdout: 'original output\n',
      archived: true
    });
    expect(await readFile(path.join(root, 'workspace/runs'), 'utf8')).toBe('one\n');
    await expect(
      restored.readAction('workspace-1', 'other-task', first.sessionId, { action: 'log' })
    ).rejects.toThrow('not found');
    await expect(
      restored.readAction('workspace-1', null, first.sessionId, { action: 'kill' })
    ).rejects.toThrow('not found');
    await expect(
      start(restored, root, 'console.log(99)', { requestId: 'archived-request' })
    ).rejects.toThrow('different arguments');
  });

  it('retains terminal hot records when archiving fails, then recovers without loss', async () => {
    const { root, current } = await setup();
    const first = await start(current, root, "console.log('saved')", { yieldAfterMs: 5000 });
    await settled(current, first.sessionId);
    await current.close();
    const registry = new ServiceRegistry(root);
    const [record] = await registry.load();
    expect(record).toBeDefined();
    for (let id = 0; id < 66; id++) await registry.put({ ...record!, id: `job-${id}` }, true);
    const history = path.join(root, '.athanor/process-history');
    await mkdir(history);
    await mkdir(path.join(history, 'invalid-entry'));
    const restored = manager();
    await expect(restored.resumeWorkspace(root, 'workspace-1', false)).rejects.toThrow(
      'invalid directory'
    );
    expect(restored.listWorkspace('workspace-1')).toHaveLength(67);
    expect(await new ServiceRegistry(root).load()).toHaveLength(67);
    await rm(path.join(history, 'invalid-entry'), { recursive: true });
    const page = await restored.history('workspace-1', null);
    expect(page.entries).toHaveLength(3);
    expect(restored.listWorkspace('workspace-1')).toHaveLength(64);
  });

  it('archives deliberately stopped services without restarting them and retains their output', async () => {
    const { root, current } = await setup();
    const launched = await current.start(
      root,
      'workspace-1',
      'task-1',
      {
        ...command("console.log('service ready');setInterval(()=>{},1000)"),
        service: 'Test service'
      },
      120,
      false
    );
    await expect
      .poll(() => current.action('workspace-1', null, launched.sessionId, { action: 'log' }).stdout)
      .toContain('service ready');
    current.action('workspace-1', null, launched.sessionId, { action: 'kill' });
    await current.flush();
    await current.close();
    const restored = manager();
    expect(await restored.resumeWorkspace(root, 'workspace-1', false)).toBe(0);
    const page = await restored.history('workspace-1', null);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.value).toMatchObject({
      lifetime: 'service',
      archived: true,
      status: 'stopped',
      service: { name: 'Test service' }
    });
    expect(
      await restored.readAction('workspace-1', null, launched.sessionId, { action: 'log' })
    ).toMatchObject({ stdout: 'service ready\n' });
  });
});

it('keeps large launch receipts while projecting bounded command previews for history pages', async () => {
  const { root, current } = await setup();
  const registry = new ServiceRegistry(root);
  const args = Array.from({ length: 50 }, () => 'x'.repeat(65_536));
  const record = newServiceRecord({
    workspaceId: 'workspace-1',
    owner: 'task-1',
    name: 'Large argument list',
    kind: 'job',
    launch: {
      executable: 'analysis',
      args,
      cwd: 'workspace',
      env: {},
      network: false,
      maxOutputBytes: 4096
    }
  });
  record.state = 'failed';
  record.lastExit = {
    at: record.startedAt,
    exitCode: 1,
    signal: null,
    reason: 'Arguments refused by executable'
  };
  await registry.history.put(record.id, record.owner, record);
  expect(await current.resumeWorkspace(root, 'workspace-1', false)).toBe(0);
  const page = await current.history('workspace-1', ['task-1']);
  expect(page.entries).toHaveLength(1);
  expect(page.entries[0]!.value.commandTruncated).toBe(true);
  expect(JSON.stringify(page).length).toBeLessThan(20_000);
  expect((await registry.history.get(record.id, record.owner))?.launch.args).toEqual(args);
});
