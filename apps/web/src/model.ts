import type {
  Project,
  ConversationSource,
  DirectionContext,
  TaskResult,
  ModelRelease,
  Task,
  TaskEvent,
  TaskPlan,
  Workspace,
  PrivacyRoute,
  TaskReasoningEffort,
  ProjectModelChoices,
  TaskSchedule
} from '@athanor/contracts';
export interface DraftAttachment {
  path: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
}
export interface Draft {
  workspaceId: string;
  taskId: string | null;
  body: string;
  attachments: DraftAttachment[];
  updatedAt?: string;
  revision?: number;
  recoveryId?: string;
  controls?: {
    context?: DirectionContext;
    conversation?: {
      projectId: string;
      execution: 'independent' | 'shared';
      source?: ConversationSource;
    };
    modelId: string;
    modelChoices?: ProjectModelChoices;
    reasoningEffort: TaskReasoningEffort;
    securityMode?: Task['securityMode'];
    privacyRoute: PrivacyRoute;
    spendCap: string;
  };
}
export interface Bootstrap {
  projects?: Project[];
  projectsCursor?: string | null;
  user: {
    id: string;
    username?: string;
    displayName?: string;
    preferences?: Record<string, unknown>;
  };
  workspaces: Workspace[];
  tasks: Task[];
  tasksCursor: string | null;
  scheduleRunCounts: Record<string, number>;
  schedules: TaskSchedule[];
  drafts: Draft[];
  models: (Pick<
    ModelRelease,
    | 'id'
    | 'providerModelId'
    | 'displayName'
    | 'provider'
    | 'availability'
    | 'privacyRoute'
    | 'reasoning'
    | 'recommendationTags'
  > &
    Partial<Pick<ModelRelease, 'modalities' | 'nativeInputPricing'>>)[];
  instance: {
    mode: string;
    providerConfigured: boolean;
    enforceZeroDataRetention: boolean;
    webSearch: unknown;
  };
  computer?: {
    cpuPercent: number;
    memoryUsedBytes: number;
    memoryTotalBytes: number;
  };
  usage: {
    providerSpend: unknown;
    consumedCredits: number;
    reservedCredits: number;
    storageBytes: number;
    storageLimitBytes: number;
    plan: {
      provider: 'ollama-cloud' | 'openrouter';
      windows: {
        label: string;
        used: number | null;
        limit: number | null;
        unit: 'fraction' | 'usd';
        resetsAt: string | null;
      }[];
      queriedAt: string;
    } | null;
  };
}
export interface Decision {
  id: string;
  taskId: string;
  action: string;
  origin: string | null;
  sideEffect: string;
  status: string;
  expiresAt: string;
  createdAt: string;
  preview: Record<string, unknown> | string;
  cursor?: string;
}
export const statusLabel: Record<Task['status'], string> = {
  draft: 'Draft',
  queued: 'Queued',
  planning: 'Planning',
  running: 'Working',
  awaiting_user: 'Needs you',
  awaiting_resource: 'Waiting for resources',
  paused: 'Paused',
  completed: 'Run ended',
  failed: 'Needs recovery',
  cancelled: 'Cancelled'
};
export const isWorking = (task: Task): boolean =>
  ['queued', 'planning', 'running'].includes(task.status);
export const hasOngoingWork = (task: Task): boolean =>
  isWorking(task) ||
  task.deliveryStatus === 'pending' ||
  (task.status === 'awaiting_resource' && task.resourceWait?.code === 'background_jobs');
export const needsAttention = (task: Task): boolean =>
  task.hasOpenQuestion === true ||
  (['awaiting_user', 'awaiting_resource', 'failed'].includes(task.status) &&
    task.resourceWait?.code !== 'background_jobs') ||
  (task.status === 'completed' && task.deliveryStatus === 'incomplete');
