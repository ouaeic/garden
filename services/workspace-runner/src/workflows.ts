import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkflowRequest, type WorkflowRun } from '@athanor/contracts';
import {
  assertUserDataPath,
  createWorkspaceFile,
  ensureWorkspace,
  workspacePath
} from './files.js';
import { openDownloadFile } from './open-download-file.js';
import type { ProcessService } from './process-supervisor.js';
import type { ProcessManager, Guards } from './processes.js';
import { WorkflowStore, type WorkflowRecord, type WorkflowAttempt } from './workflow-store.js';
import { workflowCommand, workflowRunName, WORKFLOW_CONFIG } from './workflow-command.js';
import { WorkflowTraceReader } from './workflow-trace.js';
import { jobIdentity } from './job-identity.js';

const nativeVersion = async (): Promise<string> => {
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)('/usr/local/bin/nextflow', ['-version'], {
      timeout: 20_000,
      maxBuffer: 16_384,
      cwd: '/'
    }));
  } catch (cause) {
    throw new Error(
      'The optional workflow runtime is unavailable. Install Nextflow at /usr/local/bin/nextflow with a compatible Java runtime, then retry.',
      { cause }
    );
  }
  const version = stdout.match(/version\s+(\d+\.\d+\.\d+[^\s]*)/i)?.[1];
  if (!version)
    throw new Error(
      'Nextflow is unavailable; install the optional workflow runtime before starting a workflow'
    );
  return version;
};
type JobSnapshot = {
  sessionId: string;
  status: string;
  startedAt: string;
  finishedAt?: string | undefined;
};
const active = (state: WorkflowRun['state']) => ['preparing', 'running'].includes(state);

