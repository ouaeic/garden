import { useEffect, useRef, useState } from 'react';
import type { TaskPresentation, TaskResult } from '@garden/contracts';
import { get, post } from './client';

export function usePreviewStart(presentation: TaskPresentation, watch: boolean) {
  const [observed, setObserved] = useState<TaskPresentation | null>(null);
  const [requested, setRequested] = useState<{
    taskId: string;
    id: string;
    at: number;
    done?: boolean;
  } | null>(null);
  const [failure, setFailure] = useState<{ taskId: string; cause: unknown } | null>(null);
  const setError = (cause: unknown) => setFailure(cause ? { taskId, cause } : null);
  const pending = useRef(false);
  const taskId = presentation.taskId;
  const current = useRef(taskId);
  current.current = taskId;
  const fresh =
    observed?.taskId === taskId && observed.eventCursor >= presentation.eventCursor
      ? observed
      : null;
  const base = presentation.results.filter((result) => result.kind === 'preview');
  const previews = base.map(
    (result) => fresh?.results.find((item) => item.id === result.id) ?? result
  );
  const request = requested?.taskId === taskId ? requested : null;
  const active = request && !request.done ? request : null;
  // A restored copy can publish a new address when its execution directory has moved.
  if (request && fresh)
    for (const result of fresh.results)
      if (result.kind === 'preview' && !previews.some((item) => item.id === result.id))
        previews.push(result);
  const starting = Boolean(active || previews.some((result) => result.startState === 'starting'));

  const inputs = useRef({ base, active });
  inputs.current = { base, active };
  const count = base.length;
  const activeId = active?.id;
  useEffect(() => {
    if (!count || (!watch && !starting)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const { base, active } = inputs.current;
      if (!document.hidden) {
        try {
          const value = await get<TaskPresentation>(`/v1/tasks/${taskId}/presentation`, {
            signal: controller.signal
          });
          if (controller.signal.aborted) return;
          setObserved(value);
          setFailure(null);
          if (active) {
            const result = value.results.find((item) => item.id === active.id);
            const ready =
              result?.status === 'ready' ||
              value.results.some(
                (item) =>
                  item.kind === 'preview' &&
                  item.status === 'ready' &&
                  !base.some((old) => old.id === item.id)
              );
            if (ready || result?.startState === 'attention')
              setRequested({ ...active, done: true });
            else if (
              !result?.startState &&
              Date.now() - active.at > 15_000 &&
              ['completed', 'failed', 'cancelled'].includes(value.taskStatus ?? '')
            ) {
              setRequested({ ...active, done: true });
              setFailure({
                taskId,
                cause: new Error(
                  'The preview could not start. Open the conversation to see what needs attention, or try again.'
                )
              });
            }
          }
        } catch (cause) {
          if (!controller.signal.aborted && starting) {
            setFailure({ taskId, cause });
            if (active) setRequested({ ...active, done: true });
          }
        }
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => void refresh(), starting ? 3_000 : 15_000);
    };
    timer = setTimeout(() => void refresh(), starting ? 1_000 : 15_000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [taskId, watch, starting, activeId, count]);

  async function start(result: TaskResult) {
    if (!result.startPath || pending.current) return;
    pending.current = true;
    const next = { taskId, id: result.id, at: Date.now() };
    setRequested(next);
    setError(null);
    try {
      await post(result.startPath, {});
      const value = await get<TaskPresentation>(`/v1/tasks/${taskId}/presentation`);
      if (current.current !== taskId) return;
      setObserved(value);
      if (value.results.find((item) => item.id === result.id)?.status === 'ready')
        setRequested({ ...next, done: true });
    } catch (cause) {
      if (current.current === taskId) {
        setError(cause);
        setRequested({ ...next, done: true });
      }
    } finally {
      pending.current = false;
    }
  }
  const restored =
    request &&
    fresh?.results.find(
      (item) =>
        item.kind === 'preview' &&
        item.status === 'ready' &&
        !base.some((old) => old.id === item.id)
    );
  return {
    previews,
    start,
    error: failure?.taskId === taskId ? failure.cause : null,
    requestedId: active?.id,
    restoredId: restored ? restored.id : null
  };
}
