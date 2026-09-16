import { deliveryFilePath, TaskOutputIntents, type TaskOutputIntent } from '@athanor/contracts';
import { decryptJson } from '@athanor/core';
import type { DataStore, TaskRecord } from '@athanor/data';
import type { AgentState, AgentWorkerConfig } from './agent-state.js';
import { withRunnerAbort, type AgentRunnerClient } from './runner-client.js';
import { asRecord, previewUrl } from './values.js';

export interface DeliveryResolution {
  deliverables: string[];
  unavailable: string[];
}

const address = (value: string): string | null => {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? `${url.origin}${url.pathname}` : null;
  } catch {
    return null;
  }
};

export const declaredTaskOutputs = async (
  store: DataStore,
  taskId: string,
  key: Uint8Array
): Promise<TaskOutputIntent[]> => {
  const plan = await store.getLatestTaskPlan(taskId);
  if (!plan) return [];
  const content = decryptJson<{ outputs?: unknown }>(
    plan.stepsCiphertext,
    key,
    `task-plan:${taskId}`
  );
  return content.outputs === undefined ? [] : TaskOutputIntents.parse(content.outputs);
};

/** Publication references are checked locally; no model judges whether its own link exists. */
export const resolveDelivery = async (
  deps: {
    store: DataStore;
    runner: AgentRunnerClient;
    config: Pick<AgentWorkerConfig, 'PREVIEW_BASE_URL'>;
  },
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  declared: unknown,
  intent: {
    outputs?: readonly TaskOutputIntent[];
    passedCheckIds?: ReadonlySet<string>;
    deferredFiles?: ReadonlySet<string>;
  } = {}
): Promise<DeliveryResolution> => {
  const outputs = intent.outputs ?? [];
  const deliverables = Array.isArray(declared)
    ? [
        ...new Set(
          declared.filter((item): item is string => typeof item === 'string' && !!item.trim())
        )
      ]
    : [];
  for (const path of outputs.flatMap((output) => output.files ?? []))
    if (!deliverables.includes(path)) deliverables.push(path);
  if (!deliverables.length && !outputs.some((output) => output.kind !== 'answer'))
    return {
      deliverables: [
        ...new Set(
          (state.artifactLedger?.entries ?? []).flatMap((entry) => {
            const path = deliveryFilePath(entry.path);
            return path ? [path] : [];
          })
        )
      ],
      unavailable: []
    };

  const needsPreview = outputs.some(
    (output) => output.kind === 'app' && output.delivery !== 'package'
  );
  const hasUrls = needsPreview || deliverables.some((item) => address(item) !== null);
  const [artifacts, previews, events] = await Promise.all([
    deps.store.listArtifacts(task.userId, task.workspaceId, task.id, 128),
    hasUrls ? deps.store.listWorkspacePreviews(task.userId, task.workspaceId) : [],
    hasUrls ? deps.store.listTaskEvents(task.id, 0, { kind: 'preview', limit: 128 }) : []
  ]);
  const names = new Set(
    artifacts
      .filter((item) => item.taskId === task.id)
      .map(
        (item) =>
          decryptJson<{ name: string }>(
            item.nameCiphertext as Parameters<typeof decryptJson>[0],
            key,
            `artifact-name:${task.workspaceId}`
          ).name
      )
  );
  const previewIds = new Set(
    events
      .filter((item) => item.kind === 'preview' && item.taskId === task.id)
      .flatMap((item) => {
        if (!item.payloadCiphertext) return [];
        const body = asRecord(decryptJson(item.payloadCiphertext, key, `task-event:${task.id}`));
        const payload = body?.__athanorEventVersion === 1 ? asRecord(body.payload) : body;
        return typeof payload?.previewId === 'string' ? [payload.previewId] : [];
      })
  );
  const unavailable: string[] = [];
  const previewChecks = new Map<string, Promise<boolean>>();
  const isLive = (preview: (typeof previews)[number]): Promise<boolean> => {
    if (
      preview.status !== 'active' ||
      (preview.expiresAt && Date.parse(preview.expiresAt) <= Date.now())
    )
      return Promise.resolve(false);
    const existing = previewChecks.get(preview.id);
    if (existing) return existing;
    const check = withRunnerAbort(AbortSignal.timeout(2_000), () =>
      deps.runner.call<{ available: boolean }>(
        task.workspaceId,
        task.id,
        `preview:${preview.port}`,
        `/v1/workspaces/${task.workspaceId}/preview-check/${preview.port}`
      )
    )
      .then((result) => result.available === true)
      .catch(() => false);
    previewChecks.set(preview.id, check);
    return check;
  };
  let livePreview: Promise<(typeof previews)[number] | undefined> | undefined;
  const findLivePreview = () =>
    (livePreview ??= (async () => {
      const candidates = previews
        .filter((item) => previewIds.has(item.id) && item.workspaceId === task.workspaceId)
        .slice(0, 8);
      for (let i = 0; i < candidates.length; i += 4) {
        const batch = candidates.slice(i, i + 4);
        const ready = await Promise.all(batch.map(isLive));
        const found = batch.find((_, index) => ready[index]);
        if (found) return found;
      }
      return undefined;
    })());
  for (const output of outputs) {
    if (output.kind === 'answer') continue;
    const mediaPending = output.kind === 'media' && (intent.deferredFiles?.size ?? 0) > 0;
    if (!output.files?.length && !output.directories?.length && !mediaPending)
      unavailable.push(
        `${output.title}: declare its source files or output directory in the plan.`
      );
    if (output.directories?.length && !mediaPending) {
      const readable = await withRunnerAbort(AbortSignal.timeout(2_000), () =>
        deps.runner.call<{ fileCount: number }>(
          task.workspaceId,
          task.id,
          'files.read',
          `/v1/workspaces/${task.workspaceId}/bundle-manifest`,
          { paths: [], directories: output.directories }
        )
      )
        .then((manifest) => manifest.fileCount > 0)
        .catch(() => false);
      if (!readable)
        unavailable.push(
          `${output.title}: its declared output directory is not available as a source bundle.`
        );
    }
    if (output.kind !== 'app') continue;
    if (output.delivery === 'package') {
      if (!output.run || !intent.passedCheckIds?.has(output.run.acceptanceCheckId))
        unavailable.push(
          `${output.title}: package delivery needs run instructions and a passed named command acceptance check.`
        );
    } else {
      const live = await findLivePreview();
      if (live) {
        const url = previewUrl(deps.config.PREVIEW_BASE_URL, live.slug, undefined, live.entryPath);
        if (!deliverables.some((value) => address(value) === address(url))) deliverables.push(url);
      }
      if (!live)
        unavailable.push(
          `${output.title}: publish a usable preview, or declare package delivery with run instructions and a passing acceptance check.`
        );
    }
  }
  const checks = deliverables.slice(0, 50);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, checks.length) }, async () => {
      while (next < checks.length) {
        const value = checks[next++]!;
        const declaredPath = deliveryFilePath(value);
        if (declaredPath && intent.deferredFiles?.has(declaredPath)) continue;
        if (names.has(value)) continue;
        const url = address(value);
        const preview = url
          ? previews.find(
              (item) =>
                item.workspaceId === task.workspaceId &&
                previewIds.has(item.id) &&
                address(
                  previewUrl(deps.config.PREVIEW_BASE_URL, item.slug, undefined, item.entryPath)
                ) === url
            )
          : undefined;
        const path = url ? null : deliveryFilePath(value);
        const readable = await withRunnerAbort(AbortSignal.timeout(2_000), async () => {
          if (preview) return isLive(preview);
          if (!path) return false;
          await deps.runner.call(
            task.workspaceId,
            task.id,
            'files.read',
            `/v1/workspaces/${task.workspaceId}/file?${new URLSearchParams({ path, maxBytes: '1' })}`,
            undefined,
            { responseType: 'text' }
          );
          return true;
        }).catch(() => false);
        if (!readable) unavailable.push((url ?? value).slice(0, 240));
      }
    })
  );
  if (deliverables.length > checks.length)
    unavailable.push(
      `${deliverables.length - checks.length} additional output references exceed the delivery check limit.`
    );
  return { deliverables, unavailable: unavailable.sort() };
};
