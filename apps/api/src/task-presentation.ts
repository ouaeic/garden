import { projectWorkSurface } from './work-surface-projection.js';
import { deliveryFilePath } from '@garden/contracts';
export { deliveryFilePath } from '@garden/contracts';
import type {
  Artifact,
  TaskEvent,
  TaskMilestone,
  TaskPlan,
  TaskPresentation,
  TaskResult,
  TaskOutputIntent,
  WorkspacePreview
} from '@garden/contracts';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const compact = (value: unknown, max = 160): string =>
  text(value)
    // eslint-disable-next-line no-control-regex -- Replace ASCII controls before showing evidence titles.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);

/** Only typed publication receipts establish that a preview belongs to this task. */
export const taskPreviewIds = (events: readonly TaskEvent[]): Map<string, string[]> => {
  const ids = new Map<string, string[]>();
  for (const event of events) {
    if (event.kind !== 'preview') continue;
    const id = text(record(event.payload).previewId);
    if (id) ids.set(id, [...(ids.get(id) ?? []), event.id]);
  }
  return ids;
};

export const previewStartState = (
  events: readonly TaskEvent[],
  taskStatus: string,
  previewId: string
): 'starting' | 'attention' | undefined => {
  const direction = events.filter((event) => event.kind === 'user_message').at(-1);
  if (!direction || record(direction.payload).previewStartId !== previewId) return undefined;
  if (['queued', 'planning', 'running'].includes(taskStatus)) return 'starting';
  if (['paused', 'awaiting_user', 'awaiting_resource'].includes(taskStatus)) return 'attention';
  return undefined;
};

export const taskDeliveryFiles = (events: readonly TaskEvent[]): Map<string, string[]> => {
  const paths = new Map<string, string[]>();
  const artifactNames = new Set(
    events
      .filter((event) => event.kind === 'artifact')
      .map((event) => text(record(event.payload).name))
      .filter(Boolean)
  );
  const writes = new Map<string, string[]>();
  const calls = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    const payload = record(event.payload);
    if (event.kind === 'tool_started' && ['file_write', 'file_patch'].includes(text(payload.tool)))
      calls.set(text(payload.toolCallId), record(payload.arguments));
    else if (event.kind === 'tool_result') {
      const call = calls.get(text(payload.toolCallId));
      const result = record(payload.result);
      if (call && successful(result)) {
        const path = deliveryFilePath(result.path || call.path);
        if (path) writes.set(path, [event.id]);
      }
    } else if (event.kind === 'completed') {
      const values = payload.deliverables;
      if (Array.isArray(values) && values.length) {
        for (const value of values) {
          // A published download's display name is not a path in the working directory.
          if (typeof value === 'string' && artifactNames.has(value)) continue;
          const path = deliveryFilePath(value);
          if (path) paths.set(path, [...(paths.get(path) ?? []), event.id]);
        }
      } else for (const [path, evidence] of writes) paths.set(path, evidence);
      writes.clear();
    }
  }
  return paths;
};

/** Source bundles also retain successful supporting file writes omitted from a short completion. */
export const taskSourceFiles = (events: readonly TaskEvent[]): Map<string, string[]> => {
  const paths = taskDeliveryFiles(events);
  const calls = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    const payload = record(event.payload);
    if (event.kind === 'tool_started' && ['file_write', 'file_patch'].includes(text(payload.tool)))
      calls.set(text(payload.toolCallId), record(payload.arguments));
    if (event.kind !== 'tool_result') continue;
    const call = calls.get(text(payload.toolCallId)),
      result = record(payload.result);
    if (!call || !successful(result)) continue;
    const path = deliveryFilePath(result.path || call.path);
    if (path) paths.set(path, [event.id]);
  }
  return paths;
};

export const plannedOutputPaths = (outputs: readonly TaskOutputIntent[] = []) => ({
  paths: [
    ...new Set(
      outputs
        .flatMap((output) => output.files ?? [])
        .map(deliveryFilePath)
        .filter((p): p is string => p !== null)
    )
  ],
  directories: [
    ...new Set(
      outputs
        .flatMap((output) => output.directories ?? [])
        .map(deliveryFilePath)
        .filter((p): p is string => p !== null)
    )
  ]
});

