/**
 * What a share link shows, decided once, on the owner's side, before any key exists.
 *
 * A snapshot is built from the conversation's own timeline and the artifacts the owner ticked, and
 * it is built the same way for the preview the owner reads in the dialog and for the ciphertext
 * the link serves - one function, so the owner cannot approve one document and publish another.
 *
 * The kind map is the privacy decision and it is written as an allow-list. A kind not named here
 * is not shown, whatever it carries; and for the kinds that are, what is taken is named field by
 * field. Tool steps contribute the one-line summary the worker wrote for the owner's timeline and
 * never the arguments or the result, because the result is the file the agent read, the page it
 * fetched, the screen it looked at - which is where a shared transcript leaks. Reasoning and
 * result text are opt-in switches, off by default, and even switched on the result is the text
 * rendering bounded below. `redactText` then runs over every string that leaves, the title and
 * artifact names included, so a credential the agent quoted never rides a link.
 *
 * No identifier of any kind survives into the snapshot: not the task's, the workspace's, an
 * event's, an approval's or the owner's. Artifacts are addressed by their position in the list.
 */

import { gzipSync } from 'node:zlib';
import type { ShareSnapshot, ShareSnapshotEventKind, TaskEventKind } from '@garden/contracts';
import {
  SHARE_LIMITS,
  SHARE_TOKEN_PATTERN,
  ShareSnapshotEventKind as SnapshotKind
} from '@garden/contracts';
import {
  GardenError,
  decryptJson,
  encryptBytes,
  generateDataKey,
  redactText,
  sha256,
  unwrapDataKey,
  type EncryptedEnvelope
} from '@garden/core';
import type { TaskRecord, UserRecord, WorkspaceRecord } from '@garden/data';
import { revealedTaskEvent, textValue } from './context.js';
import type { RouteContext } from './http/server-context.js';

export interface SnapshotOptions {
  includeReasoning: boolean;
  includeToolResults: boolean;
  artifactIds: string[];
  publicTitle?: string | undefined;
}

/** One artifact's bytes beside the entry the snapshot lists it under. */
export interface SnapshotArtifact {
  entry: ShareSnapshot['artifacts'][number];
  bytes: Buffer;
}

/** The generation time is incidental; every field a reader receives is bound explicitly. */
export const sharePreviewDigest = (snapshot: ShareSnapshot): string =>
  sha256(
    JSON.stringify({
      v: snapshot.v,
      title: snapshot.title,
      events: snapshot.events.map(({ kind, at, text }) => ({ kind, at, text })),
      artifacts: snapshot.artifacts.map(({ n, name, mimeType, sizeBytes, sha256 }) => ({
        n,
        name,
        mimeType,
        sizeBytes,
        sha256
      }))
    })
  );

/** How much of a tool result the owner may opt into. Past this the viewer gets a note, not a dump. */
const TOOL_RESULT_TEXT_CHARS = 20_000;

/**
 * An amount of money in a line the worker wrote. Cost is on the list of what a link never
 * carries, and the `cost` kind is not the only place it appears: the spend ceiling narrates itself
 * through a `status` line quoting the owner's spend and cap, and a `warning` line before it that
 * does the same. A worker line naming an amount is therefore not shown, whatever its kind.
 */
const MONEY_FIGURE = /\$\s?\d/;

/** The payload the spend ceiling attaches: the windows it measured, and which one blocked. */
const isSpendDecision = (data: Record<string, unknown>): boolean =>
  Array.isArray(data.windows) || typeof data.blockedBy === 'string';

/**
 * The sentence the worker wrote for the owner's timeline, and nothing it attached. What rides
 * beside a notice, a warning or an error has not been examined here - a failed tool step carries
 * the error's own message, which can quote the path or the page that failed - so the bare
 * sentence is carried the way a tool result's is, and a sentence quoting an amount is not carried
 * at all.
 */
const workerLine = (
  kind: ShareSnapshotEventKind,
  summary: string
): { kind: ShareSnapshotEventKind; text: string } | undefined =>
  MONEY_FIGURE.test(summary) ? undefined : { kind, text: summary };

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A tool result as text, whatever shape the runner returned it in. */
const resultText = (result: unknown): string => {
  if (typeof result === 'string') return result;
  const record = asRecord(result);
  for (const key of ['text', 'stdout', 'content', 'markdown', 'output']) {
    if (typeof record[key] === 'string') return record[key];
  }
  try {
    return JSON.stringify(result, null, 2) ?? '';
  } catch {
    return '';
  }
};

const bounded = (text: string): string =>
  text.length > TOOL_RESULT_TEXT_CHARS
    ? `${text.slice(0, TOOL_RESULT_TEXT_CHARS)}\n\n[${text.length - TOOL_RESULT_TEXT_CHARS} more characters not included]`
    : text;

