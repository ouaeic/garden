import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { SecurityMode, TaskEventKind, TaskStatus } from '@athanor/contracts';

const number = z.number().finite().nonnegative();
const reference = z.string().regex(/^[a-f0-9]{32}$/);
const category = z.enum([
  'command',
  'process',
  'browser',
  'desktop',
  'code',
  'files',
  'research',
  'communication',
  'coordination',
  'other'
]);
const message = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool', 'unknown']),
  bytes: number,
  fingerprint: reference
});
export const DiagnosticRecord = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('header'),
      format: z.literal('garden-diagnostic'),
      version: z.literal(1),
      redaction: z.literal('content_omitted'),
      replay: z.literal('recorded_events_only'),
      observedAt: z.string().datetime(),
      throughSequence: number.int(),
      task: z.object({
        reference,
        status: TaskStatus,
        securityMode: SecurityMode,
        modelReference: reference,
        spentUsd: number,
        attempt: number.int()
      }),
      checkpoint: z.object({
        readable: z.boolean(),
        step: number.int().nullable(),
        turn: number.int().nullable(),
        preparedInputTokens: number.nullable(),
        compactions: number.int().nullable(),
        waiting: z.enum(['approval', 'private_input', 'question', 'jobs', 'resource', 'none']),
        pendingTool: z.object({ reference, category }).optional(),
        independentWork: z.boolean(),
        messages: z.array(message).max(2000),
        messagesOmitted: number.int()
      })
    })
    .strict(),
  z
    .object({
      type: z.literal('event'),
      sequence: number.int().positive(),
      kind: TaskEventKind,
      at: z.string().datetime(),
      fingerprint: reference,
      payloadBytes: number.int(),
      unreadable: z.boolean(),
      tool: z.object({ reference, category }).optional(),
      approval: z
        .object({
          reference,
          sideEffect: z
            .enum(['workspace_write', 'external_reversible', 'external_consequential'])
            .optional(),
          decision: z.enum(['approved', 'denied', 'expired']).optional()
        })
        .optional(),
      status: TaskStatus.optional(),
      result: z
        .object({
          exitCode: z.number().int().optional(),
          passed: z.boolean().optional(),
          skipped: z.boolean().optional(),
          yielded: z.boolean().optional(),
          status: z
            .enum(['running', 'completed', 'failed', 'timed_out', 'stopped', 'interrupted'])
            .optional()
        })
        .optional(),
      metrics: z
        .object({
          inputTokens: number.optional(),
          outputTokens: number.optional(),
          cachedInputTokens: number.optional(),
          costUsd: number.optional(),
          estimatedInputTokens: number.optional(),
          contextWindowTokens: number.optional(),
          olderToolOutputChars: number.optional()
        })
        .optional()
    })
    .strict(),
  z
    .object({
      type: z.literal('footer'),
      events: number.int(),
      unreadableEvents: number.int(),
      lastSequence: number.int(),
      complete: z.boolean()
    })
    .strict()
]);
export type DiagnosticRecord = z.infer<typeof DiagnosticRecord>;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const toolCategory = (name: unknown): z.infer<typeof category> => {
  if (typeof name !== 'string') return 'other';
  if (name === 'shell') return 'command';
  if (name === 'process') return 'process';
  if (name.startsWith('browser_')) return 'browser';
  if (name.startsWith('desktop_')) return 'desktop';
  if (name.startsWith('code_') || name === 'file_patch') return 'code';
  if (name.startsWith('file') || name === 'image_read') return 'files';
  if (['web_search', 'parallel_web_read', 'session_search'].includes(name)) return 'research';
  if (name === 'connector_action') return 'communication';
  if (['ask', 'finish', 'set_plan', 'set_acceptance', 'delegate'].includes(name))
    return 'coordination';
  return 'other';
};

