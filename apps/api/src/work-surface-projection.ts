import {
  deliveryFilePath,
  WorkSurfaceReport,
  workEvidenceValue,
  workSurfaceReferences,
  type TaskEvent,
  type TaskPlan,
  type TaskResult,
  type WorkSurfaceView
} from '@garden/contracts';

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
  plan: TaskPlan | null,
  results: readonly TaskResult[]
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
  for (let index = 0; index < directions.length; index++) {
    const direction = directions[index]!;
    const end = directions[index + 1]?.sequence ?? Infinity;
    const epoch = events.filter(
      (event) => event.sequence > direction.sequence && event.sequence < end
    );
    const matched = epoch
      .map((event) =>
        event.kind === 'plan'
          ? WorkSurfaceReport.safeParse(record(event.payload).presentation)
          : null
      )
      .find((parsed) => parsed?.success && parsed.data.directionEventId === direction.eventId);
    const assistant = epoch.find(
      (event) => event.kind === 'assistant_message' && text(record(event.payload).markdown)
    );
    const planStep = epoch
      .filter((event) => event.kind === 'plan')
      .map((event) => {
        const payload = record(event.payload);
        const planDirection =
          text(payload.directionEventId) || text(record(payload.presentation).directionEventId);
        if (planDirection && planDirection !== direction.eventId) return '';
        return Array.isArray(payload.steps)
          ? text(record(payload.steps[0]).title).slice(0, 600)
          : '';
      })
      .find(Boolean);
    const acknowledgment = matched?.success
      ? matched.data.content.acknowledgment
      : assistant
        ? text(record(assistant.payload).markdown).slice(0, 600)
        : planStep;
    if (acknowledgment) Object.assign(direction, { acknowledgment });
  }
  const direction = directions.at(-1) ?? null;
  const reportParse = WorkSurfaceReport.safeParse(plan?.presentation);
  const report =
    reportParse.success && reportParse.data.directionEventId === direction?.eventId
      ? reportParse.data
      : null;
  const starts = new Map<string, TaskEvent>();
  const calls = new Map<string, { event: TaskEvent; result: unknown }>();
  const sources = new Map<string, WorkSurfaceView['sources'][number]>();
  for (const event of events) {
    const payload = record(event.payload);
    const callId = text(payload.toolCallId);
    if (event.kind === 'tool_started') starts.set(callId, event);
    if (event.kind !== 'tool_result') continue;
    calls.set(callId, { event, result: payload.result });
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
  const references: WorkSurfaceView['references'] = [];
  let unavailableReferences = 0;
  const seen = new Set<string>();
  for (const reference of report ? workSurfaceReferences(report.content) : []) {
    const identity = `${reference.toolCallId}:${reference.pointer}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const call = calls.get(reference.toolCallId);
    const value = workEvidenceValue(call?.result, reference.pointer);
    if (!call || value === undefined) {
      unavailableReferences++;
      continue;
    }
    const source = record(value);
    const url = webUrl(source.url) ?? webUrl(value);
    references.push({
      ...reference,
      eventId: call.event.id,
      sequence: call.event.sequence,
      label: (text(source.title) || call.event.summary).slice(0, 240),
      ...(url ? { url } : {}),
      ...((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean'
        ? { value }
        : typeof value === 'string'
          ? { value: value.slice(0, 600) }
          : {})
    });
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
  const latestArtifacts = new Map<string, string>();
  const supersededArtifacts = new Set<string>();
  // Display names can collide; only a confirmed publication identifies a source's next version.
  for (const [callId, call] of calls) {
    const started = record(starts.get(callId)?.payload);
    if (started.tool !== 'publish_artifact') continue;
    const path = deliveryFilePath(record(started.arguments).path);
    const published = record(call.result);
    if (published.error || published.skipped || published.success === false) continue;
    const artifactId = text(published.artifactId);
    if (!path || !liveArtifactIds.has(artifactId)) continue;
    const previous = latestArtifacts.get(path);
    if (previous && previous !== artifactId) supersededArtifacts.add(previous);
    latestArtifacts.set(path, artifactId);
  }
  return {
    direction,
    directions: directions.slice(-32),
    report,
    references,
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
    sources: [...sources.values()].slice(-200),
    unavailableReferences
  };
}