const actionLabel = (name: string, args: Record<string, unknown>): string => {
  const path = compact(args.path, 100);
  if (['file_write', 'file_patch'].includes(name))
    return path ? `Working on ${path}` : 'Editing files';
  if (['web_search', 'parallel_web_read'].includes(name)) return 'Reading sources';
  if (['document_read', 'document_search'].includes(name)) return 'Working with documents';
  if (name === 'generate_media')
    return args.kind === 'audio' ? 'Creating audio' : 'Creating an image';
  if (name === 'publish_preview') return 'Preparing the app to open';
  if (name === 'publish_artifact') return 'Preparing a download';
  if (name === 'shell') return args.background ? 'Starting background work' : 'Running a command';
  if (name === 'process') return 'Checking running work';
  if (name.startsWith('browser_')) return 'Working in the browser';
  if (name.startsWith('desktop_')) return 'Working on the computer';
  if (name === 'delegate') return 'Investigating in parallel';
  return name.replaceAll('_', ' ');
};

const successful = (result: Record<string, unknown>): boolean =>
  !result.error && !result.skipped && result.ok !== false && result.success !== false;

export interface PresentationInput {
  taskId: string;
  workspaceId: string;
  sourceWorkspaceId?: string;
  taskStatus: string;
  events: readonly TaskEvent[];
  plan: TaskPlan | null;
  artifacts: readonly Artifact[];
  previews: readonly WorkspacePreview[];
  previewAvailability: ReadonlyMap<string, 'ready' | 'unavailable' | 'unknown'>;
  files: ReadonlyMap<string, { status: 'ready' | 'unavailable' | 'unknown'; sizeBytes?: number }>;
}