/** Export allowlists preserve structure and counters; no free-form content crosses this boundary. */
export function createDiagnosticProjector(key = randomBytes(32)) {
  const fingerprint = (value: unknown) =>
    createHmac('sha256', key)
      .update(JSON.stringify(value) ?? 'null')
      .digest('hex')
      .slice(0, 32);
  const shapes = (values: unknown) => {
    const messages = Array.isArray(values) ? values : [];
    return {
      messages: messages.slice(-2000).map((value) => {
        const item = object(value),
          role = message.shape.role.safeParse(item.role);
        const content = JSON.stringify(item.content ?? '');
        return {
          role: role.success ? role.data : 'unknown',
          bytes: Buffer.byteLength(content),
          fingerprint: fingerprint(item.content)
        };
      }),
      messagesOmitted: Math.max(0, messages.length - 2000)
    };
  };
  return {
    fingerprint,
    header(
      task: {
        id: string;
        status: string;
        securityMode: string;
        modelId: string;
        spentUsd: number;
        attempt: number;
      },
      state: unknown,
      throughSequence: number,
      observedAt = new Date().toISOString()
    ): DiagnosticRecord {
      const checkpoint = object(state),
        question = object(checkpoint.question),
        pending = object(checkpoint.pending),
        pendingCall = object(pending.toolCall);
      return DiagnosticRecord.parse({
        type: 'header',
        format: 'garden-diagnostic',
        version: 1,
        redaction: 'content_omitted',
        replay: 'recorded_events_only',
        observedAt,
        throughSequence,
        task: {
          reference: fingerprint(task.id),
          status: task.status,
          securityMode: task.securityMode,
          modelReference: fingerprint(task.modelId),
          spentUsd: task.spentUsd,
          attempt: task.attempt
        },
        checkpoint: {
          readable: state !== undefined,
          step: finite(checkpoint.step),
          turn: finite(checkpoint.turn),
          preparedInputTokens: finite(checkpoint.preparedInputTokens),
          compactions: finite(checkpoint.compactions),
          ...(typeof pendingCall.id === 'string'
            ? {
                pendingTool: {
                  reference: fingerprint(pendingCall.id),
                  category: toolCategory(pendingCall.name)
                }
              }
            : {}),
          waiting: checkpoint.pending
            ? pending.handoffOnly
              ? 'private_input'
              : 'approval'
            : question.waiting
              ? 'question'
              : checkpoint.jobWaitId
                ? 'jobs'
                : task.status === 'awaiting_resource'
                  ? 'resource'
                  : 'none',
          independentWork: Boolean(question.continueWith && !question.waiting),
          ...shapes(checkpoint.messages)
        }
      });
    },
    event(
      row: { sequence: number; kind: string; createdAt: string },
      payload: unknown,
      unreadable = false
    ): DiagnosticRecord {
      const body = object(payload),
        result = object(body.result),
        usage = object(body.usage),
        context = object(body.context);
      const call = object(body.call),
        name = call.name ?? body.name ?? body.tool;
      const toolId = body.toolCallId ?? call.id;
      const metrics: Record<string, number> = {};
      for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const)
        if (finite(usage[field]) !== null) metrics[field] = usage[field] as number;
      for (const field of [
        'estimatedInputTokens',
        'contextWindowTokens',
        'olderToolOutputChars'
      ] as const)
        if (finite(context[field]) !== null) metrics[field] = context[field] as number;
      if (finite(body.costUsd) !== null) metrics.costUsd = body.costUsd as number;
      const outcome: Record<string, unknown> = {};
      if (Number.isSafeInteger(result.exitCode)) outcome.exitCode = result.exitCode;
      for (const field of ['passed', 'skipped', 'yielded'])
        if (typeof result[field] === 'boolean') outcome[field] = result[field];
      if (
        ['running', 'completed', 'failed', 'timed_out', 'stopped', 'interrupted'].includes(
          String(result.status)
        )
      )
        outcome.status = result.status;
      const status = TaskStatus.safeParse(body.status);
      return DiagnosticRecord.parse({
        type: 'event',
        sequence: row.sequence,
        kind: row.kind,
        at: row.createdAt,
        fingerprint: fingerprint(payload),
        payloadBytes: Buffer.byteLength(JSON.stringify(payload) ?? ''),
        unreadable,
        ...(typeof toolId === 'string'
          ? { tool: { reference: fingerprint(toolId), category: toolCategory(name) } }
          : {}),
        ...(typeof body.approvalId === 'string'
          ? {
              approval: {
                reference: fingerprint(body.approvalId),
                ...(['workspace_write', 'external_reversible', 'external_consequential'].includes(
                  String(body.sideEffect)
                )
                  ? { sideEffect: body.sideEffect }
                  : {}),
                ...(['approved', 'denied', 'expired'].includes(String(body.decision))
                  ? { decision: body.decision }
                  : {})
              }
            }
          : {}),
        ...(status.success ? { status: status.data } : {}),
        ...(Object.keys(outcome).length ? { result: outcome } : {}),
        ...(Object.keys(metrics).length ? { metrics } : {})
      });
    }
  };
}

