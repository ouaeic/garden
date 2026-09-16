import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AthanorError, decryptJson, encryptJson, unwrapDataKey, wrapDataKey } from '@athanor/core';
import type { TaskEvent } from '@athanor/contracts';
import type { ProjectExecutionRecord, TaskRecord } from '@athanor/data';
import type { SupportedContext } from './http/server-context.js';
import { TaskEvidenceReader } from './task-evidence.js';
import { taskSourceFiles } from './task-presentation.js';

type Context = Pick<SupportedContext, 'store' | 'database' | 'masterKey' | 'runner'>;
type Manifest = { paths: string[]; kind: 'new' | 'legacy' };
const aad = (taskId: string) => `project-execution:${taskId}`;
const BRIEFS = ['workspace/ATHANOR.md', 'workspace/AGENTS.md', 'workspace/OPEN_CLOUD.md'];
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Recorded path arguments identify a project's sources without copying another project's state. */
export function projectSourcePaths(
  events: readonly TaskEvent[],
  attachments: string[] = []
): string[] {
  const namedAttachments = [
    ...attachments,
    ...events.flatMap((event) => {
      const paths = record(event.payload).attachments;
      return event.kind === 'user_message' && Array.isArray(paths)
        ? paths.filter((value): value is string => typeof value === 'string' && value.length <= 400)
        : [];
    })
  ];
  const found = new Set<string>([
    ...BRIEFS,
    ...namedAttachments,
    ...taskSourceFiles(events).keys()
  ]);
  const add = (value: unknown, cwd = 'workspace') => {
    if (typeof value !== 'string' || value.length > 1024 || value.includes('\0')) return;
    const relative = value.startsWith('workspace/') ? value : path.posix.join(cwd, value);
    if (relative.startsWith('workspace/') && !relative.split('/').includes('..'))
      found.add(relative);
  };
  for (const event of events) {
    if (event.kind !== 'tool_started') continue;
    const args = record(record(event.payload).arguments),
      cwd = typeof args.cwd === 'string' ? args.cwd : 'workspace';
    if (cwd !== 'workspace') add(cwd);
    for (const key of ['path', 'directory', 'sourceRoot', 'source', 'destination'])
      add(args[key], cwd);
    if (Array.isArray(args.paths)) for (const value of args.paths) add(value, cwd);
    if (Array.isArray(args.args))
      for (const value of args.args)
        if (typeof value === 'string') {
          for (const match of value.matchAll(/\bworkspace\/[a-zA-Z0-9_.\-/]+/g)) add(match[0]);
          for (const match of value.matchAll(/(?:^|[;&]\s*|\s)cd\s+["']?([a-zA-Z0-9_.\-/]+)/g))
            add(match[1], cwd);
        }
  }
  const exactAttachments = new Set(namedAttachments.map((value) => path.posix.normalize(value)));
  const selected = new Set<string>();
  for (const value of found) {
    const normalized = path.posix.normalize(value);
    if (
      !normalized.startsWith('workspace/') ||
      normalized
        .split('/')
        .some((part) =>
          ['.athanor', '.garden', '.home', '.git', 'node_modules', '.venv'].includes(part)
        )
    )
      continue;
    const parts = normalized.split('/');
    selected.add(
      parts.length > 2 &&
        !exactAttachments.has(normalized) &&
        !['uploads', 'downloads'].includes(parts[1]!)
        ? parts.slice(0, 2).join('/')
        : normalized
    );
  }
  if (selected.size > 128)
    throw new AthanorError(
      'project_sources_limit',
      'This project names too many independent source locations to prepare safely.',
      409
    );
  return [...selected].sort();
}

export async function beginProjectExecution(
  context: Context,
  task: TaskRecord,
  attachments?: string[],
  independent = false
): Promise<ProjectExecutionRecord | null> {
  const workspace = await context.store.getWorkspace(task.userId, task.workspaceId);
  if (!workspace?.wrappedKey) throw new AthanorError('workspace_not_found', 'Workspace not found');
  const prior = await context.store.getProjectExecution(task.userId, task.id);
  if ((workspace.parentWorkspaceId && !independent && !prior) || task.parentMissionId) return null;
  const key = unwrapDataKey(workspace.wrappedKey, context.masterKey, workspace.id);
  if (task.agentStateCiphertext) {
    const state = decryptJson<{ pending?: { approvalId?: string } }>(
      task.agentStateCiphertext,
      key
    );
    if (
      state.pending?.approvalId &&
      (await context.store.getApproval(state.pending.approvalId))?.status === 'approved'
    )
      return null;
  }
  const manifest: Manifest = prior
    ? decryptJson(prior.sourceManifestCiphertext, key, aad(task.id))
    : {
        kind: attachments ? 'new' : 'legacy',
        paths: attachments
          ? projectSourcePaths([], attachments)
          : projectSourcePaths(
              (await new TaskEvidenceReader(context.database).read(task.id, key)).events
            )
      };
  const workspaceId = prior?.workspaceId ?? randomUUID();
  return context.store.beginProjectExecution({
    userId: task.userId,
    taskId: task.id,
    workspaceId,
    wrappedKey: wrapDataKey(key, context.masterKey, workspaceId),
    seedKind: manifest.kind,
    independent,
    sourceManifestCiphertext: encryptJson(manifest, key, aad(task.id))
  });
}

export async function configureConversationInputs(
  context: Context,
  task: TaskRecord,
  workspaceId = task.workspaceId
) {
  if (!task.projectId) return;
  const project = await context.store.getProject(task.userId, task.projectId);
  if (!project) throw new Error('Project membership is unavailable');
  await context.runner.request({
    workspaceId: project.workspaceId,
    userId: task.userId,
    role: 'control',
    scopes: ['workspace.manage'],
    method: 'PUT',
    path: `/v1/workspaces/${project.workspaceId}/projects/${project.id}/members`,
    contentType: 'application/json',
    body: JSON.stringify([{ taskId: task.id, workspaceId }])
  });
  await context.runner.request({
    workspaceId,
    userId: task.userId,
    role: 'control',
    scopes: ['workspace.manage'],
    method: 'PUT',
    path: `/v1/workspaces/${workspaceId}/project-inputs`,
    contentType: 'application/json',
    body: JSON.stringify({ sources: [], projects: [task.projectId] })
  });
}

export async function completeProjectExecution(
  context: Context,
  task: TaskRecord,
  execution: ProjectExecutionRecord | null
): Promise<TaskRecord> {
  if (!execution) {
    await configureConversationInputs(context, task);
    return task;
  }
  if (execution.status === 'ready') {
    const current = (await context.store.getTask(task.userId, task.id))!;
    await configureConversationInputs(context, current);
    return current;
  }
  const source = await context.store.getWorkspace(task.userId, execution.sourceWorkspaceId);
  if (!source?.wrappedKey) throw new AthanorError('workspace_not_found', 'Workspace not found');
  const key = unwrapDataKey(source.wrappedKey, context.masterKey, source.id);
  const manifest = decryptJson<Manifest>(execution.sourceManifestCiphertext, key, aad(task.id));
  try {
    const receipt = await context.runner.request<{
      status: 'ready' | 'shared';
      workspaceId: string;
      sourceWorkspaceId: string;
      taskId: string;
      bytes: number;
      handles?: Array<{ id: string; kind: string }>;
    }>({
      workspaceId: source.id,
      userId: task.userId,
      role: 'control',
      scopes: ['workspace.manage'],
      method: 'POST',
      path: `/v1/workspaces/${source.id}/project-execution`,
      contentType: 'application/json',
      body: JSON.stringify({ taskId: task.id, workspaceId: execution.workspaceId, ...manifest }),
      timeoutMs: 90_000
    });
    if (
      receipt.workspaceId !== execution.workspaceId ||
      receipt.sourceWorkspaceId !== source.id ||
      receipt.taskId !== task.id ||
      !['ready', 'shared'].includes(receipt.status)
    )
      throw new Error('Project preparation returned a mismatched receipt');
    if (receipt.status === 'ready')
      await configureConversationInputs(context, task, execution.workspaceId);
    const finished = await context.store.finishProjectExecution({
      userId: task.userId,
      taskId: task.id,
      workspaceId: execution.workspaceId,
      receiptCiphertext: encryptJson(receipt, key, aad(task.id)),
      ...(receipt.status === 'shared' ? { sharedReason: 'project_active_writer' } : {}),
      rewrite: (current) => ({
        ...(current.agentStateCiphertext
          ? (() => {
              const state = decryptJson<{ pending?: { approvalId?: string } }>(
                current.agentStateCiphertext,
                key
              );
              return state.pending?.approvalId
                ? { pendingApprovalId: state.pending.approvalId }
                : {};
            })()
          : {}),
        titleCiphertext: encryptJson(
          current.titleCiphertext
            ? decryptJson(current.titleCiphertext, key)
            : { title: current.legacyTitle ?? 'Project' },
          key,
          `task-title:${execution.workspaceId}`
        ),
        promptCiphertext: encryptJson(
          decryptJson(current.promptCiphertext, key),
          key,
          `task-prompt:${execution.workspaceId}`
        )
      })
    });
    if (!finished) throw new Error('Project execution changed during preparation');
    if (receipt.status === 'ready')
      await context.store.setWorkspaceStorage(task.userId, execution.workspaceId, receipt.bytes);
    const updated = (await context.store.getTask(task.userId, task.id))!;
    const activated = updated.workspaceId === execution.workspaceId;
    if (activated) await configureConversationInputs(context, updated);
    await context.store.appendTaskEvent({
      taskId: task.id,
      kind: 'notice',
      summary: activated ? 'Project execution is ready' : 'Project retains its original workspace',
      payloadCiphertext: encryptJson(
        {
          headline: activated
            ? 'Independent project workspace ready'
            : 'Active work retains its original workspace',
          detail: activated
            ? 'Project files were copied and verified. Existing published links and background services remain on the original computer.'
            : receipt.status === 'ready'
              ? 'An approved action retains its exact original execution scope. The project will prepare an independent workspace after that action.'
              : `This project has active ${receipt.handles?.map((handle) => `${handle.kind} ${handle.id}`).join(', ') ?? 'managed work'}. Its current files and handles remain together until that work finishes.`,
          sourceWorkspaceId: source.id,
          workspaceId: execution.workspaceId
        },
        key,
        `task-event:${task.id}`
      )
    });
    return updated;
  } catch (error) {
    await context.store.failProjectExecution(task.userId, task.id, 'project_preparation_failed');
    throw error;
  }
}

export async function ensureProjectExecution(
  context: Context,
  task: TaskRecord
): Promise<TaskRecord> {
  const updated = await completeProjectExecution(
    context,
    task,
    await beginProjectExecution(context, task)
  );
  return updated;
}

export async function recoverProjectExecutions(context: Context): Promise<void> {
  for (const pending of await context.store.pendingProjectExecutions()) {
    const task = await context.store.getTask(pending.userId, pending.taskId);
    if (task) await ensureProjectExecution(context, task);
  }
}
