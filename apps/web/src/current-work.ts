import type { TaskEvent, TaskPresentation } from '@garden/contracts';

/** Owner steering reaches the surface with the event stream, before a slower projection refresh. */
export function currentWork(
  presentation: TaskPresentation | null,
  events: readonly TaskEvent[]
): TaskPresentation | null {
  if (!presentation?.surface) return presentation;
  const latest = [...events]
    .reverse()
    .find((event) => event.kind === 'user_message' || event.kind === 'queued_message');
  if (!latest || latest.sequence <= (presentation.surface.direction?.sequence ?? 0))
    return presentation;
  const data =
    latest.payload && typeof latest.payload === 'object'
      ? (latest.payload as Record<string, unknown>)
      : {};
  const text =
    typeof data.markdown === 'string'
      ? data.markdown
      : typeof data.prompt === 'string'
        ? data.prompt
        : '';
  const messageId = typeof data.messageId === 'string' ? data.messageId : '';
  const direction = {
    eventId: latest.id,
    ...(messageId ? { messageId } : {}),
    sequence: latest.sequence,
    text: text.slice(0, 8_000),
    truncated: text.length > 8_000,
    queued: latest.kind === 'queued_message'
  };
  return {
    ...presentation,
    outputs: [],
    surface: {
      ...presentation.surface,
      direction,
      directions: [
        ...presentation.surface.directions.filter(
          (previous) =>
            !(
              latest.kind === 'user_message' &&
              messageId &&
              previous.queued &&
              (previous.messageId ?? previous.eventId) === messageId
            )
        ),
        direction
      ].slice(-32),
      report: null,
      references: [],
      sources: [],
      currentResultIds: []
    },
    progress: { ...presentation.progress, phases: [], current: null, metrics: [], milestones: [] }
  };
}