export class WorkflowManager {
  readonly #store: WorkflowStore;
  readonly #trace = new WorkflowTraceReader();
  readonly #locks = new Map<string, Promise<unknown>>();
  constructor(
    private readonly config: {
      workspaceRoot: string;
      secret: string;
      maximumSeconds: number;
      isolateNetwork: boolean;
      guards: Guards;
    },
    private readonly processes: Pick<
      ProcessService | ProcessManager,
      'start' | 'listWorkspace' | 'action'
    >,
    private readonly version: () => Promise<string> = nativeVersion
  ) {
    this.#store = new WorkflowStore(config.secret);
  }
  #root(workspaceId: string) {
    return workspacePath(this.config.workspaceRoot, workspaceId);
  }
  async #lock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(work);
    this.#locks.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.#locks.get(key) === pending) this.#locks.delete(key);
    }
  }
  async #source(root: string, requested: string): Promise<string> {
    const name = assertUserDataPath(root, requested);
    if (!name.startsWith('workspace/') || name.includes(','))
      throw new Error(
        'Workflow source and config must be project files without commas in their paths'
      );
    const opened = await openDownloadFile(root, name);
    await opened.handle.close();
    return name;
  }
  #command(record: WorkflowRecord, attempt: WorkflowAttempt) {
    return workflowCommand({
      workflowId: record.workflowId,
      attempt: attempt.number,
      script: record.spec.script,
      configs: record.spec.configs,
      network: record.spec.network,
      ...(attempt.resumeSession ? { resumeSession: attempt.resumeSession } : {})
    });
  }
  async #view(
    root: string,
    record: WorkflowRecord,
    attempt: WorkflowAttempt,
    jobs?: JobSnapshot[]
  ): Promise<WorkflowRun> {
    const command = this.#command(record, attempt);
    const job = (jobs ?? (await this.processes.listWorkspace(record.workspaceId))).find(
      (job) => job.sessionId === attempt.jobId
    );
    let state: WorkflowRun['state'] = 'preparing';
    if (attempt.phase === 'cancelled') state = 'cancelled';
    else if (job)
      state =
        job.status === 'running'
          ? 'running'
          : job.status === 'completed'
            ? 'completed'
            : job.status === 'stopped'
              ? 'cancelled'
              : job.status === 'interrupted'
                ? 'interrupted'
                : 'failed';
    else if (attempt.state)
      state = ['completed', 'cancelled', 'failed', 'interrupted'].includes(attempt.state)
        ? (attempt.state as WorkflowRun['state'])
        : 'interrupted';
    else if (attempt.phase !== 'prepared' || !this.#locks.has(root)) state = 'interrupted';
    if (
      job &&
      (attempt.state !== state ||
        attempt.startedAt !== job.startedAt ||
        attempt.finishedAt !== job.finishedAt)
    ) {
      await this.#store.update(root, record.workflowId, record.owner, attempt.number, {
        state,
        startedAt: job.startedAt,
        ...(job.finishedAt ? { finishedAt: job.finishedAt } : {})
      });
    }
    let progress: WorkflowRun['progress'] = null;
    let note = attempt.note;
    try {
      progress = await this.#trace.read(root, command.tracePath);
    } catch (error) {
      note = `Progress could not be read: ${error instanceof Error ? error.message : 'invalid trace'}`;
    }
    if (!job && attempt.phase === 'prepared' && state === 'interrupted')
      note =
        'The workflow intent was saved but not dispatched. Resume to finish the original launch; no stage has been started by this intent.';
    if (!job && attempt.phase === 'dispatching')
      note =
        'Launch acknowledgement was lost and no job receipt is available. No command was repeated. Inspect the work directory before explicitly resuming.';
    return {
      workflowId: record.workflowId,
      workspaceId: record.workspaceId,
      ownerTaskId: record.owner,
      name: record.spec.name,
      engine: 'nextflow',
      engineVersion: attempt.engineVersion,
      script: record.spec.script,
      directory: command.directory,
      state,
      attempt: attempt.number,
      canResume:
        record.attempt === attempt.number &&
        !active(state) &&
        !(job?.status === 'stopped' && !job.finishedAt),
      sessionId: attempt.jobId,
      createdAt: record.createdAt,
      startedAt: job?.startedAt ?? attempt.startedAt ?? null,
      finishedAt: job?.finishedAt ?? attempt.finishedAt ?? null,
      progress,
      tracePath: command.tracePath,
      reportPath: command.reportPath,
      timelinePath: command.timelinePath,
      ...(note ? { note } : {})
    };
  }
  async list(workspaceId: string, owner: string | null, after = '', limit = 50) {
    const root = this.#root(workspaceId),
      stored = await this.#store.list(root, owner, after, limit),
      jobs = await this.processes.listWorkspace(workspaceId);
    const workflows = [];
    for (const entry of stored.records)
      workflows.push(await this.#view(root, entry.record, entry.attempt, jobs));
    return { workflows, next: stored.next };
  }
  async decorate<T extends JobSnapshot>(
    workspaceId: string,
    jobs: T[]
  ): Promise<Array<T & { workflow?: WorkflowRun }>> {
    const root = this.#root(workspaceId),
      records = await this.#store.forJobs(
        root,
        jobs.map((job) => job.sessionId)
      );
    const views = new Map<string, WorkflowRun>();
    for (const { record, attempt } of records) {
      const view = await this.#view(root, record, attempt, jobs);
      if (attempt.jobId) views.set(attempt.jobId, view);
    }
    return jobs.map((job) => {
      const workflow = views.get(job.sessionId);
      return { ...job, ...(workflow ? { workflow } : {}) };
    });
  }
  async status(workspaceId: string, owner: string | null, id: string) {
    const root = this.#root(workspaceId),
      entry = await this.#store.get(root, id, owner);
    return this.#view(root, entry.record, entry.attempt);
  }
  async plan(workspaceId: string, owner: string, id: string) {
    const { record, attempt } = await this.#store.get(this.#root(workspaceId), id, owner);
    return {
      ownerTaskId: record.owner,
      workspaceId: record.workspaceId,
      name: record.spec.name,
      script: record.spec.script,
      configs: record.spec.configs,
      network: record.spec.network,
      parameters: attempt.parameters
    };
  }
  async resumeByOwner(workspaceId: string, id: string, attempt: number) {
    const { record } = await this.#store.get(this.#root(workspaceId), id, null);
    return this.act(
      workspaceId,
      record.owner,
      { action: 'resume', workflowId: id },
      `owner-resume:${id}:${attempt}`,
      attempt
    );
  }
  async act(
    workspaceId: string,
    owner: string | null,
    value: unknown,
    requestId?: string,
    expectedAttempt?: number
  ): Promise<unknown> {
    const request = WorkflowRequest.parse(value),
      root = this.#root(workspaceId);
    if (request.action === 'list')
      return this.list(workspaceId, owner, request.after, request.limit);
    if (request.action === 'status') return this.status(workspaceId, owner, request.workflowId);
    if (request.action !== 'cancel' && !owner)
      throw new Error('Workflow execution requires an owning task');
    return this.#lock(root, async () => {
      await ensureWorkspace(root);
      if (request.action === 'cancel') {
        const { record, attempt } = await this.#store.get(root, request.workflowId, owner);
        const current = await this.#view(root, record, attempt);
        if (!active(current.state) && current.state !== 'interrupted') return current;
        if (attempt.jobId) {
          const jobs = await this.processes.listWorkspace(workspaceId);
          if (jobs.some((job) => job.sessionId === attempt.jobId))
            await this.processes.action(workspaceId, owner, attempt.jobId, { action: 'kill' });
        }
        const changed = await this.#store.update(root, record.workflowId, owner, attempt.number, {
          phase: 'cancelled',
          state: 'cancelled',
          finishedAt: new Date().toISOString()
        });
        return this.#view(root, record, changed);
      }
      if (!requestId) throw new Error('Workflow execution requires a stable requestId');
      const prior = await this.#store.lookup(root, owner!, requestId, request);
      if (prior) {
        if (prior.record.attempt !== prior.attempt.number)
          return this.status(workspaceId, owner, prior.record.workflowId);
        return this.#launch(root, prior.record, prior.attempt);
      }
      let entry;
      if (request.action === 'start') {
        const script = await this.#source(root, request.script),
          configs: string[] = [];
        for (const name of request.configs) configs.push(await this.#source(root, name));
        const engineVersion = await this.version();
        entry = await this.#store.claim(root, owner!, requestId, request, () => ({
          workspaceId,
          owner: owner!,
          createdAt: new Date().toISOString(),
          engineVersion,
          spec: {
            name: request.name,
            script,
            configs,
            parameters: request.parameters,
            network: request.network
          }
        }));
      } else {
        const { record, attempt } = await this.#store.get(root, request.workflowId, owner);
        if (expectedAttempt !== undefined && attempt.number !== expectedAttempt)
          throw new Error('Workflow has a newer attempt; refresh its state before resuming');
        const current = await this.#view(root, record, attempt);
        const job = (await this.processes.listWorkspace(workspaceId)).find(
          (job) => job.sessionId === attempt.jobId
        );
        if (job && job.status === 'stopped' && !job.finishedAt)
          throw new Error(
            'Workflow is stopping; wait for the process and its children to exit before resuming'
          );
        if (active(current.state) && attempt.phase !== 'prepared')
          throw new Error('Workflow is still active; wait or cancel it before resuming');
        if (attempt.phase === 'prepared' && request.parameters !== undefined)
          throw new Error(
            'Resume the undispatched launch without parameter changes, or cancel it and start a new workflow'
          );
        await this.#source(root, record.spec.script);
        for (const config of record.spec.configs) await this.#source(root, config);
        entry = await this.#store.claim(
          root,
          owner!,
          requestId,
          request,
          () => {
            throw new Error('Missing workflow');
          },
          {
            workflowId: record.workflowId,
            attempt: attempt.number,
            parameters: { ...attempt.parameters, ...request.parameters },
            resumeSession: workflowRunName(record.workflowId, attempt.number),
            engineVersion: await this.version(),
            reusePrepared: attempt.phase === 'prepared'
          }
        );
      }
      return this.#launch(root, entry.record, entry.attempt);
    });
  }
  async #file(root: string, name: string, content: string) {
    try {
      await createWorkspaceFile(root, name, Buffer.from(content), 1024 * 1024);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const opened = await openDownloadFile(root, name);
      try {
        if (opened.stat.size > 1024 * 1024 || (await opened.handle.readFile('utf8')) !== content)
          throw new Error('Workflow launch files changed; refusing to overwrite them');
      } finally {
        await opened.handle.close();
      }
    }
  }
  async #launch(
    root: string,
    record: WorkflowRecord,
    attempt: WorkflowAttempt
  ): Promise<WorkflowRun> {
    if (attempt.phase !== 'prepared') return this.#view(root, record, attempt);
    const command = this.#command(record, attempt),
      directory = `${command.directory}/attempt-${attempt.number}`;
    await this.#file(
      root,
      `${directory}/parameters.json`,
      JSON.stringify(attempt.parameters, null, 2) + '\n'
    );
    await this.#file(root, `${directory}/garden.config`, WORKFLOW_CONFIG);
    const requestId = `workflow:${record.workflowId}:${attempt.number}`;
    const pending = await this.#store.update(
      root,
      record.workflowId,
      record.owner,
      attempt.number,
      { phase: 'dispatching', jobId: jobIdentity(record.workspaceId, record.owner, requestId) }
    );
    try {
      await this.processes.start(
        root,
        record.workspaceId,
        record.owner,
        { ...command.launch, job: record.spec.name, requestId },
        this.config.maximumSeconds,
        this.config.isolateNetwork,
        this.config.guards
      );
      const launched = await this.#store.update(
        root,
        record.workflowId,
        record.owner,
        attempt.number,
        { phase: 'launched' }
      );
      return this.#view(root, record, launched);
    } catch (error) {
      await this.#store.update(root, record.workflowId, record.owner, attempt.number, {
        note:
          error instanceof Error ? error.message.slice(0, 1000) : 'Launch could not be acknowledged'
      });
      return this.#view(root, record, pending);
    }
  }
}
