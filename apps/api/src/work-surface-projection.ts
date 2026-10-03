import type { TaskEvent, TaskResult, WorkSurfaceView } from '@garden/contracts';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const webUrl = (value: unknown): string | undefined => {
  try {
    const url = new URL(text(value));
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};

export function projectWorkSurface(
  events: readonly TaskEvent[],
  results: readonly TaskResult[],
  artifactSourceKeys: ReadonlyMap<string, string> = new Map()
): WorkSurfaceView {
  const consumedMessages = new Map<string, number>();
  for (const event of events) {
    const messageId = text(record(event.payload).messageId);
    if (event.kind === 'user_message' && messageId) consumedMessages.set(messageId, event.sequence);
  }
  const directions = events
    .filter((event) => event.kind === 'user_message' || event.kind === 'queued_message')
    .filter(
      (event) =>
        event.kind !== 'queued_message' ||
        (consumedMessages.get(text(record(event.payload).messageId) || event.id) ?? -1) <=
          event.sequence
    )
    .map((event) => {
      const content = record(event.payload);
      const messageId = text(content.messageId);
      const markdown = text(content.markdown) || text(content.prompt);
      return {
        eventId: event.id,
        ...(messageId ? { messageId } : {}),
        sequence: event.sequence,
        text: markdown.slice(0, 8_000),
        truncated: markdown.length > 8_000,
        queued: event.kind === 'queued_message'
      };
    });
  const direction = directions.at(-1) ?? null;
  const starts = new Map<string, TaskEvent>();
  const sources = new Map<string, WorkSurfaceView['sources'][number]>();
  for (const event of events) {
    const payload = record(event.payload);
    const callId = text(payload.toolCallId);
    if (event.kind === 'tool_started') starts.set(callId, event);
    if (event.kind !== 'tool_result') continue;
    const started = starts.get(callId);
    if (!started || started.sequence < (direction?.sequence ?? 0)) continue;
    const tool = text(record(started.payload).tool);
    if (tool !== 'web_search' && tool !== 'parallel_web_read') continue;
    const result = record(payload.result);
    if (result.error || result.skipped || result.success === false) continue;
    const candidates = tool === 'parallel_web_read' ? result.sources : result.results;
    if (!Array.isArray(candidates)) continue;
    for (const candidate of candidates) {
      const source = record(candidate);
      const url = webUrl(source.url);
      if (!url || source.error) continue;
      const state =
        tool === 'parallel_web_read' && typeof source.text === 'string' ? 'read' : 'discovered';
      if (sources.get(url)?.state === 'read') continue;
      sources.set(url, {
        url,
        title: (text(source.title) || new URL(url).hostname).slice(0, 240),
        eventId: event.id,
        sequence: event.sequence,
        state
      });
    }
  }
  const sequence = new Map(events.map((event) => [event.id, event.sequence]));
  const livePreviewIds = new Set(
    events
      .filter((event) => event.kind === 'preview')
      .map((event) => text(record(event.payload).previewId))
      .filter(Boolean)
  );
  const liveArtifactIds = new Set(
    events
      .filter((event) => event.kind === 'artifact')
      .map((event) => text(record(event.payload).artifactId))
      .filter(Boolean)
  );
  const latestArtifacts = new Map<string, { id: string; version: number }>();
  const supersededArtifacts = new Set<string>();
  // The stored source identity survives missing tool receipts; display names can collide.
  for (const result of results) {
    const source = result.artifactId && artifactSourceKeys.get(result.artifactId);
    if (!source || !result.artifactId || !result.version || !liveArtifactIds.has(result.artifactId))
      continue;
    const previous = latestArtifacts.get(source);
    if (previous && previous.version !== result.version) {
      supersededArtifacts.add(previous.version > result.version ? result.artifactId : previous.id);
    }
    if (!previous || previous.version < result.version)
      latestArtifacts.set(source, { id: result.artifactId, version: result.version });
  }
  return {
    direction,
    directions: directions.slice(-32),
    currentResultIds: results
      .filter((result) => !result.artifactId || !supersededArtifacts.has(result.artifactId))
      .filter(
        (result) =>
          !direction ||
          result.evidenceEventIds.some((id) => (sequence.get(id) ?? -1) > direction.sequence) ||
          (result.artifactId &&
            events.some(
              (event) =>
                event.sequence > direction.sequence &&
                event.kind === 'artifact' &&
                record(event.payload).artifactId === result.artifactId
            )) ||
          /*
           * A follow-up is a new direction epoch, and recency alone would demote the thing the
           * owner just published - the served app an earlier direction put up vanishes from the
           * served area the moment they send a follow-up, even though nothing unpublished it and
           * it is still live. What is actually outlasting the turn is a live preview or artifact,
           * so those stay current across directions; everything else keeps the epoch rule.
           */
          (result.kind === 'preview' &&
            Boolean(result.previewId) &&
            livePreviewIds.has(result.previewId!)) ||
          (Boolean(result.artifactId) && liveArtifactIds.has(result.artifactId!))
      )
      .map((result) => result.id),
    sources: [...sources.values()].slice(-200)
  };
}
