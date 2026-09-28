import { useEffect, useState, type RefObject } from 'react';
import type { ConversationChanges } from '@garden/contracts';
import { get } from './client';

export function useProjectChanges(
  projectId: string,
  container: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  identities: string
) {
  const [changes, setChanges] = useState<Record<string, ConversationChanges>>({});
  useEffect(() => {
    setChanges({});
  }, [projectId]);
  useEffect(() => {
    if (!enabled || !container.current) return;
    const visible = new Set<string>();
    let controller: AbortController | undefined;
    let debounce: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (document.visibilityState !== 'visible' || !visible.size) return;
      controller?.abort();
      const pending = new AbortController();
      controller = pending;
      const tasks = [...visible].slice(0, 100);
      try {
        const rows = await get<ConversationChanges[]>(
          `/v1/projects/${projectId}/changes?${new URLSearchParams({ tasks: tasks.join(',') })}`,
          { signal: pending.signal }
        );
        if (!pending.signal.aborted)
          setChanges((previous) => ({
            ...previous,
            ...Object.fromEntries(rows.map((row) => [row.taskId, row]))
          }));
      } catch {
        if (!pending.signal.aborted)
          setChanges((previous) => ({
            ...previous,
            ...Object.fromEntries(
              tasks.map((taskId) => [
                taskId,
                {
                  taskId,
                  status: 'unavailable',
                  measurement: previous[taskId]?.measurement ?? null
                }
              ])
            )
          }));
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.taskId!;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        clearTimeout(debounce);
        debounce = setTimeout(() => void refresh(), 100);
      },
      { rootMargin: '300px' }
    );
    for (const element of container.current.querySelectorAll('[data-task-id]'))
      observer.observe(element);
    const timer = setInterval(() => void refresh(), 15_000);
    const reveal = () => void refresh();
    document.addEventListener('visibilitychange', reveal);
    return () => {
      controller?.abort();
      observer.disconnect();
      clearInterval(timer);
      clearTimeout(debounce);
      document.removeEventListener('visibilitychange', reveal);
    };
  }, [projectId, container, enabled, identities]);
  return changes;
}

export function changeSummary(value: ConversationChanges | undefined): string | null {
  if (!value) return null;
  const measured = value.measurement;
  if (!measured)
    return value.status === 'unavailable' ? 'Changes unavailable' : 'Measuring changes…';
  const parts = [
    measured.added || measured.removed
      ? `+${measured.added.toLocaleString()} −${measured.removed.toLocaleString()} lines`
      : 'No measured line changes',
    `${measured.changedFiles.toLocaleString()} changed ${measured.changedFiles === 1 ? 'file' : 'files'}`
  ];
  if (measured.unmeasuredFiles)
    parts.push(`${measured.unmeasuredFiles.toLocaleString()} unmeasured`);
  if (measured.truncated) parts.push('Partial scan');
  if (value.status === 'unavailable') parts.push('Last known counts');
  return parts.join(' · ');
}
