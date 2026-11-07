import { useCallback, useEffect, useRef, useState } from 'react';
import type { Artifact, Task, TaskEvent, TaskPlan, TaskPresentation } from '@garden/contracts';
import { ApiError, get } from './client';
import { loadEventPage, subscribeTaskEvents } from './stream';
import type { EventPage, StreamConnection } from './stream';
import { presentationArtifacts } from './task-artifacts';
import { deskIsLive, gardenState } from './app/store';

interface TaskRecordOptions {
  taskId: string;
  workspaceId: string;
  onTask: (task: Task) => void;
  onRefresh: () => void;
}

/** The four things about a goal that live outside its timeline, read apart from each other. */
type Part = 'task' | 'plan' | 'artifacts' | 'presentation';
const EVERY_PART: ReadonlySet<Part> = new Set(['task', 'plan', 'artifacts', 'presentation']);

/**
 * What each kind of event can have changed besides the timeline it is already part of.
 *
 * A kind that is not here changes nothing outside it - a streamed reply, above all, which is
 * most of the events a goal writes. The presentation is read from the evidence, so anything that
 * adds to the results, the steps or the decisions changes it; the saved files change only when
 * something is saved or published; the task itself, only when its state moves.
 */
const CHANGES: Partial<Record<TaskEvent['kind'], readonly Part[]>> = {
  completed: ['task', 'plan', 'artifacts', 'presentation'],
  plan: ['plan', 'presentation'],
  artifact: ['artifacts', 'presentation'],
  preview: ['artifacts', 'presentation'],
  tool_result: ['presentation'],
  approval_requested: ['task', 'presentation'],
  approval_resolved: ['task', 'presentation'],
  question_asked: ['task', 'presentation'],
  error: ['task', 'presentation'],
  status: ['task', 'presentation'],
  cost: ['task']
};
/** The kinds that change the desk as well as this goal: what it shows waiting, done or stopped. */
const DESK_KINDS = new Set<TaskEvent['kind']>([
  'completed',
  'approval_requested',
  'approval_resolved',
  'question_asked',
  'error',
  'status'
]);

const readFailure = (subject: string, cause: unknown): Error => {
  const message = `${subject}. ${cause instanceof Error ? cause.message : 'Please try again.'}`;
  return cause instanceof ApiError
    ? new ApiError(cause.code, message, cause.status, cause.details, cause.requestId)
    : new Error(message);
};