export const buildTaskPresentation = (input: PresentationInput): TaskPresentation => {
  const events = [
    ...new Map(input.events.filter((e) => e.taskId === input.taskId).map((e) => [e.id, e])).values()
  ].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  const previews = taskPreviewIds(events);
  const results: TaskResult[] = [];
  for (const preview of input.previews) {
    const evidence = previews.get(preview.id);
    if (
      !evidence ||
      (preview.workspaceId !== input.workspaceId && preview.workspaceId !== input.sourceWorkspaceId)
    )
      continue;
    const expired = preview.expiresAt !== null && Date.parse(preview.expiresAt) <= Date.now();
    const status =
      preview.status === 'active' && !expired
        ? (input.previewAvailability.get(preview.id) ?? 'unknown')
        : 'unavailable';
    results.push({
      id: `preview:${preview.id}`,
      kind: 'preview',
      title: preview.label,
      status,
      url: status === 'ready' ? preview.url : null,
      downloadUrl: null,
      accessPath:
        status === 'ready' && preview.visibility === 'private'
          ? `/v1/previews/${encodeURIComponent(preview.id)}/access`
          : null,
      previewId: preview.id,
      ...(preview.status !== 'revoked'
        ? {
            startPath: `/v1/tasks/${encodeURIComponent(input.taskId)}/previews/${encodeURIComponent(preview.id)}/start`,
            ...(previewStartState(events, input.taskStatus, preview.id)
              ? { startState: previewStartState(events, input.taskStatus, preview.id) }
              : {})
          }
        : {}),
      evidenceEventIds: evidence,
      ...(status !== 'ready'
        ? {
            detail:
              preview.status === 'revoked'
                ? 'Access to this preview has been removed.'
                : expired
                  ? 'This preview has rested for a while. Start it again when you’re ready.'
                  : preview.status === 'active'
                    ? status === 'unknown'
                      ? 'Garden could not reach the app. Try again in a moment.'
                      : 'The app has stopped. Start its preview again when you’re ready.'
                    : 'Access to this preview has been removed.'
          }
        : {})
    });
  }
  for (const artifact of input.artifacts) {
    if (
      artifact.taskId !== input.taskId ||
      (artifact.workspaceId !== input.workspaceId &&
        artifact.workspaceId !== input.sourceWorkspaceId)
    )
      continue;
    const url = `/v1/artifacts/${encodeURIComponent(artifact.id)}/content`;
    results.push({
      id: `artifact:${artifact.id}`,
      kind: 'artifact',
      title: artifact.name,
      status: 'ready',
      url,
      downloadUrl: url,
      accessPath: null,
      artifactId: artifact.id,
      workspaceId: artifact.workspaceId,
      sha256: artifact.sha256,
      createdAt: artifact.createdAt,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      version: artifact.version,
      evidenceEventIds: events
        .filter((e) => e.kind === 'artifact' && text(record(e.payload).artifactId) === artifact.id)
        .map((e) => e.id)
    });
  }
  const deliveryFiles = taskDeliveryFiles(events);
  const outputs = input.plan?.taskId === input.taskId ? input.plan.outputs : undefined;
  const plannedFiles = new Set(plannedOutputPaths(outputs).paths);
  for (const path of plannedFiles) if (!deliveryFiles.has(path)) deliveryFiles.set(path, []);
  for (const [path, evidence] of deliveryFiles) {
    const observed = input.files.get(path) ?? { status: 'unknown' as const };
    const awaitingFile =
      observed.status === 'unavailable' &&
      plannedFiles.has(path) &&
      !['completed', 'failed', 'cancelled'].includes(input.taskStatus);
    const url = `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/download?path=${encodeURIComponent(path)}`;
    results.push({
      id: `file:${path}`,
      kind: 'file',
      title: path.split('/').at(-1) ?? path,
      status: awaitingFile ? 'unknown' : observed.status,
      url: null,
      downloadUrl: observed.status === 'unavailable' ? null : url,
      accessPath: null,
      path,
      evidenceEventIds: evidence,
      ...(observed.sizeBytes === undefined ? {} : { sizeBytes: observed.sizeBytes }),
      ...(observed.status !== 'ready'
        ? {
            detail: awaitingFile
              ? 'This planned output is not available yet.'
              : observed.status === 'unknown'
                ? 'Availability has not been checked. Download opens the recorded file directly.'
                : 'This file is no longer available.'
          }
        : {})
    });
  }
  const started = new Map<
    string,
    { event: TaskEvent; tool: string; args: Record<string, unknown> }
  >();
  const pending = new Map<string, { title: string; eventId: string; startedAt: string }>();
  const paths = new Set<string>();
  const sources = new Set<string>();
  const milestones: TaskMilestone[] = [];
  let commands = 0,
    checksPassed = 0,
    checksFailed = 0,
    toolFailures = 0,
    images = 0;
  const add = (
    event: TaskEvent,
    kind: TaskMilestone['kind'],
    title: string,
    status: TaskMilestone['status'] = 'observed',
    detail?: string
  ) => {
    milestones.push({
      id: event.id,
      sequence: event.sequence,
      kind,
      title: compact(title),
      status,
      createdAt: event.createdAt,
      ...(detail ? { detail: compact(detail, 240) } : {})
    });
  };
  for (const event of events) {
    const payload = record(event.payload);
    const id = text(payload.toolCallId);
    if (event.kind === 'tool_started') {
      const tool = text(payload.tool),
        args = record(payload.arguments);
      started.set(id, { event, tool, args });
      pending.set(id, {
        title: actionLabel(tool, args),
        eventId: event.id,
        startedAt: event.createdAt
      });
    } else if (event.kind === 'error') {
      pending.delete(id);
      if (payload.code === 'browser_bot_wall' && record(payload.botWall).tabId) {
        add(event, 'checkpoint', 'Browser verification requested');
        continue;
      }
      /*
       * Counted whether or not the call that failed was seen starting.
       *
       * A failure already becomes one line in the trace, and the trace keeps the last two dozen
       * lines of the current direction - so a run that failed the same tool thirty-seven times over
       * five hours showed the owner, at most, whichever few were recent enough to survive the
       * window. The pattern is the thing worth knowing, and a pattern is a count.
       */
      toolFailures += 1;
      if (started.has(id)) add(event, 'check', event.summary, 'failed');
    } else if (event.kind === 'tool_result') {
      pending.delete(id);
      const call = started.get(id);
      if (!call) continue;
      const result = record(payload.result);
      if (!successful(result)) continue;
      if (['file_write', 'file_patch'].includes(call.tool)) {
        const path = compact(result.path || call.args.path, 1_024);
        if (path) {
          paths.add(path);
          add(event, 'change', path);
        }
      } else if (call.tool === 'shell') {
        commands++;
        if (result.sessionId)
          add(event, 'process', 'Background work started', 'observed', compact(result.command));
        else if (typeof result.exitCode === 'number')
          add(
            event,
            'check',
            `Command ${result.exitCode === 0 ? 'finished' : 'failed'}`,
            result.exitCode === 0 ? 'passed' : 'failed',
            [
              text(call.args.executable),
              ...(Array.isArray(call.args.args)
                ? call.args.args.filter((a) => typeof a === 'string')
                : [])
            ].join(' ')
          );
      } else if (call.tool === 'generate_media') {
        images++;
        add(event, 'result', 'Media created');
      } else if (['web_search', 'parallel_web_read'].includes(call.tool)) {
        // Source counts come from returned addresses, never from how many a plan promised to read.
        const candidates = [result.sources, result.results, result.pages, result.items].find(
          Array.isArray
        );
        if (Array.isArray(candidates))
          for (const item of candidates) {
            const url = text(record(item).url);
            try {
              const parsed = new URL(url);
              if (['http:', 'https:'].includes(parsed.protocol)) sources.add(parsed.href);
            } catch {
              /* No address was observed. */
            }
          }
        add(event, 'source', call.tool === 'web_search' ? 'Sources found' : 'Sources read');
      }
    } else if (event.kind === 'preview' || event.kind === 'artifact')
      add(event, 'result', event.summary);
    else if (event.kind === 'approval_requested')
      add(event, 'approval', 'Decision needed', 'waiting');
    else if (event.kind === 'approval_resolved') add(event, 'approval', event.summary);
    else if (event.kind === 'status' && Array.isArray(payload.acceptance)) {
      for (const value of payload.acceptance) {
        const check = record(value);
        if (check.passed === true) checksPassed++;
        else if (check.passed === false) checksFailed++;
      }
      add(
        event,
        'check',
        event.summary,
        payload.acceptance.some((v) => record(v).passed === false) ? 'failed' : 'passed'
      );
    }
  }
  const surface = projectWorkSurface(events, input.plan, results);
  /*
   * Timing for a milestone is recovered by walking the plan's own versions rather than stored on
   * the step: each `plan` event is a whole snapshot, so the first version in which a step is
   * running is when it started and the first in which it closes is when it ended. Steps that carry
   * their own stamps keep them - a worker that recorded one has answered more precisely than a diff
   * can. Nothing new is written to get this, which is why it also works for runs that finished
   * before any of it existed.
   */
  const firstInProgress = new Map<string, string>();
  const firstClosed = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== 'plan') continue;
    const steps = record(event.payload).steps;
    if (!Array.isArray(steps)) continue;
    /*
     * Parts are walked with their steps, on the same ids.
     *
     * A sub-milestone carries no clock of its own either, and its id is as stable across versions
     * as its parent's - so this one first-seen-running / first-seen-closed pass answers for both.
     * Walking only the outer list left every part without a window, and a part with no window
     * cannot say what happened inside it.
     */
    const visit = (value: unknown): void => {
      const step = record(value);
      const id = text(step.id);
      if (!id) return;
      const status = text(step.status);
      if (status === 'in_progress' && !firstInProgress.has(id))
        firstInProgress.set(id, event.createdAt);
      if ((status === 'completed' || status === 'skipped') && !firstClosed.has(id))
        firstClosed.set(id, event.createdAt);
      if (Array.isArray(step.substeps)) for (const part of step.substeps) visit(part);
    };
    for (const value of steps) visit(value);
  }
  const closed = (sub: { status: string }): boolean =>
    sub.status === 'completed' || sub.status === 'skipped';
  /*
   * What happened while one step was the running one, in a line.
   *
   * The milestones are already derived from this task's own events, and each carries the moment it
   * was recorded - so the ones that fall inside a step's window are, by construction, what that
   * step did. Counting them by kind says more in a hover than any three of their titles would, and
   * the newest title is added because "4 changes" is a shape and "app/index.html" is the work.
   *
   * A window that is still open runs to now, so a step in progress describes itself too. A step
   * with no window, or none recorded inside it, gets nothing rather than a sentence about zero.
   */
  const accountOf = (startedAt?: string, completedAt?: string): string | undefined => {
    if (!startedAt) return undefined;
    const from = Date.parse(startedAt);
    const to = completedAt ? Date.parse(completedAt) : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(from)) return undefined;
    const inside = milestones.filter((milestone) => {
      const at = Date.parse(milestone.createdAt);
      return Number.isFinite(at) && at >= from && at <= to;
    });
    if (inside.length === 0) return undefined;
    const counts = new Map<string, number>();
    for (const milestone of inside)
      counts.set(milestone.kind, (counts.get(milestone.kind) ?? 0) + 1);
    const label: Record<string, [string, string]> = {
      change: ['file changed', 'files changed'],
      source: ['source read', 'sources read'],
      check: ['check', 'checks'],
      result: ['result', 'results'],
      approval: ['approval', 'approvals'],
      process: ['command run', 'commands run'],
      checkpoint: ['checkpoint', 'checkpoints']
    };
    const parts = [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([kind, count]) => {
        const [one, many] = label[kind] ?? [kind, kind];
        return `${count} ${count === 1 ? one : many}`;
      });
    const newest = inside.at(-1)?.title;
    return [parts.join(', '), newest].filter(Boolean).join(' · ').slice(0, 240);
  };
  const toPhase = (step: Record<string, unknown>) => {
    const id = text(step.id);
    const substepsList = Array.isArray(step.substeps) ? step.substeps.map(record) : [];
    const startedAt = text(step.startedAt) || firstInProgress.get(id);
    const completedAt = text(step.completedAt) || firstClosed.get(id);
    const detail = accountOf(startedAt, completedAt);
    const parts = substepsList
      .map((sub) => {
        const subId = text(sub.id);
        const subStarted = text(sub.startedAt) || firstInProgress.get(subId);
        const subClosed = text(sub.completedAt) || firstClosed.get(subId);
        const subDetail = accountOf(subStarted, subClosed);
        return {
          id: subId,
          title: text(sub.title),
          status: text(sub.status),
          ...(subStarted ? { startedAt: subStarted } : {}),
          ...(subClosed ? { completedAt: subClosed } : {}),
          ...(subDetail ? { detail: subDetail } : {})
        };
      })
      .filter((sub) => sub.id && sub.title);
    return {
      id,
      title: text(step.title),
      status: text(step.status) as 'pending' | 'in_progress' | 'completed' | 'skipped',
      ...(startedAt ? { startedAt } : {}),
      ...(completedAt ? { completedAt } : {}),
      ...(detail ? { detail } : {}),
      ...(parts.length
        ? {
            countDone: parts.filter(closed).length,
            countTotal: parts.length,
            substeps: parts as {
              id: string;
              title: string;
              status: 'pending' | 'in_progress' | 'completed' | 'skipped';
            }[]
          }
        : {})
    };
  };
  const matchesCurrentDirection =
    input.plan?.taskId === input.taskId &&
    (!surface.direction ||
      (input.plan.directionEventId
        ? input.plan.directionEventId === surface.direction.eventId
        : Date.parse(input.plan.createdAt) >=
          Date.parse(
            events.find((event) => event.id === surface.direction?.eventId)?.createdAt ?? ''
          )));
  const phases =
    input.plan && matchesCurrentDirection
      ? input.plan.steps.map((step) => toPhase(step as unknown as Record<string, unknown>))
      : [];
  /*
   * The milestone lists of the directions that came before this one.
   *
   * `phases` is the plan of the direction being worked now, and until the model writes one it is
   * empty - which is why a follow-up appeared to delete everything the project had done. The last
   * plan each earlier direction reached is kept here instead, so the owner keeps the whole
   * trajectory and not only the newest slice of it. Read from the plan events, which are already a
   * full snapshot per version, so the newest version of each direction is simply the last one seen.
   */
  const perDirection = new Map<string, { startedAt: string; steps: Record<string, unknown>[] }>();
  for (const event of events) {
    if (event.kind !== 'plan') continue;
    const payload = record(event.payload);
    const steps = payload.steps;
    if (!Array.isArray(steps) || steps.length === 0) continue;
    const directionEventId =
      text(payload.directionEventId) || text(record(payload.presentation).directionEventId);
    const existing = perDirection.get(directionEventId);
    perDirection.set(directionEventId, {
      startedAt: existing?.startedAt ?? event.createdAt,
      steps: steps.map(record)
    });
  }
  /*
   * Null rather than the empty string when there is nothing to exclude. A plan written before any
   * direction existed keys on '' too, so using '' as "no current direction" would have taken that
   * plan out of the history it belongs in - the one case where an older task has a list to keep and
   * would have been shown none.
   */
  const currentDirectionId = matchesCurrentDirection
    ? (input.plan?.directionEventId ?? surface.direction?.eventId ?? '')
    : null;
  const history = [...perDirection.entries()]
    // The direction being worked now is already `phases`; repeating it below would read as the
    // project having done the same list twice.
    .filter(
      ([directionEventId]) => currentDirectionId === null || directionEventId !== currentDirectionId
    )
    .map(([directionEventId, entry]) => ({
      directionEventId: directionEventId || null,
      startedAt: entry.startedAt,
      phases: entry.steps.map(toPhase).filter((phase) => phase.id && phase.title)
    }))
    .filter((entry) => entry.phases.length > 0)
    .slice(-16);
  const intentKind = outputs?.[0]?.kind;
  const kind = intentKind
    ? (
        {
          app: 'build',
          document: 'research',
          dataset: 'analysis',
          media: 'design',
          answer: 'general'
        } as const
      )[intentKind]
    : results.some((r) => r.kind === 'preview')
      ? 'build'
      : images
        ? 'design'
        : sources.size
          ? 'research'
          : commands && paths.size
            ? 'analysis'
            : paths.size
              ? 'build'
              : 'general';
  const active = ['queued', 'planning', 'running'].includes(input.taskStatus);
  /*
   * The run's own account of how it ended, read off the `completed` event it already writes.
   *
   * The newest one, because a project with several directions has one per direction and the owner
   * is being shown how *this* run ended. Only while the task is actually finished: a completed
   * event from an earlier direction, shown over work that is running now, would read as an ending
   * that has not happened.
   */
  const finished =
    input.taskStatus === 'completed'
      ? [...events]
          .reverse()
          .find(
            (event) =>
              event.kind === 'completed' && event.sequence >= (surface.direction?.sequence ?? 0)
          )
      : undefined;
  const finishPayload = finished ? record(finished.payload) : undefined;
  const finishVerification = record(finishPayload?.verification);
  /** Model-written lines, bounded and trimmed. Never addresses - see the contract's note. */
  const strings = (value: unknown, max: number): string[] =>
    Array.isArray(value)
      ? value
          .map((item) => compact(item, 240))
          .filter((item) => item.length > 0)
          .slice(0, max)
      : [];
  const outcome: TaskPresentation['outcome'] = finished
    ? {
        summary: compact(finishPayload?.summary, 400) || finished.summary,
        at: finished.createdAt,
        verification:
          finishVerification.status === 'verified'
            ? 'verified'
            : finishVerification.status === 'not_applicable'
              ? 'not_applicable'
              : 'unverified',
        evidence: Array.isArray(finishVerification.evidence)
          ? finishVerification.evidence.length
          : 0,
        remainingRisks: strings(finishVerification.remainingRisks, 12),
        // Counted off the plan rather than off the finish, because the two disagreeing is the
        // whole point: a run may legitimately stop with steps open, and the owner should be told
        // which number is which rather than shown "Complete" over a list that is 4 of 7.
        openSteps: phases.filter(
          (phase) => phase.status !== 'completed' && phase.status !== 'skipped'
        ).length
      }
    : undefined;
  return {
    version: 1,
    taskId: input.taskId,
    taskStatus: input.taskStatus,
    eventCursor: events.at(-1)?.sequence ?? 0,
    results,
    surface,
    ...(outputs === undefined ? {} : { outputs }),
    ...(outcome ? { outcome } : {}),
    progress: {
      kind,
      phases,
      current:
        active && !surface.direction?.queued
          ? ([...pending.values()]
              .filter(
                (item) =>
                  (events.find((event) => event.id === item.eventId)?.sequence ?? -1) >=
                  (surface.direction?.sequence ?? 0)
              )
              .at(-1) ?? null)
          : null,
      history,
      metrics: [
        { key: 'files', label: 'Files changed', value: paths.size },
        { key: 'sources', label: 'Sources found', value: sources.size },
        { key: 'commands', label: 'Commands run', value: commands },
        { key: 'checksPassed', label: 'Checks passed', value: checksPassed },
        { key: 'checksFailed', label: 'Checks failed', value: checksFailed },
        { key: 'toolFailures', label: 'Tool calls that failed', value: toolFailures },
        {
          key: 'results',
          label: 'Results ready',
          value: results.filter((r) => r.status === 'ready').length
        }
      ].filter((m) => m.value > 0),
      milestones: milestones
        .filter((milestone) => milestone.sequence >= (surface.direction?.sequence ?? 0))
        .slice(-24),
      updatedAt: events.at(-1)?.createdAt ?? null
    }
  };
};
