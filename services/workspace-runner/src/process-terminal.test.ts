import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessManager } from './processes.js';
import { ExecRequest } from './execution.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'garden-pty-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'workspace'));
  const manager = new ProcessManager();
  cleanups.push(() => manager.close());
  return { root, manager };
}
const inspect = (manager: ProcessManager, id: string) =>
  manager.action('project-a', 'task-a', id, { action: 'poll' });
const write = (manager: ProcessManager, id: string, data: string) =>
  manager.action('project-a', 'task-a', id, {
    action: 'write',
    data,
    ...manager.inputPlan('project-a', 'task-a', id, data)
  });

describe('managed interactive terminals', () => {
  it('yields, resizes and completes one real terminal without replay or premature EOF', async () => {
    const { root, manager } = await fixture();
    const request = {
      executable: process.execPath,
      args: [
        '-e',
        `
        process.stdout.on('resize', () => console.log('resized='+process.stdout.columns+'x'+process.stdout.rows));
        console.log('TTY='+Boolean(process.stdin.isTTY && process.stdout.isTTY));
        console.error('combined stderr');
        require('readline').createInterface({input:process.stdin}).on('line', line => {
          console.log('answer='+line+' size='+process.stdout.columns+'x'+process.stdout.rows);
          process.exit(0);
        });`
      ],
      pty: true,
      job: 'Interactive command',
      requestId: 'one-terminal',
      yieldAfterMs: 20
    };
    const result = await manager.start(root, 'project-a', 'task-a', request, 10, false);
    expect(result).toMatchObject({
      status: 'running',
      yielded: true,
      terminal: { columns: 120, rows: 36, streams: 'combined' }
    });
    const same = await manager.start(root, 'project-a', 'task-a', request, 10, false);
    expect(same.sessionId).toBe(result.sessionId);
    await expect.poll(() => inspect(manager, result.sessionId).stdout).toContain('TTY=true');
    manager.action('project-a', 'task-a', result.sessionId, {
      action: 'resize',
      columns: 83,
      rows: 29
    });
    // The child's cached dimensions update when its event loop handles SIGWINCH.
    await expect.poll(() => inspect(manager, result.sessionId).stdout).toContain('resized=83x29');
    write(manager, result.sessionId, 'hello\n');
    await expect.poll(() => inspect(manager, result.sessionId).status).toBe('completed');
    expect(inspect(manager, result.sessionId)).toMatchObject({
      exitCode: 0,
      terminal: { columns: 83, rows: 29 }
    });
    expect(inspect(manager, result.sessionId).stdout).toContain('answer=hello size=83x29');
    expect(inspect(manager, result.sessionId).stdout).toContain('combined stderr');
    expect(inspect(manager, result.sessionId).stderr).toBe('');
  }, 15_000);

  it('retains the final large terminal output before reporting completion', async () => {
    const { root, manager } = await fixture();
    const result = await manager.start(
      root,
      'project-a',
      'task-a',
      {
        executable: process.execPath,
        args: ['-e', "process.stdout.write('x'.repeat(200000)+'\\nFINAL_MARKER\\n')"],
        pty: true,
        maxOutputBytes: 4096
      },
      10,
      false
    );
    await expect
      .poll(() => inspect(manager, result.sessionId).status, { timeout: 10_000 })
      .toBe('completed');
    const output = inspect(manager, result.sessionId).stdout!;
    expect(output).toContain('FINAL_MARKER');
    expect(output.length).toBeLessThan(4500);
  }, 15_000);

  it('keeps input history complete and rejects stale, cross-project and cross-task writes', async () => {
    const { root, manager } = await fixture();
    const result = await manager.start(
      root,
      'project-a',
      'task-a',
      { executable: '/bin/cat', pty: true },
      10,
      false
    );
    const first = manager.inputPlan('project-a', 'task-a', result.sessionId, 'abc');
    expect(first.invocation.stdin).toBe('abc');
    write(manager, result.sessionId, 'abc');
    expect(manager.inputPlan('project-a', 'task-a', result.sessionId, 'def').invocation.stdin).toBe(
      'abcdef'
    );
    expect(() =>
      manager.action('project-a', 'task-a', result.sessionId, {
        ...first,
        action: 'write',
        data: 'again'
      })
    ).toThrow('input changed');
    expect(() =>
      manager.action('project-a', 'task-a', result.sessionId, {
        action: 'write',
        data: 'missing revision'
      })
    ).toThrow('input changed');
    expect(() => manager.inputPlan('project-b', 'task-a', result.sessionId, 'x')).toThrow(
      'not found'
    );
    expect(() => manager.inputPlan('project-a', 'task-b', result.sessionId, 'x')).toThrow(
      'not found'
    );
    for (const owner of ['task-b', null]) {
      expect(() =>
        manager.action('project-a', owner, result.sessionId, {
          action: 'resize',
          columns: 80,
          rows: 24
        })
      ).toThrow('not found');
      expect(() =>
        manager.action('project-a', owner, result.sessionId, { action: 'write', data: 'x' })
      ).toThrow('not found');
    }
    expect(() =>
      manager.action('project-a', 'task-a', result.sessionId, {
        action: 'resize',
        columns: 0,
        rows: 24
      })
    ).toThrow();
    expect(manager.action('project-a', null, result.sessionId, { action: 'kill' }).status).toBe(
      'stopped'
    );
    await expect.poll(() => inspect(manager, result.sessionId).signal).toBeTruthy();
    expect(() => manager.inputPlan('project-a', 'task-a', result.sessionId, 'x')).toThrow(
      'not found'
    );
  }, 15_000);

  it('leaves ordinary yielded pipe commands at EOF and refuses an unsupported foreground terminal', async () => {
    const { root, manager } = await fixture();
    const result = await manager.start(
      root,
      'project-a',
      'task-a',
      {
        executable: '/bin/cat',
        stdin: 'pipe input',
        job: 'Pipe command',
        yieldAfterMs: 20
      },
      10,
      false
    );
    await expect.poll(() => inspect(manager, result.sessionId).status).toBe('completed');
    expect(inspect(manager, result.sessionId).stdout).toBe('pipe input');
    expect(inspect(manager, result.sessionId)).not.toHaveProperty('terminal');
    expect(() => ExecRequest.parse({ executable: 'apt-get', pty: true })).toThrow(
      'managed execution'
    );
  }, 15_000);

  it('reports a child closing its input without crashing its supervisor', async () => {
    const { root, manager } = await fixture();
    const result = await manager.start(
      root,
      'project-a',
      'task-a',
      {
        executable: process.execPath,
        args: [
          '-e',
          "require('fs').closeSync(0);console.log('input closed');setTimeout(()=>{},10000)"
        ]
      },
      15,
      false
    );
    await expect.poll(() => inspect(manager, result.sessionId).stdout).toContain('input closed');
    write(manager, result.sessionId, 'data\n');
    await expect
      .poll(() => inspect(manager, result.sessionId).stderr)
      .toContain('Process input closed');
    expect(inspect(manager, result.sessionId).status).toBe('running');
    expect(() => manager.inputPlan('project-a', 'task-a', result.sessionId, 'more')).toThrow(
      'input is closed'
    );
  }, 15_000);

  it('rejects input approved for an earlier incarnation of a restarted service', async () => {
    const { root, manager } = await fixture();
    const result = await manager.start(
      root,
      'project-a',
      'task-a',
      {
        executable: process.execPath,
        args: [
          '-e',
          "console.log('ready');require('readline').createInterface({input:process.stdin}).once('line',()=>process.exit(1))"
        ],
        pty: true,
        service: 'Interactive service'
      },
      10,
      false
    );
    await expect.poll(() => inspect(manager, result.sessionId).stdout).toContain('ready');
    const approved = manager.inputPlan('project-a', 'task-a', result.sessionId, 'approved\n');
    write(manager, result.sessionId, 'restart\n');
    await expect
      .poll(
        () => {
          try {
            return manager.inputPlan('project-a', 'task-a', result.sessionId, '').inputGeneration;
          } catch {
            return approved.inputGeneration;
          }
        },
        { timeout: 10_000 }
      )
      .not.toBe(approved.inputGeneration);
    expect(() =>
      manager.action('project-a', 'task-a', result.sessionId, {
        action: 'write',
        data: 'approved\n',
        inputRevision: approved.inputRevision,
        inputGeneration: approved.inputGeneration
      })
    ).toThrow('input changed');
    expect(inspect(manager, result.sessionId).status).toBe('running');
  }, 15_000);

  it('reports a missing terminal command as failed rather than leaving a running session', async () => {
    const { root, manager } = await fixture();
    try {
      const result = await manager.start(
        root,
        'project-a',
        'task-a',
        { executable: '/definitely/not/a/program', pty: true },
        10,
        false
      );
      await expect.poll(() => inspect(manager, result.sessionId).status).toBe('failed');
    } catch (error) {
      expect(String(error)).toMatch(/spawn|executable|ENOENT|no such file/i);
    }
    expect(manager.listWorkspace('project-a').filter((job) => job.status === 'running')).toEqual(
      []
    );
  }, 15_000);
});
