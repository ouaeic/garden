import type { ComputationCell, TaskEvent } from '@garden/contracts';

export interface ComputationHistoryEntry {
  cellId: string;
  sequence: number;
  action: 'cell' | 'checkpoint' | 'restore' | 'unknown';
  source?: string;
  path?: string;
  submittedAt?: string;
  receipt?: ComputationCell;
  errors: string[];
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const bounded = (value: unknown, limit: number) =>
  typeof value === 'string' && value.length <= limit;
const validManifest = (value: unknown): boolean => {
  const manifest = record(value),
    runtime = record(manifest.runtime);
  return (
    manifest.format === 'garden-computation-manifest-1' &&
    bounded(manifest.capturedAt, 100) &&
    Number.isFinite(Date.parse(String(manifest.capturedAt))) &&
    manifest.coverage === 'declared_inputs_before_execution' &&
    hash(manifest.requestSha256) &&
    (manifest.sourceSha256 === undefined || hash(manifest.sourceSha256)) &&
    (manifest.predecessorCellId === undefined || bounded(manifest.predecessorCellId, 120)) &&
    (manifest.runtime === undefined ||
      (bounded(runtime.version, 200) &&
        bounded(runtime.platform, 100) &&
        bounded(runtime.architecture, 100))) &&
    Array.isArray(manifest.inputs) &&
    manifest.inputs.length <= 32 &&
    manifest.inputs.every((value) => {
      const input = record(value);
      return (
        bounded(input.path, 4096) &&
        (input.status === 'hashed'
          ? hash(input.sha256) && Number.isSafeInteger(input.bytes) && Number(input.bytes) >= 0
          : input.status === 'unavailable' &&
            ['not_readable', 'too_large', 'budget_exhausted', 'changed_during_read'].includes(
              String(input.reason)
            ))
      );
    })
  );
};
const cellReceipt = (value: unknown): ComputationCell | undefined => {
  const cell = record(value);
  if (
    typeof cell.cellId !== 'string' ||
    !['running', 'completed', 'failed', 'interrupted'].includes(String(cell.state)) ||
    typeof cell.startedAt !== 'string' ||
    typeof cell.stdout !== 'string' ||
    typeof cell.stderr !== 'string' ||
    !Array.isArray(cell.artifacts) ||
    cell.artifacts.some((value) => {
      const artifact = record(value);
      return (
        typeof artifact.path !== 'string' ||
        typeof artifact.mimeType !== 'string' ||
        typeof artifact.bytes !== 'number'
      );
    }) ||
    (cell.error !== undefined && typeof cell.error !== 'string') ||
    (cell.finishedAt !== undefined && typeof cell.finishedAt !== 'string') ||
    (cell.manifest !== undefined && !validManifest(cell.manifest))
  )
    return undefined;
  return cell as unknown as ComputationCell;
};

/** Joins submitted code to native receipts already sealed in the task transcript. */
export function computationHistory(
  events: readonly TaskEvent[],
  sessionId: string
): ComputationHistoryEntry[] {
  const entries = new Map<string, ComputationHistoryEntry>();
  const calls = new Map<
    string,
    { cellId: string; action: ComputationHistoryEntry['action']; source?: string; path?: string }
  >();
  const ordered = [...new Map(events.map((event) => [event.sequence, event])).values()].sort(
    (a, b) => a.sequence - b.sequence
  );
  for (const event of ordered) {
    const payload = record(event.payload);
    const callId = string(payload.toolCallId);
    if (!callId) continue;
    if (event.kind === 'tool_started') {
      const args = record(payload.arguments),
        options = record(args.options);
      if (
        payload.tool !== 'process' ||
        args.action !== 'compute' ||
        (args.sessionId ?? options.sessionId) !== sessionId
      )
        continue;
      const action = options.action;
      if (action !== 'cell' && action !== 'checkpoint' && action !== 'restore') continue;
      const cellId = string(options.cellId) ?? `call:${callId}`;
      calls.set(callId, {
        cellId,
        action,
        ...(string(options.code) !== undefined ? { source: string(options.code)! } : {}),
        ...(string(options.path) !== undefined ? { path: string(options.path)! } : {})
      });
      // Rejected retries must not replace the source that belongs to the accepted cell.
      if (!entries.has(cellId))
        entries.set(cellId, {
          cellId,
          sequence: event.sequence,
          action,
          submittedAt: event.createdAt,
          ...(string(options.code) !== undefined ? { source: string(options.code)! } : {}),
          ...(string(options.path) !== undefined ? { path: string(options.path)! } : {}),
          errors: []
        });
      continue;
    }
    const submitted = calls.get(callId);
    if (event.kind === 'error') {
      const message = string(payload.message);
      if (submitted && message) entries.get(submitted.cellId)?.errors.push(message);
      continue;
    }
    if (event.kind !== 'tool_result') continue;
    const result = record(payload.result);
    if (result.sessionId !== sessionId) continue;
    const receipt = cellReceipt(result.latestCell);
    if (!receipt) continue;
    if (submitted && !submitted.cellId.startsWith('call:') && submitted.cellId !== receipt.cellId)
      continue;
    let entry = entries.get(receipt.cellId);
    if (!entry && submitted?.cellId.startsWith('call:')) {
      entry = entries.get(submitted.cellId);
      entries.delete(submitted.cellId);
      if (entry) entry.cellId = receipt.cellId;
      calls.set(callId, { ...submitted, cellId: receipt.cellId });
    }
    if (!entry)
      entry = { cellId: receipt.cellId, sequence: event.sequence, action: 'unknown', errors: [] };
    // A later accepted submission owns the source when an earlier attempt produced no receipt.
    if (!entry.receipt && submitted) {
      if (submitted.source === undefined) delete entry.source;
      else entry.source = submitted.source;
      if (submitted.path === undefined) delete entry.path;
      else entry.path = submitted.path;
      entry.action = submitted.action;
    }
    entry.receipt = receipt;
    entries.set(receipt.cellId, entry);
  }
  return [...entries.values()].sort((a, b) => a.sequence - b.sequence);
}
