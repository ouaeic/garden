import { sha256 } from '@garden/core';
import {
  validateDecisionInput,
  validateDecisionAnswers,
  type DecisionAnswer,
  type DecisionInput
} from '@garden/model-gateway';
import type { ToolContext } from './tool-dispatch.js';
import { resolveDecisionRoute } from './decision-route.js';
import { approvalRequirement } from './approval-policy.js';
import { estimatedInferenceCostUsd, usageCredit } from './billing.js';
import { startStopWatch } from './turn-lifecycle.js';
import { DecisionToolInput, resolveDecisionInput } from './decision-input.js';

export type DecisionContext = Pick<
  ToolContext,
  'store' | 'masterKey' | 'config' | 'task' | 'state' | 'connectedModels' | 'gateway'
>;
export type DecisionResult =
  | {
      status: 'decided';
      answers: Record<string, DecisionAnswer>;
      model: string;
      modelId: string;
      latencyMs: number;
      costUsd: number;
      usageCredits: number;
      generationId?: string;
    }
  | { status: 'unavailable'; reason: string; usageCredits: number };

/** A ready question is sent now; independent questions can share evidence without waiting. */
export async function runDecisions(
  context: DecisionContext,
  value: unknown,
  requestId: string,
  options: { floorBinding?: string; timeoutMs?: number } = {}
): Promise<DecisionResult> {
  const input = validateDecisionInput(value);
  const unavailable = (reason: string, usageCredits = 0): DecisionResult => ({
    status: 'unavailable',
    reason,
    usageCredits
  });
  const { task, store, state } = context;
  const route = await resolveDecisionRoute(context, task).catch(() => null);
  if (!route)
    return unavailable(
      'No decision model is available on this task’s saved connection and privacy route. Continue with the main model.'
    );
  if (options.floorBinding !== undefined && options.floorBinding !== route.binding)
    return unavailable(
      'The decision route changed after its approval check; no evidence was sent.'
    );
  const floor = approvalRequirement('decide', input, task.securityMode, {
    decisionInference: { boundToTaskConnection: true }
  });
  if (floor)
    return unavailable('The decision route requires approval before evidence can be sent.');
  const model = route.model;
  if (
    [model.inputUsdPerMillionTokens, model.outputUsdPerMillionTokens].some(
      (rate) => typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0
    )
  )
    return unavailable('The decision model has no complete published token price.');
  const fingerprint = sha256(
    JSON.stringify([task.id, state.turn ?? 0, route.binding, model.updatedAt, input])
  );
  const cached = state.decisionReceipts?.[fingerprint];
  if (cached) return { ...cached, usageCredits: 0 };
  const inputBound = Buffer.byteLength(JSON.stringify(input), 'utf8') + 2048;
  const outputBound = decisionOutputBound(input);
  const boundCredits = usageCredit(model, inputBound, outputBound);
  // Decision answers are computed independently, not generated into the input window.
  // Billing still reserves both input and output exposure below.
  if (inputBound > model.contextTokens)
    return unavailable(
      'The evidence and questions exceed the decision context. Split independent questions or narrow the evidence.'
    );
  if (boundCredits > task.maxComputeCredits - state.credits)
    return unavailable('The remaining task allowance cannot cover this decision.');
  const claim = await store.taskClaim(task.id).catch(() => null);
  if (
    !claim ||
    !['planning', 'running'].includes(claim.status) ||
    claim.leaseOwner !== context.config.WORKER_ID
  )
    return unavailable('The task stopped before decision inference.');
  const connection = await context.gateway(task, model).catch(() => null);
  if (
    !connection ||
    connection.credential.provider !== 'openrouter' ||
    (task.privacyRoute === 'provider_zdr' && !connection.credential.enforceZeroDataRetention)
  )
    return unavailable('The selected connection cannot meet this task’s decision privacy policy.');
  const usage = {
    userId: task.userId,
    workspaceId: task.workspaceId,
    taskId: task.id,
    kind: 'model_inference',
    resourceClass: 'model:decisions',
    unit: 'tokens',
    quantity: inputBound + outputBound,
    credits: boundCredits,
    costUsd: estimatedInferenceCostUsd(model, inputBound, outputBound),
    idempotencyKey: `decision:${task.id}:${sha256(`${requestId}:${fingerprint}`)}`,
    providerRef: `${model.provider}:${model.providerModelId}`
  };
  let familyReservation: string | undefined;
  try {
    if (task.hasCodingFamily)
      familyReservation = await store.reserveCodingInference(
        task.id,
        context.config.WORKER_ID,
        boundCredits,
        usage.costUsd,
        sha256(usage.idempotencyKey)
      );
    else await store.recordUsage({ ...usage, state: 'reserved', reserveAgainstCaps: true });
  } catch {
    return unavailable(
      'This decision cannot reserve allowance or already has an unsettled receipt. Continue without repeating it.'
    );
  }
  state.credits += boundCredits;
  let charged = boundCredits;
  let settled = false;
  const watch = startStopWatch(() => store.taskClaim(task.id), context.config.WORKER_ID);
  try {
    const response = await connection.gateway.decide(connection.provider, {
      ...input,
      model: model.providerModelId,
      inputRate: model.inputUsdPerMillionTokens!,
      outputRate: model.outputUsdPerMillionTokens!,
      sessionId: usage.idempotencyKey,
      signal: AbortSignal.any([watch.signal, AbortSignal.timeout(options.timeoutMs ?? 10_000)])
    });
    charged = usageCredit(model, response.usage.inputTokens, response.usage.outputTokens);
    const costUsd =
      response.usage.costUsd ??
      estimatedInferenceCostUsd(model, response.usage.inputTokens, response.usage.outputTokens);
    if (familyReservation) await store.settleCodingInference(familyReservation, charged, costUsd);
    await store.recordUsage({
      ...usage,
      state: 'settled',
      quantity: response.usage.totalTokens,
      credits: charged,
      costUsd,
      ...(familyReservation
        ? { codingReservationId: familyReservation }
        : { settleReservation: true })
    });
    settled = true;
    state.credits += charged - boundCredits;
    const result: DecisionResult = {
      status: 'decided',
      answers: validateDecisionAnswers(input, response.answers),
      model: response.metadata.model,
      modelId: model.id,
      latencyMs: response.metadata.latencyMs,
      costUsd,
      usageCredits: charged,
      ...(response.metadata.generationId ? { generationId: response.metadata.generationId } : {})
    };
    state.decisionReceipts = Object.fromEntries([
      ...Object.entries(state.decisionReceipts ?? {}).slice(-15),
      [fingerprint, result]
    ]);
    return result;
  } catch {
    if (familyReservation && !settled)
      await store.settleCodingInference(familyReservation, null).catch(() => undefined);
    return unavailable(
      'Decision inference did not produce a valid answer. Continue with the main model; the spending receipt was retained.',
      charged
    );
  } finally {
    watch.stop();
  }
}

