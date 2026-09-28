import { z } from 'zod';
import { GardenError } from '@garden/core';

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const instructions = z.string().min(1).max(6000);
const criteria = z.record(identifier, z.string().min(1).max(3000));
export const DecisionQuestion = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choice'), instructions, criteria }).strict(),
  z
    .object({
      type: z.literal('score'),
      instructions,
      criteria: z.array(z.string().min(1).max(3000)).min(2).max(64)
    })
    .strict(),
  z
    .object({
      type: z.literal('noul'),
      instructions,
      criteria: z
        .object({ true: z.string().min(1).max(3000), false: z.string().min(1).max(3000) })
        .strict()
        .optional()
    })
    .strict()
]);
export const DecisionInput = z
  .object({
    state: z.string().min(1).max(120_000),
    questions: z.record(identifier, DecisionQuestion)
  })
  .strict();
export type DecisionInput = z.infer<typeof DecisionInput>;

export function validateDecisionInput(value: unknown): DecisionInput {
  const input = DecisionInput.parse(value);
  const questions = Object.values(input.questions);
  if (!questions.length || questions.length > 64)
    throw new Error('Supply between one and 64 independent questions.');
  for (const question of questions) {
    if (question.type !== 'choice') continue;
    const count = Object.keys(question.criteria).length;
    if (count < 2 || count > 128)
      throw new Error('Each choice needs between two and 128 candidates.');
  }
  return input;
}

const concentration = z.number().min(0).max(1).optional();
const Answer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choice'), choice: identifier, confidence: concentration }),
  z.object({
    type: z.literal('score'),
    score: z.number().nonnegative(),
    confidence: concentration
  }),
  z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) })
]);
export type DecisionAnswer = z.infer<typeof Answer>;
export function validateDecisionAnswers(
  input: DecisionInput,
  value: unknown
): Record<string, DecisionAnswer> {
  const answers = z.record(identifier, Answer).parse(value);
  const keys = Object.keys(input.questions);
  if (
    Object.keys(answers).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(answers, key))
  )
    throw new Error('The decision response did not cover exactly the requested questions.');
  for (const key of keys) {
    const question = input.questions[key]!;
    const answer = answers[key]!;
    if (
      answer.type !== question.type ||
      (answer.type === 'choice' &&
        question.type === 'choice' &&
        !Object.hasOwn(question.criteria, answer.choice)) ||
      (answer.type === 'score' &&
        question.type === 'score' &&
        answer.score > question.criteria.length - 1)
    )
      throw new Error('The decision response selected an unknown candidate or an invalid score.');
  }
  return answers;
}

export interface DecisionRequest extends DecisionInput {
  model: string;
  inputRate: number;
  outputRate: number;
  sessionId: string;
  signal: AbortSignal;
}
export interface DecisionResponse {
  answers: unknown;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd?: number };
  metadata: { model: string; latencyMs: number; generationId?: string; upstreamProvider?: string };
}
export interface DecisionAdapter {
  decide(request: DecisionRequest): Promise<DecisionResponse>;
}

/** A separate protocol: no chat messages, generated reasoning or tool execution. */
export class OpenRouterDecisionAdapter implements DecisionAdapter {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      enforceZeroDataRetention: boolean;
      fetch?: typeof fetch;
    }
  ) {}

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    const input = validateDecisionInput({ state: request.state, questions: request.questions });
    const base = new URL(this.options.baseUrl);
    if (
      base.origin !== 'https://openrouter.ai' ||
      base.pathname.replace(/\/$/, '') !== '/api/v1' ||
      base.search ||
      base.hash
    )
      throw new GardenError(
        'decision_route_unavailable',
        'This connection does not offer the Decisions API.',
        409
      );
    if (
      ![request.inputRate, request.outputRate].every((rate) => Number.isFinite(rate) && rate >= 0)
    )
      throw new Error('Decision inference requires published token prices.');
    const started = performance.now();
    const response = await (this.options.fetch ?? fetch)(`${base.origin}/api/alpha/decisions`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
        'X-Title': 'garden'
      },
      body: JSON.stringify({
        model: request.model,
        ...input,
        session_id: request.sessionId,
        provider: {
          ...(this.options.enforceZeroDataRetention ? { zdr: true, data_collection: 'deny' } : {}),
          max_price: { prompt: request.inputRate, completion: request.outputRate },
          sort: 'latency'
        }
      }),
      signal: request.signal
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new GardenError(
        'decision_provider_error',
        `Decision inference returned HTTP ${response.status}.`,
        response.status
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Decision inference returned no response body.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 1_048_576) throw new Error('Decision response exceeded its transport limit.');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const body = z
      .object({
        model: z.string().min(1).max(256),
        id: z.string().min(1).max(256).optional(),
        provider: z.string().max(256).optional(),
        answers: z.unknown(),
        usage: z.object({
          input_tokens: z.number().int().nonnegative(),
          output_tokens: z.number().int().nonnegative(),
          cost: z.number().nonnegative().optional()
        })
      })
      .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    // Usage is available even when the answer itself fails the caller's evidence contract.
    return {
      answers: body.answers,
      usage: {
        inputTokens: body.usage.input_tokens,
        outputTokens: body.usage.output_tokens,
        totalTokens: body.usage.input_tokens + body.usage.output_tokens,
        ...(body.usage.cost === undefined ? {} : { costUsd: body.usage.cost })
      },
      metadata: {
        model: body.model,
        latencyMs: Math.round(performance.now() - started),
        ...(body.id ? { generationId: body.id } : {}),
        ...(body.provider ? { upstreamProvider: body.provider } : {})
      }
    };
  }
}
