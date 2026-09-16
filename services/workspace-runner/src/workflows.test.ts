import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRequest, type WorkflowRun } from '@athanor/contracts';
import { WorkflowManager } from './workflows.js';
import { WorkflowStore } from './workflow-store.js';
import { ensureWorkspace } from './files.js';
import type { ProcessService } from './process-supervisor.js';
import { jobIdentity } from './job-identity.js';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'garden-workflow-'));
  cleanup.push(base);
  const workspaceId = randomUUID(),
    root = path.join(base, workspaceId),
    owner = 'task-1';
  await ensureWorkspace(root);
  await writeFile(path.join(root, 'workspace/main.nf'), 'workflow { }');
  const jobs: Array<{
    sessionId: string;
    ownerTaskId: string;
    workspaceId: string;
    status: string;
    startedAt: string;
    finishedAt?: string;
  }> = [];
  const start = vi.fn(async (_root: string, w: string, o: string, value: unknown) => {
    const request = value as { requestId: string };
    const id = jobIdentity(w, o, request.requestId);
    if (!jobs.some((job) => job.sessionId === id))
      jobs.push({
        sessionId: id,
        ownerTaskId: o,
        workspaceId: w,
        status: 'running',
        startedAt: new Date().toISOString()
      });
    return jobs.find((job) => job.sessionId === id);
  });
  const action = vi.fn(async (_w: string, _o: string | null, id: string) => {
    const job = jobs.find((job) => job.sessionId === id)!;
    job.status = 'stopped';
    return job;
  });
  const config = {
    workspaceRoot: base,
    secret: 'secret-more-than-thirty-two-characters',
    maximumSeconds: 3600,
    isolateNetwork: true,
    guards: {}
  };
  const service = { start, listWorkspace: async () => jobs, action } as unknown as ProcessService;
  const manager = () => new WorkflowManager(config, service, async () => '26.04.6');
  return {
    base,
    root,
    workspaceId,
    owner,
    jobs,
    start,
    action,
    config,
    manager,
    store: new WorkflowStore(config.secret)
  };
}
const request = {
  action: 'start',
  name: 'Private specimen analysis',
  script: 'main.nf',
  parameters: { sample: 'private-donor' },
  network: false
};
describe('durable workflow ownership and launch contracts', () => {
  it('commits one launch across concurrent calls, restart, and lost acknowledgement', async () => {
    const f = await fixture(),
      manager = f.manager();
    const [a, b] = (await Promise.all([
      manager.act(f.workspaceId, f.owner, request, 'call-1'),
      manager.act(f.workspaceId, f.owner, request, 'call-1')
    ])) as WorkflowRun[];
    expect(a!.workflowId).toBe(b!.workflowId);
    expect((await manager.decorate(f.workspaceId, f.jobs))[0]?.workflow?.workflowId).toBe(
      a!.workflowId
    );
    expect(f.start).toHaveBeenCalledTimes(1);
    await f.manager().act(f.workspaceId, f.owner, request, 'call-1');
    expect(f.start).toHaveBeenCalledTimes(1);
    await expect(
      manager.act(f.workspaceId, f.owner, { ...request, name: 'changed' }, 'call-1')
    ).rejects.toThrow('different arguments');
    const storeFile = await readFile(path.join(f.root, '.athanor/workflows/runs.sqlite'));
    expect(storeFile.includes(Buffer.from('private-donor'))).toBe(false);
    expect(storeFile.includes(Buffer.from(request.name))).toBe(false);
    const parameters = await readFile(
      path.join(f.root, a!.directory, 'attempt-1/parameters.json'),
      'utf8'
    );
    expect(JSON.parse(parameters)).toEqual(request.parameters);
    f.start.mockImplementationOnce(async (...args) => {
      const value = args[3] as { requestId: string };
      f.jobs.push({
        sessionId: jobIdentity(args[1], args[2], value.requestId),
        ownerTaskId: args[2],
        workspaceId: args[1],
        status: 'running',
        startedAt: new Date().toISOString()
      });
      throw new Error('lost acknowledgement');
    });
    const lost = (await manager.act(
      f.workspaceId,
      f.owner,
      { ...request, name: 'Lost reply' },
      'call-2'
    )) as WorkflowRun;
    expect(lost.state).toBe('running');
    await f.manager().act(f.workspaceId, f.owner, { ...request, name: 'Lost reply' }, 'call-2');
    expect(f.start).toHaveBeenCalledTimes(2);
  });
  it('does not execute while reading and refuses cross-owner or escaped sources', async () => {
    const f = await fixture(),
      manager = f.manager();
    const run = (await manager.act(f.workspaceId, f.owner, request, 'call-1')) as WorkflowRun;
    await expect(manager.status(f.workspaceId, 'other', run.workflowId)).rejects.toThrow(
      'not found'
    );
    await expect(
      manager.act(f.workspaceId, 'other', { action: 'cancel', workflowId: run.workflowId })
    ).rejects.toThrow('not found');
    await expect(
      manager.act(
        f.workspaceId,
        'other',
        { action: 'resume', workflowId: run.workflowId },
        'resume'
      )
    ).rejects.toThrow('not found');
    expect((await manager.list(f.workspaceId, 'other')).workflows).toEqual([]);
    expect((await manager.list(f.workspaceId, null)).workflows).toHaveLength(1);
    await manager.status(f.workspaceId, f.owner, run.workflowId);
    expect(f.start).toHaveBeenCalledTimes(1);
    await writeFile(path.join(f.base, 'outside.nf'), 'workflow{}');
    await symlink(path.join(f.base, 'outside.nf'), path.join(f.root, 'workspace/escape.nf'));
    for (const script of ['../outside.nf', '.athanor/secret', 'escape.nf'])
      await expect(
        manager.act(f.workspaceId, f.owner, { ...request, script }, `bad-${script}`)
      ).rejects.toThrow();
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it('resumes only settled jobs, makes a new attempt, and merges explicit parameter changes', async () => {
    const f = await fixture(),
      manager = f.manager();
    const run = (await manager.act(f.workspaceId, f.owner, request, 'call-1')) as WorkflowRun;
    await expect(
      manager.act(
        f.workspaceId,
        f.owner,
        { action: 'resume', workflowId: run.workflowId },
        'resume-0'
      )
    ).rejects.toThrow('active');
    await manager.act(f.workspaceId, null, { action: 'cancel', workflowId: run.workflowId });
    expect(f.action).toHaveBeenCalledTimes(1);
    await expect(
      manager.act(
        f.workspaceId,
        f.owner,
        { action: 'resume', workflowId: run.workflowId },
        'resume-1'
      )
    ).rejects.toThrow('stopping');
    f.jobs[0]!.finishedAt = new Date().toISOString();
    const resume = {
      action: 'resume',
      workflowId: run.workflowId,
      parameters: { sample: 'updated', newValue: 2 }
    };
    const [a, b] = (await Promise.all([
      manager.act(f.workspaceId, f.owner, resume, 'resume-2'),
      manager.act(f.workspaceId, f.owner, resume, 'resume-2')
    ])) as WorkflowRun[];
    expect(a!.attempt).toBe(2);
    expect(b!.attempt).toBe(2);
    expect(f.start).toHaveBeenCalledTimes(2);
    const launch = f.start.mock.calls[1]![3] as { args: string[] };
    expect(launch.args).toContain('-resume');
    expect(launch.args.at(-1)).toContain('_1');
    expect(
      JSON.parse(
        await readFile(path.join(f.root, run.directory, 'attempt-2/parameters.json'), 'utf8')
      )
    ).toEqual({ sample: 'updated', newValue: 2 });
    await manager.act(f.workspaceId, f.owner, request, 'call-1');
    expect(f.start).toHaveBeenCalledTimes(2);
    await expect(manager.act(f.workspaceId, f.owner, resume, 'resume-3')).rejects.toThrow('active');
    expect((await manager.plan(f.workspaceId, f.owner, run.workflowId)).parameters).toEqual({
      sample: 'updated',
      newValue: 2
    });
  });
  it('preserves an uncertain dispatch without blindly launching it again', async () => {
    const f = await fixture(),
      manager = f.manager();
    f.start.mockRejectedValueOnce(new Error('supervisor offline'));
    const run = (await manager.act(f.workspaceId, f.owner, request, 'call-1')) as WorkflowRun;
    expect(run.state).toBe('interrupted');
    expect(run.note).toContain('No command was repeated');
    await f.manager().act(f.workspaceId, f.owner, request, 'call-1');
    await f.manager().status(f.workspaceId, f.owner, run.workflowId);
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it('binds owner resume to the displayed attempt and reconciles repeated clicks', async () => {
    const f = await fixture(),
      manager = f.manager();
    const first = (await manager.act(f.workspaceId, f.owner, request, 'start')) as WorkflowRun;
    f.jobs[0]!.status = 'failed';
    f.jobs[0]!.finishedAt = new Date().toISOString();
    const resumed = (await manager.resumeByOwner(
      f.workspaceId,
      first.workflowId,
      1
    )) as WorkflowRun;
    expect(resumed.attempt).toBe(2);
    expect(
      ((await manager.resumeByOwner(f.workspaceId, first.workflowId, 1)) as WorkflowRun).sessionId
    ).toBe(resumed.sessionId);
    expect(f.start).toHaveBeenCalledTimes(2);
    f.jobs[1]!.status = 'failed';
    f.jobs[1]!.finishedAt = new Date().toISOString();
    await expect(manager.resumeByOwner(f.workspaceId, first.workflowId, 9)).rejects.toThrow(
      'newer attempt'
    );
    expect(f.start).toHaveBeenCalledTimes(2);
    const decorated = await manager.decorate(f.workspaceId, f.jobs);
    expect(decorated[0]!.workflow?.canResume).toBe(false);
    expect(decorated[1]!.workflow?.canResume).toBe(true);
  });
  it('recovers an intent saved before dispatch and aliases retries to the original attempt', async () => {
    const f = await fixture(),
      body = WorkflowRequest.parse(request);
    const saved = await f.store.claim(f.root, f.owner, 'original', body, () => ({
      workspaceId: f.workspaceId,
      owner: f.owner,
      createdAt: new Date().toISOString(),
      engineVersion: '26.04.6',
      spec: {
        name: 'Interrupted preparation',
        script: 'workspace/main.nf',
        configs: [],
        network: false,
        parameters: { sample: 'private-donor' }
      }
    }));
    const manager = f.manager(),
      run = await manager.status(f.workspaceId, f.owner, saved.record.workflowId);
    expect(run.state).toBe('interrupted');
    expect(run.canResume).toBe(true);
    expect(f.start).not.toHaveBeenCalled();
    const resumed = (await manager.resumeByOwner(f.workspaceId, run.workflowId, 1)) as WorkflowRun;
    expect(resumed.attempt).toBe(1);
    expect(resumed.state).toBe('running');
    expect(f.start).toHaveBeenCalledTimes(1);
    f.jobs[0]!.status = 'completed';
    f.jobs[0]!.finishedAt = new Date().toISOString();
    expect(
      ((await f.manager().resumeByOwner(f.workspaceId, run.workflowId, 1)) as WorkflowRun).attempt
    ).toBe(1);
    await f.manager().act(f.workspaceId, f.owner, body, 'original');
    expect(f.start).toHaveBeenCalledTimes(1);
  });
});
