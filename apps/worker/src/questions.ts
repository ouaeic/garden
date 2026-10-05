import { runtimeNow, runtimeUUID } from '@garden/core';
import { botWallSite } from './provenance.js';

import { GardenError, encryptJson } from '@garden/core';
import { AGREED_DEAL_MARKER, TaskDeal } from '@garden/contracts';
import type { DataStore, TaskRecord } from '@garden/data';
import type { ModelToolCall } from '@garden/model-gateway';
import type { AgentState } from './agent-state.js';
import { askOutcome } from './completion.js';
import { sealUnansweredToolCalls } from './turn-lifecycle.js';
import { agentNotificationAad } from '@garden/data';

export interface QuestionDeps {
  store: DataStore;
  config: { WORKER_ID: string };
}

/** Persist before publishing, so a fast answer can always bind to the saved question. */
export async function saveQuestion(
  deps: QuestionDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  park: boolean,
  payload?: Record<string, unknown>
): Promise<void> {
  const saved = await deps.store.saveTaskQuestion({
    taskId: task.id,
    workerId: deps.config.WORKER_ID,
    agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`),
    actualComputeCredits: state.credits,
    park,
    ...(payload
      ? {
          event: {
            id: state.question!.id!,
            payloadCiphertext: encryptJson(
              { __gardenEventVersion: 1, summary: state.question!.question, payload },
              key,
              `task-event:${task.id}`
            )
          }
        }
      : {})
  });
  if (!saved)
    throw new GardenError('task_lease_lost', 'The task no longer holds its execution lease');
}

export async function waitForQuestion(
  deps: QuestionDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  call?: ModelToolCall
): Promise<boolean> {
  if (!state.question) return false;
  state.question.waiting = true;
  if (call) {
    state.messages.push({
      role: 'tool',
      toolCallId: call.id,
      content: `Waiting for the answer to: ${state.question.question}`
    });
    state.turnToolResults ??= {};
    state.turnToolResults[call.id] = { name: call.name, success: true };
  }
  sealUnansweredToolCalls(state.messages, 'waiting for the user’s answer');
  await saveQuestion(deps, task, key, state, true);
  return true;
}

export async function askUser(
  deps: QuestionDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  call: ModelToolCall
): Promise<boolean> {
  state.turnToolResults ??= {};
  const refuse = (reason: string) => {
    state.messages.push({ role: 'tool', toolCallId: call.id, content: `Refused: ${reason}` });
    state.turnToolResults![call.id] = { name: call.name, success: false };
    return false;
  };
  if (state.question) return refuse('A question is already waiting for an answer.');
  const outcome = askOutcome(state, call.arguments);
  if (!outcome.ok) return refuse(outcome.refusal.replace(/^Refused: /, ''));
  const { question, options, why, fallback } = outcome;
  const id = runtimeUUID();
  const answerBy = fallback
    ? new Date(runtimeNow() + fallback.waitHours * 3_600_000).toISOString()
    : undefined;
  state.questionsAsked = (state.questionsAsked ?? 0) + 1;
  state.question = {
    id,
    question,
    ...(why ? { why } : {}),
    askedAtStep: state.step,
    waiting: true,
    ...(fallback && answerBy ? { default: fallback.choice, answerBy } : {})
  };
  state.messages.push({
    role: 'tool',
    toolCallId: call.id,
    content: 'Sent to the user. Their answer resumes this turn.'
  });
  state.turnToolResults[call.id] = { name: call.name, success: true };
  sealUnansweredToolCalls(state.messages, 'waiting for the user’s answer');
  await saveQuestion(deps, task, key, state, true, {
    question,
    ...(why ? { why } : {}),
    questionId: id,
    ...(options.length ? { options } : {}),
    ...(fallback && answerBy ? { default: fallback.choice, answerBy } : {}),
    unattended: state.unattended === true
  });
  await deps.store
    .createAgentNotification({
      userId: task.userId,
      taskId: task.id,
      kind: 'agent_message',
      messageCiphertext: encryptJson({ message: question }, key, agentNotificationAad(task.id))
    })
    .catch(() => undefined);
  return true;
}

/**
 * Parks the turn on a deal: the agreed terms come back as the answer, in words.
 *
 * Refused where nobody can agree to anything - a scheduled run - and once a deal stands, so the
 * owner is never asked twice for the same job. A planted sibling goal starts from a prompt that
 * already carries its terms, which is the same thing said from the other end.
 */
export async function proposeDeal(
  deps: QuestionDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  call: ModelToolCall
): Promise<boolean> {
  state.turnToolResults ??= {};
  const refuse = (reason: string) => {
    state.messages.push({ role: 'tool', toolCallId: call.id, content: `Refused: ${reason}` });
    state.turnToolResults![call.id] = { name: call.name, success: false };
    return false;
  };
  if (state.unattended)
    return refuse('a scheduled run has nobody to agree a deal with. Work within the schedule.');
  if (state.question) return refuse('A question is already waiting for an answer.');
  const agreed =
    state.dealAgreed ||
    state.messages.some(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.trimStart().startsWith(AGREED_DEAL_MARKER)
    );
  if (agreed) return refuse('the deal for this goal is already agreed. Carry it out.');
  const parsed = TaskDeal.safeParse(call.arguments);
  if (!parsed.success)
    return refuse(
      `the deal is malformed (${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || 'deal'}: ${issue.message}`)
        .join('; ')}). Fix it and propose again.`
    );
  const deal = parsed.data;
  const id = runtimeUUID();
  state.question = {
    id,
    question: deal.summary,
    askedAtStep: state.step,
    waiting: true,
    deal: true
  };
  state.messages.push({
    role: 'tool',
    toolCallId: call.id,
    content: 'Sent to the user. The agreed terms resume this turn.'
  });
  state.turnToolResults[call.id] = { name: call.name, success: true };
  sealUnansweredToolCalls(state.messages, 'waiting for the user to agree the deal');
  await saveQuestion(deps, task, key, state, true, {
    question: deal.summary,
    questionId: id,
    deal
  });
  await deps.store
    .createAgentNotification({
      userId: task.userId,
      taskId: task.id,
      kind: 'agent_message',
      messageCiphertext: encryptJson(
        { message: `A deal is ready: ${deal.summary}` },
        key,
        agentNotificationAad(task.id)
      )
    })
    .catch(() => undefined);
  return true;
}

/** Keep a detected human challenge durable without replacing an unanswered direction. */
export async function parkBrowserHandoff(
  deps: QuestionDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState
): Promise<boolean> {
  if (!state.browserHandoff) return false;
  if (state.question) {
    state.question.waiting = true;
    await saveQuestion(deps, task, key, state, true);
    return true;
  }
  const wall = state.browserHandoff;
  const question = `Complete the browser verification on ${botWallSite(wall.url)}`;
  const handoff = {
    kind: 'challenge' as const,
    surface: 'browser' as const,
    url: wall.url,
    ...(wall.tabId ? { tabId: wall.tabId } : {})
  };
  state.question = { id: runtimeUUID(), question, askedAtStep: state.step, waiting: true, handoff };
  delete state.browserHandoff;
  state.messages.push({
    role: 'assistant',
    content:
      'The browser needs human verification. Work is paused until the owner completes the handoff. After their reply, observe the page afresh and continue; do not repeat their action.'
  });
  await saveQuestion(deps, task, key, state, true, {
    question,
    questionId: state.question.id,
    why: 'This site requires a person. Open the browser, complete its verification, then choose Done and continue.',
    handoff
  });
  return true;
}
