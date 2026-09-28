import { useCallback, useEffect, useRef, useState } from 'react';
import type { Artifact, Task, TaskEvent, TaskPlan, TaskPresentation } from '@garden/contracts';
import { ApiError, get } from './client';
import { loadEventPage, subscribeTaskEvents } from './stream';
import type { EventPage, StreamConnection } from './stream';
import { presentationArtifacts } from './task-artifacts';

interface TaskRecordOptions {
  taskId: string;
  workspaceId: string;
  finished: boolean;
  onTask: (task: Task) => void;
  onRefresh: () => void;
}

const readFailure = (subject: string, cause: unknown): Error => {
  const message = `${subject}. ${cause instanceof Error ? cause.message : 'Please try again.'}`;
  return cause instanceof ApiError
    ? new ApiError(cause.code, message, cause.status, cause.details, cause.requestId)
    : new Error(message);
};

export function useTaskRecord({
  taskId,
  workspaceId,
  finished,
  onTask,
  onRefresh
}: TaskRecordOptions) {
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
    queued: boolean;
    promise: Promise<void>;
  } | null>(null);
  const onTaskRef = useRef(onTask);
  onTaskRef.current = onTask;
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const reloadRecords = useCallback(
    (requestedSignal?: AbortSignal): Promise<void> => {
      const signal = requestedSignal ?? lifetime.current?.signal;
      if (!signal || signal.aborted) return Promise.resolve();
      if (pendingReload.current?.signal === signal) {
        pendingReload.current.queued = true;
        return pendingReload.current.promise;
      }
      const read = async () => {
        const options = { signal };
        const results = await Promise.allSettled([
          get<Task>(`/v1/tasks/${taskId}`, options),
          get<TaskPlan | null>(`/v1/tasks/${taskId}/plan`, options),
          get<Artifact[]>(`/v1/workspaces/${workspaceId}/artifacts`, options),
          get<TaskPresentation>(`/v1/tasks/${taskId}/presentation`, options)
        ]);
        if (signal.aborted) return;
        const [nextTask, nextPlan, nextArtifacts, nextPresentation] = results;
        if (nextTask.status === 'fulfilled') onTaskRef.current(nextTask.value);
        if (nextPlan.status === 'fulfilled') setPlan(nextPlan.value);
        if (nextArtifacts.status === 'fulfilled')
          setArtifacts(
            nextPresentation.status === 'fulfilled'
              ? presentationArtifacts(nextPresentation.value, nextArtifacts.value)
              : nextArtifacts.value.filter((item) => item.taskId === taskId)
          );
        else if (nextPresentation.status === 'fulfilled')
          setArtifacts(presentationArtifacts(nextPresentation.value, []));
        if (nextPresentation.status === 'fulfilled') setPresentation(nextPresentation.value);
        const subjects = ['Project status', 'Project plan', 'Project files', 'Project output'];
        const failure = results.findIndex((result) => result.status === 'rejected');
        const failed = results[failure];
        setRecordError(
          failed?.status === 'rejected'
            ? readFailure(`${subjects[failure]} could not be refreshed`, failed.reason)
            : null
        );
      };
      const pending = { signal, queued: false, promise: Promise.resolve() };
      pendingReload.current = pending;
      pending.promise = (async () => {
        do {
          pending.queued = false;
          await read();
        } while (pending.queued && !signal.aborted);
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
    let unsubscribe: () => void = () => undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let initialized = false;
    let initializing: Promise<void> | undefined;
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
              if (
                incoming.some((event) =>
                  [
                    'completed',
                    'approval_requested',
                    'approval_resolved',
                    'question_asked',
                    'error',
                    'warning',
                    'artifact',
                    'plan',
                    'status',
                    'cost',
                    'preview',
                    'tool_result'
                  ].includes(event.kind)
                ) &&
                !refreshTimer
              )
                refreshTimer = setTimeout(() => {
                  refreshTimer = undefined;
                  if (!controller.signal.aborted && document.visibilityState !== 'hidden') {
                    void reloadRecords(controller.signal);
                    onRefreshRef.current();
                  }
                }, 1000);
            },
            onConnection: (state) => {
              if (controller.signal.aborted) return;
              setConnection(state);
              if (state === 'connected' || state === 'idle') setHistoryError(null);
              if (state === 'closed') initialized = false;
            },
            onError: (cause) => {
              if (!controller.signal.aborted)
                setHistoryError(readFailure('Project activity updates were interrupted', cause));
            }
          });
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) {
            setHistoryError(readFailure('Project activity could not be loaded', cause));
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
    const timer = setInterval(refreshVisible, 15000);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      controller.abort();
      if (retryHistory.current === loadHistory) retryHistory.current = null;
      document.removeEventListener('visibilitychange', refreshVisible);
      unsubscribe();
      clearInterval(timer);
      clearTimeout(refreshTimer);
    };
  }, [taskId, reloadRecords, finished]);
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