/**
 * The line a viewer reads for one event, or `undefined` for an event the link does not carry.
 *
 * `payload` is what `revealedTaskEvent` opened; `summary` is the sentence the worker wrote for the
 * owner's timeline. Where both name a text the payload is the whole of it and the summary is the
 * first 500 characters, so the payload wins; where only the summary is safe to show, only the
 * summary is read.
 */
export const snapshotLine = (
  kind: TaskEventKind,
  summary: string,
  payload: unknown,
  options: Pick<SnapshotOptions, 'includeReasoning' | 'includeToolResults'>
): { kind: ShareSnapshotEventKind; text: string } | undefined => {
  const data = asRecord(payload);
  const markdown = textValue(data.markdown);
  switch (kind) {
    case 'user_message':
    case 'assistant_message':
      return { kind, text: markdown || summary };
    case 'assistant_reasoning':
      return options.includeReasoning ? { kind, text: markdown || summary } : undefined;
    case 'plan': {
      const steps = Array.isArray(data.steps) ? data.steps : [];
      const lines = steps.flatMap((step) => {
        const item = asRecord(step);
        const title = textValue(item.title);
        if (!title) return [];
        const done = item.status === 'completed';
        return [`- [${done ? 'x' : ' '}] ${title}`];
      });
      return { kind, text: lines.length ? `${summary}\n\n${lines.join('\n')}` : summary };
    }
    case 'status':
      // The fact of a spend halt is shown; the figures in its sentence are not.
      if (isSpendDecision(data)) return { kind, text: 'Paused at a spending limit.' };
      return workerLine(kind, summary);
    case 'warning':
      if (isSpendDecision(data)) return { kind, text: 'Approaching a spending limit.' };
      return workerLine(kind, summary);
    case 'approval_requested':
    case 'approval_resolved':
      return { kind, text: summary };
    case 'completed':
      return { kind, text: textValue(data.summary) || summary };
    case 'question_asked':
      return { kind, text: textValue(data.question) || summary };
    case 'tool_started':
      return { kind, text: summary };
    case 'tool_result':
      return options.includeToolResults && data.result !== undefined
        ? { kind, text: `${summary}\n\n${bounded(resultText(data.result))}` }
        : { kind, text: summary };
    case 'notice':
    case 'error':
      return workerLine(kind, summary);
    default:
      return undefined;
  }
};

/**
 * Reads the conversation, applies the kind map and the redaction net, and fetches the ticked
 * artifacts out of the workspace. Throws `task_not_found` for a conversation that is not this
 * owner's - the same answer as for one that does not exist.
 */
export const buildShareSnapshot = async (
  context: Pick<RouteContext, 'store' | 'masterKey' | 'runner' | 'taskTitle'>,
  user: UserRecord,
  taskId: string,
  options: SnapshotOptions
): Promise<{
  task: TaskRecord;
  workspace: WorkspaceRecord;
  snapshot: ShareSnapshot;
  artifacts: SnapshotArtifact[];
}> => {
  const { store, masterKey, runner } = context;
  const task = await store.getTask(user.id, taskId);
  if (!task) throw new GardenError('task_not_found', 'Task not found', 404);
  const workspace = await store.getWorkspace(user.id, task.workspaceId);
  if (!workspace?.wrappedKey) throw new GardenError('workspace_not_found', 'Workspace not found');
  const dataKey = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);

  const events: ShareSnapshot['events'] = [];
  for (const event of await store.listTaskEvents(task.id, 0)) {
    const revealed = revealedTaskEvent(
      event.summary,
      event.payloadCiphertext
        ? decryptJson(event.payloadCiphertext, dataKey, `task-event:${task.id}`)
        : undefined
    );
    const line = snapshotLine(event.kind, revealed.summary, revealed.payload, options);
    if (!line || !line.text.trim()) continue;
    events.push({ kind: line.kind, at: event.createdAt, text: redactText(line.text) });
  }

  const artifacts: SnapshotArtifact[] = [];
  let total = 0;
  const seen = new Set<string>();
  for (const artifactId of options.artifactIds) {
    if (seen.has(artifactId)) continue;
    seen.add(artifactId);
    const artifact = await store.getArtifact(user.id, artifactId);
    // Ticked by id, so an id that is not this conversation's names nothing here - whatever else it
    // may name on this box.
    if (!artifact || artifact.taskId !== task.id)
      throw new GardenError('not_found', 'Artifact not found', 404);
    const sizeBytes = Number(artifact.sizeBytes);
    if (sizeBytes > SHARE_LIMITS.artifactBytes)
      throw new GardenError('share_too_large', 'An artifact is too large to share', 413);
    const bytes = await runner.request<Buffer>({
      workspaceId: workspace.id,
      userId: user.id,
      role: 'user',
      scopes: ['files.read'],
      path: `/v1/workspaces/${workspace.id}/file?path=${encodeURIComponent(String(artifact.storageKey))}`
    });
    if (sha256(bytes) !== artifact.sha256)
      throw new GardenError('artifact_integrity_failed', 'Artifact integrity check failed');
    if (bytes.byteLength > SHARE_LIMITS.artifactBytes)
      throw new GardenError('share_too_large', 'An artifact is too large to share', 413);
    total += bytes.byteLength;
    if (total > SHARE_LIMITS.totalBytes)
      throw new GardenError('share_too_large', 'This link would carry too much', 413);
    const name = decryptJson<{ name: string }>(
      artifact.nameCiphertext as EncryptedEnvelope,
      dataKey,
      `artifact-name:${workspace.id}`
    ).name;
    artifacts.push({
      entry: {
        n: artifacts.length,
        name: redactText(name),
        mimeType: String(artifact.mimeType).toLowerCase().split(';', 1)[0]?.trim() ?? '',
        sizeBytes: bytes.byteLength,
        sha256: sha256(bytes)
      },
      bytes
    });
  }

  const title = redactText(options.publicTitle ?? (await context.taskTitle(task, workspace)));
  const snapshot: ShareSnapshot = {
    v: 1,
    title,
    createdAt: new Date().toISOString(),
    events,
    artifacts: artifacts.map((artifact) => artifact.entry)
  };
  const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  if (snapshotBytes > SHARE_LIMITS.snapshotBytes || total + snapshotBytes > SHARE_LIMITS.totalBytes)
    throw new GardenError('share_too_large', 'This conversation is too long to share', 413);
  return { task, workspace, snapshot, artifacts };
};

