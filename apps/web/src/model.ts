import type {
  Project,
  ConversationSource,
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
  completed: 'Complete',
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
  (['awaiting_user', 'awaiting_resource', 'failed'].includes(task.status) &&
    task.resourceWait?.code !== 'background_jobs') ||
  (task.status === 'completed' && task.deliveryStatus === 'incomplete');
export const taskStatusLabel = (task: Task): string =>
  task.status === 'awaiting_resource' && task.resourceWait?.code === 'background_jobs'
    ? 'Background work is running'
    : task.status === 'completed' && task.deliveryStatus === 'pending'
      ? 'Generating media'
      : task.status === 'completed' && task.deliveryStatus === 'incomplete'
        ? 'Delivery needs attention'
        : statusLabel[task.status];
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
  if (task.status !== 'awaiting_user') return undefined;
  const question = lastEvent(events, 'question_asked');
  if (!question) return undefined;
  return events.some(
    (event) =>
      event.sequence > question.sequence && ['user_message', 'completed'].includes(event.kind)
  )
    ? undefined
    : question;
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
  const deltas = events.filter(
    (event) => event.kind === 'assistant_delta' && event.sequence > boundary
  );
  if (deltas.length)
    return { markdown: deltas.map(eventText).join(''), partial: true, previous: false };
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