export const taskStatusLabel = (
  task: Task,
  evidence?: { openSteps: number; interrupted: boolean; verification: string | null }
): string => {
  const openSteps =
    evidence?.openSteps ??
    (task.activity
      ? Math.max(
          0,
          task.activity.stepsTotal -
            task.activity.stepsCompleted -
            (task.activity.stepsSkipped ?? 0)
        )
      : 0);
  const interrupted = evidence?.interrupted ?? task.activity?.ending?.interrupted;
  const verification = evidence?.verification ?? task.activity?.ending?.verification;
  if (task.hasOpenQuestion && isWorking(task)) return 'Working · answer requested';
  if (task.status === 'awaiting_resource' && task.resourceWait?.code === 'background_jobs')
    return 'Background work is running';
  if (task.status !== 'completed') return statusLabel[task.status];
  if (task.deliveryStatus === 'pending') return 'Generating media';
  if (task.deliveryStatus === 'incomplete') return 'Delivery needs attention';
  if (openSteps > 0) return `Stopped with ${openSteps} step${openSteps === 1 ? '' : 's'} open`;
  if (interrupted) return 'Interrupted · review needed';
  if (verification)
    return ['verified', 'not_applicable'].includes(verification) ? 'Completed' : 'Needs review';
  return 'Run ended';
};
export const isFinished = (task: Task): boolean =>
  ['completed', 'failed', 'cancelled'].includes(task.status);
export const data = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const text = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;
export const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
export const eventText = (event: TaskEvent): string => {
  const payload = data(event.payload);
  return text(
    payload.markdown,
    text(payload.text, text(payload.delta, text(payload.question, event.summary)))
  );
};
export const money = (value: number): string =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2
  }).format(value);
export const bytes = (value: number): string =>
  value < 1000
    ? `${value} B`
    : value < 1e6
      ? `${(value / 1000).toFixed(1)} kB`
      : value < 1e9
        ? `${(value / 1e6).toFixed(1)} MB`
        : `${(value / 1e9).toFixed(1)} GB`;
export const date = (value: string): string =>
  new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const shortDate = (value: string): string =>
  new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
/**
 * How long a run has been going, or took, for the owner to glance at. `from`/`to` are ISO
 * timestamps; a `to` of undefined means the clock is still running. Under an hour reads as
 * minutes, past it as hours and the remaining minutes.
 */
export const duration = (from: string, to?: string | null): string => {
  const start = Date.parse(from);
  if (!Number.isFinite(start)) return '';
  const end = to ? Date.parse(to) : Date.now();
  const totalMs = Math.max(0, (Number.isFinite(end) ? end : Date.now()) - start);
  const totalMinutes = Math.floor(totalMs / 60_000);
  if (totalMinutes < 1) return `${Math.floor(totalMs / 1000)}s`;
  if (totalMinutes < 60) return `${totalMinutes}m`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
};
export function lastEvent(events: TaskEvent[], kind: TaskEvent['kind']): TaskEvent | undefined {
  return [...events].reverse().find((event) => event.kind === kind);
}
export function activeQuestion(events: TaskEvent[], task: Task): TaskEvent | undefined {
  if (['completed', 'cancelled', 'failed'].includes(task.status)) return undefined;
  const question = lastEvent(events, 'question_asked');
  if (!question) return undefined;
  const asynchronous = Boolean(data(question.payload).continueWith);
  if (task.status !== 'awaiting_user' && !asynchronous) return undefined;
  return events.some(
    (event) =>
      event.sequence > question.sequence &&
      (event.kind === 'completed' ||
        (['queued_message', 'user_message'].includes(event.kind) &&
          (data(event.payload).questionId === question.id ||
            (!asynchronous && event.kind === 'user_message'))))
  )
    ? undefined
    : question;
}
/** Stream fragments remain readable after a task pauses; only an active stream is still writing. */
export function answerIsStreaming(events: TaskEvent[], status: Task['status']): boolean {
  if (status !== 'running' && status !== 'planning') return false;
  for (let index = events.length - 1; index >= 0; index--) {
    const kind = events[index]!.kind;
    if (kind === 'assistant_delta') return true;
    if (
      [
        'assistant_message',
        'user_message',
        'tool_started',
        'tool_result',
        'cost',
        'status',
        'approval_requested',
        'question_asked',
        'completed',
        'error'
      ].includes(kind)
    )
      return false;
  }
  return false;
}