/** The lookup id of a link: sixteen random bytes as base64url, 22 characters, stored only hashed. */
export const mintShareId = (): string => {
  const id = Buffer.from(generateDataKey().subarray(0, 16)).toString('base64url');
  if (!SHARE_TOKEN_PATTERN.test(id)) throw new Error('share id has the wrong shape');
  return id;
};

/** The AAD every part of one link is sealed under, keyed on the hash so a moved row fails its tag. */
export const shareAad = (lookupHash: string): string => `share:${lookupHash}`;
export const shareArtifactAad = (lookupHash: string, n: number): string =>
  `share:${lookupHash}:artifact:${n}`;

/**
 * Seals a built snapshot under a fresh key and returns everything the store needs, plus the key
 * and id that go into the link and nowhere else. The caller returns them once and drops them.
 */
export const sealShareSnapshot = (built: {
  snapshot: ShareSnapshot;
  artifacts: SnapshotArtifact[];
}): {
  id: string;
  key: Buffer;
  lookupHash: string;
  envelope: EncryptedEnvelope;
  manifest: Array<{ n: number; sizeBytes: number }>;
  snapshotBytes: number;
  artifacts: Array<{
    n: number;
    envelopeMeta: Omit<EncryptedEnvelope, 'ciphertext'>;
    ciphertext: Buffer;
    sizeBytes: number;
  }>;
} => {
  const id = mintShareId();
  const lookupHash = sha256(id);
  const key = generateDataKey();
  const json = Buffer.from(JSON.stringify(built.snapshot), 'utf8');
  const envelope = encryptBytes(gzipSync(json), key, shareAad(lookupHash));
  const artifacts = built.artifacts.map((artifact) => {
    const sealed = encryptBytes(
      artifact.bytes,
      key,
      shareArtifactAad(lookupHash, artifact.entry.n)
    );
    const { ciphertext, ...envelopeMeta } = sealed;
    return {
      n: artifact.entry.n,
      envelopeMeta,
      ciphertext: Buffer.from(ciphertext, 'base64'),
      sizeBytes: artifact.bytes.byteLength
    };
  });
  return {
    id,
    key,
    lookupHash,
    envelope,
    manifest: artifacts.map((artifact) => ({ n: artifact.n, sizeBytes: artifact.sizeBytes })),
    snapshotBytes: json.byteLength,
    artifacts
  };
};

/** The link as the owner is handed it: path and fragment, no origin, the key in the fragment. */
export const shareUrl = (id: string, key: Uint8Array): string =>
  `/v1/shares/${id}#1.${Buffer.from(key).toString('base64url')}`;

/** Every kind the snapshot may carry, for callers that want to check one without a switch. */
export const isSnapshotKind = (kind: string): kind is ShareSnapshotEventKind =>
  SnapshotKind.safeParse(kind).success;