export function useTaskRecord({ taskId, workspaceId, onTask, onRefresh }: TaskRecordOptions) {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [plan, setPlan] = useState<TaskPlan | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [storedPresentation, setPresentation] = useState<TaskPresentation | null>(null);
  const [initialPage, setInitialPage] = useState<EventPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [recordError, setRecordError] = useState<unknown>(null);
  const [historyError, setHistoryError] = useState<unknown>(null);
  const [connection, setConnection] = useState<StreamConnection>('connecting');
  const lifetime = useRef<AbortController | null>(null);
  const retryHistory = useRef<(() => Promise<void>) | null>(null);
  const pendingReload = useRef<{
    signal: AbortSignal;
    queued: Set<Part>;
    promise: Promise<void>;
  } | null>(null);
  /** The last saved files and presentation read, so either can be read again without the other. */
  const known = useRef<{ artifacts: Artifact[] | null; presentation: TaskPresentation | null }>({
    artifacts: null,
    presentation: null
  });
  const onTaskRef = useRef(onTask);
  onTaskRef.current = onTask;
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const reloadRecords = useCallback(
    (requestedSignal?: AbortSignal, parts: ReadonlySet<Part> = EVERY_PART): Promise<void> => {
      const signal = requestedSignal ?? lifetime.current?.signal;
      if (!signal || signal.aborted || parts.size === 0) return Promise.resolve();
      if (pendingReload.current?.signal === signal) {
        for (const part of parts) pendingReload.current.queued.add(part);
        return pendingReload.current.promise;
      }
      const read = async (wanted: ReadonlySet<Part>) => {
        const options = { signal };
        const unread = Promise.resolve(null);
        const results = await Promise.allSettled([
          wanted.has('task') ? get<Task>(`/v1/tasks/${taskId}`, options) : unread,
          wanted.has('plan') ? get<TaskPlan | null>(`/v1/tasks/${taskId}/plan`, options) : unread,
          wanted.has('artifacts')
            ? get<Artifact[]>(
                `/v1/workspaces/${workspaceId}/artifacts?taskId=${encodeURIComponent(taskId)}`,
                options
              )
            : unread,
          wanted.has('presentation')
            ? get<TaskPresentation>(`/v1/tasks/${taskId}/presentation`, options)
            : unread
        ]);
        if (signal.aborted) return;
        const [nextTask, nextPlan, nextArtifacts, nextPresentation] = results;
        if (wanted.has('task') && nextTask.status === 'fulfilled' && nextTask.value)
          onTaskRef.current(nextTask.value);
        if (wanted.has('plan') && nextPlan.status === 'fulfilled') setPlan(nextPlan.value);
        if (wanted.has('artifacts') && nextArtifacts.status === 'fulfilled' && nextArtifacts.value)
          known.current.artifacts = nextArtifacts.value;
        if (
          wanted.has('presentation') &&
          nextPresentation.status === 'fulfilled' &&
          nextPresentation.value
        ) {
          known.current.presentation = nextPresentation.value;
          setPresentation(nextPresentation.value);
        }
        if (wanted.has('artifacts') || wanted.has('presentation')) {
          const { presentation, artifacts: saved } = known.current;
          // Filtered here as well as on the server: a server that ignores `taskId` answers with
          // the whole computer's list, and this goal must still show only its own.
          if (presentation) setArtifacts(presentationArtifacts(presentation, saved ?? []));
          else if (saved) setArtifacts(saved.filter((item) => item.taskId === taskId));
        }
        const subjects = ['Its status', 'Its plan', 'Its files', 'What it made'];
        const order: readonly Part[] = ['task', 'plan', 'artifacts', 'presentation'];
        const failure = results.findIndex(
          (result, index) => wanted.has(order[index]!) && result.status === 'rejected'
        );
        const failed = results[failure];
        setRecordError(
          failed?.status === 'rejected'
            ? readFailure(`${subjects[failure]} could not be refreshed`, failed.reason)
            : null
        );
      };
      const pending = { signal, queued: new Set<Part>(), promise: Promise.resolve() };
      pendingReload.current = pending;
      pending.promise = (async () => {
        let wanted: ReadonlySet<Part> = parts;
        do {
          await read(wanted);
          wanted = new Set(pending.queued);
          pending.queued.clear();
        } while (wanted.size > 0 && !signal.aborted);
      })().finally(() => {
        if (pendingReload.current === pending) pendingReload.current = null;
      });
      return pending.promise;
    },
    [taskId, workspaceId]
  );
  const reload = useCallback(async () => {
    await Promise.all([reloadRecords(), retryHistory.current?.()]);
  }, [reloadRecords]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    known.current = { artifacts: null, presentation: null };
    let unsubscribe: () => void = () => undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const changed = new Set<Part>();
    let deskChanged = false;
    let initialized = false;
    let initializing: Promise<void> | undefined;
    /** Whether the timeline is reaching this goal by itself, which makes re-reading it pointless. */
    let following = false;
    setLoading(true);
    setError(null);
    setRecordError(null);
    setHistoryError(null);
    setConnection('connecting');
    const loadHistory = (): Promise<void> => {
      if (initialized || controller.signal.aborted) return Promise.resolve();
      if (initializing) return initializing;
      setConnection('connecting');
      initializing = loadEventPage(taskId, { limit: 250, signal: controller.signal })
        .then((page) => {
          if (controller.signal.aborted) return;
          setEvents(page.events);
          setInitialPage(page);
          setHistoryError(null);
          initialized = true;
          unsubscribe = subscribeTaskEvents(taskId, {
            after: page.nextCursor,
            signal: controller.signal,
            onEvents: (incoming) => {
              if (controller.signal.aborted) return;
              setEvents((current) =>
                Array.from(
                  new Map(
                    [...current, ...incoming].map((event) => [event.sequence, event])
                  ).values()
                )
                  .sort((a, b) => a.sequence - b.sequence)
                  .slice(-4000)
              );
              for (const event of incoming) {
                for (const part of CHANGES[event.kind] ?? []) changed.add(part);
                if (DESK_KINDS.has(event.kind)) deskChanged = true;
              }
              if (changed.size && !refreshTimer)
                refreshTimer = setTimeout(() => {
                  refreshTimer = undefined;
                  if (controller.signal.aborted || document.visibilityState === 'hidden') return;
                  // The desk's stream already keeps a listed task current, and the desk with it.
                  const desk = deskIsLive();
                  if (desk && gardenState().bootstrap?.tasks.some((task) => task.id === taskId))
                    changed.delete('task');
                  const parts = new Set(changed);
                  changed.clear();
                  void reloadRecords(controller.signal, parts);
                  if (deskChanged && !desk) onRefreshRef.current();
                  deskChanged = false;
                }, 1000);
            },
            onConnection: (state) => {
              if (controller.signal.aborted) return;
              setConnection(state);
              following = state === 'connected' || state === 'idle';
              if (state === 'connected' || state === 'idle') setHistoryError(null);
              if (state === 'closed') initialized = false;
            },
            onError: (cause) => {
              if (!controller.signal.aborted)
                setHistoryError(readFailure('Live updates were interrupted', cause));
            }
          });
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) {
            setHistoryError(readFailure('Its activity could not be loaded', cause));
            setConnection('closed');
          }
        })
        .finally(() => {
          initializing = undefined;
          if (!controller.signal.aborted) setLoading(false);
        });
      return initializing;
    };
    retryHistory.current = loadHistory;
    void Promise.all([loadHistory(), reloadRecords(controller.signal)]);
    const refreshVisible = () => {
      if (document.visibilityState !== 'hidden')
        void Promise.all([loadHistory(), reloadRecords(controller.signal)]);
    };
    // The re-read is for when the timeline is not arriving by itself: while it is, every change
    // that matters reaches this goal as an event, and is read again from there.
    const timer = setInterval(() => {
      if (!following) refreshVisible();
    }, 15000);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      controller.abort();
      if (retryHistory.current === loadHistory) retryHistory.current = null;
      document.removeEventListener('visibilitychange', refreshVisible);
      unsubscribe();
      clearInterval(timer);
      clearTimeout(refreshTimer);
    };
  }, [taskId, reloadRecords]);
  return {
    events,
    plan,
    setPlan,
    artifacts,
    storedPresentation,
    initialPage,
    loading,
    error: error ?? historyError ?? recordError,
    setError,
    connection,
    reload
  };
}
