import { useEffect, useState } from 'react';
import type { TaskEvent } from '@garden/contracts';
import { subscribeTaskEvents } from '../stream';

/**
 * One goal's events, live, for a card that only needs to read the answer as it is written.
 *
 * Lighter than a goal's full record on purpose: no plan, no artifacts, no presentation - the card
 * shows the words and a status, and opening the goal is one click away for everything else.
 */
export function useAnswerEvents(taskId: string): TaskEvent[] {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    setEvents([]);
    const stop = subscribeTaskEvents(taskId, {
      after: 0,
      signal: controller.signal,
      onEvents: (batch) =>
        setEvents((previous) => {
          const seen = new Set(previous.map((event) => event.sequence));
          const fresh = batch.filter((event) => !seen.has(event.sequence));
          if (!fresh.length) return previous;
          return [...previous, ...fresh].sort((a, b) => a.sequence - b.sequence).slice(-600);
        })
    });
    return () => {
      controller.abort();
      stop();
    };
  }, [taskId]);
  return events;
}