export function surfaceAnswer(events: TaskEvent[]): {
  markdown: string;
  partial: boolean;
  previous: boolean;
} {
  const message = lastEvent(events, 'assistant_message');
  const completed = lastEvent(events, 'completed');
  const finish = data(completed?.payload);
  const boundary = Math.max(
    message?.sequence ?? 0,
    lastEvent(events, 'user_message')?.sequence ?? 0,
    lastEvent(events, 'completed')?.sequence ?? 0
  );
  let markdown = '';
  let streamId = '';
  let separated = false;
  for (const event of events) {
    if (event.sequence <= boundary) continue;
    if (event.kind !== 'assistant_delta') {
      if (['tool_started', 'tool_result', 'cost', 'status', 'error'].includes(event.kind))
        separated = true;
      continue;
    }
    const payload = data(event.payload);
    if (payload.heartbeat === true) continue;
    const nextId = text(payload.streamId);
    const fragment = eventText(event);
    if (!fragment) continue;
    if (markdown && (nextId ? nextId !== streamId : separated)) markdown += '\n\n';
    markdown += fragment;
    streamId = nextId;
    separated = false;
  }
  if (markdown) return { markdown, partial: true, previous: false };
  return {
    markdown:
      completed && completed.sequence > (message?.sequence ?? 0)
        ? text(finish.answer) || text(finish.summary)
        : message
          ? eventText(message)
          : text(finish.answer) || text(finish.summary),
    partial: false,
    previous:
      (lastEvent(events, 'user_message')?.sequence ?? 0) >
      Math.max(message?.sequence ?? 0, completed?.sequence ?? 0)
  };
}
export function planProgress(plan: TaskPlan | null): { completed: number; total: number } {
  const steps = plan?.steps.filter((step) => step.status !== 'skipped') ?? [];
  return {
    completed: steps.filter((step) => step.status === 'completed').length,
    total: steps.length
  };
}
export const defaultPrivacy = (bootstrap: Bootstrap): PrivacyRoute =>
  bootstrap.instance.enforceZeroDataRetention ||
  bootstrap.models.some(
    (model) => model.privacyRoute === 'provider_zdr' && model.availability === 'available'
  )
    ? 'provider_zdr'
    : 'external';

export function mergeTaskRefresh(
  current: Bootstrap | null,
  fresh: Bootstrap,
  preserveCursor: boolean,
  removed: ReadonlySet<string> = new Set()
): Bootstrap {
  if (!current || current.user.id !== fresh.user.id) return fresh;
  return {
    ...fresh,
    tasks: [...new Map([...fresh.tasks, ...current.tasks].map((task) => [task.id, task])).values()]
      .map((task) => {
        const update = fresh.tasks.find((candidate) => candidate.id === task.id);
        return update && update.updatedAt >= task.updatedAt ? update : task;
      })
      .filter((task) => !removed.has(task.id)),
    tasksCursor: preserveCursor ? current.tasksCursor : fresh.tasksCursor,
    scheduleRunCounts: { ...current.scheduleRunCounts, ...fresh.scheduleRunCounts }
  };
}

/** Preserve the result identity selected by the owner, including immutable version metadata. */
export function conversationResultSource(taskId: string, result: TaskResult): ConversationSource {
  const eventId = result.evidenceEventIds.find((id) =>
    /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)
  );
  return {
    taskId,
    ...(eventId ? { eventId } : {}),
    ...(result.path
      ? {
          filePath: result.path.startsWith('workspace/') ? result.path : `workspace/${result.path}`
        }
      : {}),
    result: {
      id: result.id,
      kind: result.kind,
      title: result.title,
      ...(result.version ? { version: result.version } : {}),
      ...(result.sha256 && /^[a-f0-9]{64}$/i.test(result.sha256) ? { sha256: result.sha256 } : {}),
      ...(result.workspaceId ? { workspaceId: result.workspaceId } : {}),
      ...(result.artifactId ? { artifactId: result.artifactId } : {}),
      ...(result.previewId ? { previewId: result.previewId } : {})
    }
  };
}