/** Reconstructs recorded control flow only. It has no tool executor or provider connection. */
export class DiagnosticReplay {
  #header: Extract<DiagnosticRecord, { type: 'header' }> | undefined;
  #footer: Extract<DiagnosticRecord, { type: 'footer' }> | undefined;
  #sequence = 0;
  #events = 0;
  #missing = 0;
  #unreadable = 0;
  #tools = new Set<string>();
  #approvals = new Set<string>();
  #failed = 0;
  #cost = 0;
  #lastFailureSequence: number | null = null;
  accept(value: unknown): void {
    const row = DiagnosticRecord.parse(value);
    if (this.#footer) throw new Error('Diagnostic contains records after its footer');
    if (row.type === 'header') {
      if (this.#header || this.#events) throw new Error('Diagnostic has more than one header');
      this.#header = row;
      return;
    }
    if (!this.#header) throw new Error('Diagnostic has no header');
    if (row.type === 'footer') {
      if (
        row.events !== this.#events ||
        row.lastSequence !== this.#sequence ||
        row.unreadableEvents !== this.#unreadable ||
        (row.complete && (this.#sequence !== this.#header.throughSequence || this.#missing > 0))
      )
        throw new Error('Diagnostic footer does not match its records');
      this.#footer = row;
      return;
    }
    if (row.sequence <= this.#sequence || row.sequence > this.#header.throughSequence)
      throw new Error('Diagnostic event order is invalid');
    this.#missing += row.sequence - this.#sequence - 1;
    this.#sequence = row.sequence;
    this.#events++;
    if (row.unreadable) this.#unreadable++;
    if (row.tool) {
      if (row.kind === 'tool_started') this.#tools.add(row.tool.reference);
      if (['tool_result', 'error'].includes(row.kind)) this.#tools.delete(row.tool.reference);
    }
    if (row.approval) {
      if (row.kind === 'approval_requested') this.#approvals.add(row.approval.reference);
      if (row.kind === 'approval_resolved') this.#approvals.delete(row.approval.reference);
    }
    if (
      row.kind === 'error' ||
      (row.result?.exitCode !== undefined && row.result.exitCode !== 0) ||
      row.result?.passed === false ||
      row.result?.status === 'failed'
    ) {
      this.#failed++;
      this.#lastFailureSequence = row.sequence;
    }
    this.#cost += row.metrics?.costUsd ?? 0;
  }
  result() {
    if (!this.#header || !this.#footer)
      throw new Error('Diagnostic is incomplete: header or footer missing');
    return {
      replay: 'recorded_events_only' as const,
      providerCalls: 0,
      commandsRun: 0,
      complete: this.#footer.complete,
      readable: this.#header.checkpoint.readable && this.#unreadable === 0,
      status: this.#header.task.status,
      waiting: this.#header.checkpoint.waiting,
      events: this.#events,
      unreadableEvents: this.#unreadable,
      missingEvents: this.#missing + this.#header.throughSequence - this.#sequence,
      unfinishedTools: this.#tools.size,
      unresolvedApprovals: this.#approvals.size,
      failedEvents: this.#failed,
      lastFailureSequence: this.#lastFailureSequence,
      recordedCostUsd: this.#cost
    };
  }
}