function decisionOutputBound(input: DecisionInput): number {
  return (
    512 +
    Object.entries(input.questions).reduce((sum, [id, question]) => {
      const labels =
        question.type === 'choice'
          ? Object.keys(question.criteria)
          : question.type === 'score'
            ? question.criteria.map((criterion, index) => `${index}:${criterion}`)
            : ['true', 'false'];
      return sum + id.length + 256 + labels.reduce((count, label) => count + label.length + 48, 0);
    }, 0)
  );
}

export const executeDecisionTool: ToolContext['dispatch'] = async (context, call) => {
  const binding = context.state.decisionFloorBindings?.[call.id];
  if (!binding)
    return {
      status: 'unavailable',
      reason: 'The decision destination has not passed the approval floor.',
      usageCredits: 0
    };
  const input = DecisionToolInput.parse(call.arguments);
  const result = await runDecisions(context, resolveDecisionInput(context.state, input), call.id, {
    floorBinding: binding
  });
  if (!input.items || result.status !== 'decided') return result;
  const { answers, ...metadata } = result;
  const questions = Object.keys(input.questions);
  return {
    ...metadata,
    rows: input.items.map((id, itemIndex) => ({
      id,
      answers: Object.fromEntries(
        questions.map((question, questionIndex) => [
          question,
          answers[`i${itemIndex}_q${questionIndex}`]!
        ])
      )
    }))
  };
};
