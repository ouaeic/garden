import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { PrivateDiagnosticReader } from '@athanor/core';
import {
  ModelMessage,
  ModelTool,
  DiagnosticModelRequest,
  validateDecisionInput,
  validateDecisionAnswers,
  type DecisionInput
} from '@athanor/model-gateway';
import { SecurityMode } from '@athanor/contracts';
import { approvalRequirement, type ApprovalContext } from './approval-policy.js';
import { requestDerivationBreach } from './turn-control.js';

const object = z.record(z.string(), z.unknown());
const envelope = z.object({ segmentId: z.uuid(), value: z.unknown() }).strict();
const approval = z
  .object({
    input: z
      .object({
        name: z.string(),
        args: object,
        securityMode: SecurityMode,
        context: object,
        now: z.iso.datetime()
      })
      .strict(),
    result: z.unknown()
  })
  .strict();
const derivation = z
  .object({
    input: z
      .object({
        prepared: z.array(ModelMessage),
        rederived: z.array(ModelMessage),
        sent: z.array(ModelTool),
        entitled: z.array(ModelTool),
        reservedTokens: z.number().finite(),
        reservedTokensOfSent: z.number().finite()
      })
      .strict(),
    result: z.string().nullable()
  })
  .strict();
const requestIdentity = z.object({ id: z.uuid() });
const attempt = z.object({ id: z.uuid(), attempt: z.number().int().positive() });
const outcome = attempt.extend({ outcome: z.enum(['completed', 'failed', 'interrupted']) });
type Pending = {
  segment: string;
  type: 'model' | 'decision';
  attempts: number;
  waiting: boolean;
  last?: string;
  decision?: DecisionInput;
};

/** Re-evaluates only pure boundaries. Observations are never dispatched to an executor. */
export class PrivateDecisionReplay {
  #reader = new PrivateDiagnosticReader();
  #segments = new Set<string>();
  #seenSegments = new Set<string>();
  #requests = new Map<string, Pending>();
  #seenRequests = new Set<string>();
  #approval = 0;
  #derivation = 0;
  #divergences: { sequence: number; boundary: string }[] = [];
  #observations = 0;
  #unfinished = false;
  accept(input: unknown) {
    const body = this.#reader.accept(input);
    if (!body) return;
    const { segmentId, value } = envelope.parse(body.data);
    if (body.kind === 'segment_start') {
      if (this.#seenSegments.has(segmentId)) throw new Error('Duplicate segment');
      if (this.#segments.size) this.#unfinished = true;
      this.#segments.add(segmentId);
      this.#seenSegments.add(segmentId);
      return;
    }
    if (!this.#segments.has(segmentId)) throw new Error('Record outside an open segment');
    if (body.kind === 'segment_end') {
      if ([...this.#requests.values()].some((row) => row.segment === segmentId))
        this.#unfinished = true;
      this.#segments.delete(segmentId);
      return;
    }
    if (body.kind === 'approval_decision') {
      const { input: request, result } = approval.parse(value);
      const actual = approvalRequirement(
        request.name,
        request.args,
        request.securityMode,
        request.context as ApprovalContext,
        new Date(request.now)
      );
      this.#approval++;
      if (!isDeepStrictEqual(JSON.parse(JSON.stringify(actual)), result))
        this.#divergences.push({ sequence: this.#reader.result().records, boundary: body.kind });
      return;
    }
    if (body.kind === 'request_derivation') {
      derivation.parse(value);
      const { input: request, result } = value as z.infer<typeof derivation>;
      this.#derivation++;
      if (requestDerivationBreach(request) !== result)
        this.#divergences.push({ sequence: this.#reader.result().records, boundary: body.kind });
      return;
    }
    this.#observations++;
    if (body.kind === 'harness_event') {
      object.parse(value);
      return;
    }
    const { id } = requestIdentity.parse(value);
    if (body.kind === 'model_request' || body.kind === 'decision_request') {
      if (this.#seenRequests.has(id)) throw new Error('Duplicate inference identity');
      const fields = object.parse(value);
      let decision: DecisionInput | undefined;
      if (body.kind === 'model_request') DiagnosticModelRequest.parse(fields.request);
      else {
        const request = object.parse(fields.request);
        decision = validateDecisionInput({ state: request.state, questions: request.questions });
      }
      this.#seenRequests.add(id);
      this.#requests.set(id, {
        segment: segmentId,
        type: body.kind === 'model_request' ? 'model' : 'decision',
        attempts: 0,
        waiting: false,
        ...(decision ? { decision } : {})
      });
      return;
    }
    const pending = this.#requests.get(id);
    if (!pending || pending.segment !== segmentId)
      throw new Error('Inference outcome without its request');
    if (body.kind === 'decision_outcome') {
      const decision = z
        .object({ outcome: z.enum(['completed', 'failed']), response: object.optional() })
        .parse(value);
      if (pending.type !== 'decision') throw new Error('Wrong inference kind');
      if (decision.outcome === 'completed')
        validateDecisionAnswers(pending.decision!, decision.response?.answers);
      this.#requests.delete(id);
      return;
    }
    if (pending.type !== 'model') throw new Error('Wrong inference kind');
    if (body.kind === 'model_attempt') {
      const row = attempt.parse(value);
      if (
        pending.waiting ||
        row.attempt !== pending.attempts + 1 ||
        (pending.last && pending.last !== 'failed')
      )
        throw new Error('Invalid inference attempt ordering');
      pending.attempts = row.attempt;
      pending.waiting = true;
      return;
    }
    if (body.kind === 'model_outcome') {
      const row = outcome.parse(value);
      if (row.outcome !== 'failed')
        z.object({
          response: z.object({
            text: z.string(),
            toolCalls: z.array(object),
            finishReason: z.string(),
            usage: z.object({
              inputTokens: z.number().nonnegative(),
              outputTokens: z.number().nonnegative(),
              totalTokens: z.number().nonnegative()
            }),
            metadata: z.object({ model: z.string(), provider: z.string() })
          })
        }).parse(value);
      if (!pending.waiting || row.attempt !== pending.attempts)
        throw new Error('Invalid inference outcome ordering');
      pending.waiting = false;
      pending.last = row.outcome;
      return;
    }
    const end = z
      .object({
        attempts: z.number().int().nonnegative(),
        outcome: z.enum(['completed', 'failed', 'interrupted'])
      })
      .parse(value);
    if (
      body.kind !== 'model_end' ||
      pending.waiting ||
      end.attempts !== pending.attempts ||
      (pending.last ? end.outcome !== pending.last : end.outcome !== 'failed')
    )
      throw new Error('Invalid inference completion');
    this.#requests.delete(id);
  }
  result() {
    const snapshot = this.#reader.result();
    return {
      ...snapshot,
      complete:
        snapshot.complete &&
        snapshot.records > 0 &&
        !this.#unfinished &&
        this.#segments.size === 0 &&
        this.#requests.size === 0 &&
        this.#reader.header?.status.state !== 'failed',
      semantic: {
        approvalDecisions: this.#approval,
        requestDerivations: this.#derivation,
        divergences: this.#divergences
      },
      observations: this.#observations,
      openSegments: this.#segments.size,
      unfinishedRequests: this.#requests.size,
      scope:
        'Recorded approval and request-derivation decisions; inference and tool observations are structural only.',
      providerCalls: 0,
      commandsRun: 0
    };
  }
}
