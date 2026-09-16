import { botWallSite } from './provenance.js';
import { randomUUID } from 'node:crypto';
import { AthanorError, encryptJson } from '@athanor/core';
import type { DataStore, TaskRecord } from '@athanor/data';
import type { ModelToolCall } from '@athanor/model-gateway';
import type { AgentState } from './agent-state.js';
import { askOutcome } from './completion.js';
import { textValue } from './values.js';
import { sealUnansweredToolCalls } from './turn-lifecycle.js';
import { agentNotificationAad } from '@athanor/data';

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
              { __athanorEventVersion: 1, summary: state.question!.question, payload },
              key,
              `task-event:${task.id}`
            )
          }
        }
      : {})
  });
  if (!saved)
    throw new AthanorError('task_lease_lost', 'The task no longer holds its execution lease');
}

export async function waitForQuestion(
  deps: QuestionDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  call: ModelToolCall
): Promise<boolean> {
  if (!state.question) return false;
  state.question.waiting = true;
  state.messages.push({
    role: 'tool',
    toolCallId: call.id,
    content: `Waiting for question ${state.question.id ?? ''}: ${state.question.question}. The user's answer will resume this work; do not infer it from elapsed time.`
  });
  sealUnansweredToolCalls(state.messages, 'waiting for the user’s answer');
  state.turnToolResults ??= {};
  state.turnToolResults[call.id] = { name: call.name, success: true };
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
  const waitFor = textValue(call.arguments.waitFor);
  state.turnToolResults ??= {};
  const refuse = (reason: string) => {
    state.messages.push({ role: 'tool', toolCallId: call.id, content: `Refused: ${reason}` });
    state.turnToolResults![call.id] = { name: call.name, success: false };
    return false;
  };
  if (waitFor) {
    if (waitFor !== state.question?.id)
      return refuse('That question is not waiting for an answer.');
    return waitForQuestion(deps, task, key, state, call);
  }
  if (state.question)
    return refuse(
      `A question is already pending (${state.question.id ?? state.question.question}). Continue only independent work, or call ask with waitFor to pause.`
    );
  const outcome = askOutcome(state, call.arguments);
  if (!outcome.ok) return refuse(outcome.refusal.replace(/^Refused: /, ''));
  const { question, options, why } = outcome;
  const continueWith = textValue(call.arguments.continueWith)
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 400);
  const id = randomUUID();
  state.questionsAsked = (state.questionsAsked ?? 0) + 1;
  state.question = {
    id,
    question,
    why,
    askedAtStep: state.step,
    ...(continueWith ? { continueWith } : { waiting: true })
  };
  state.messages.push({
    role: 'tool',
    toolCallId: call.id,
    content: JSON.stringify({
      questionId: id,
      question,
      options,
      blockedWork: why,
      ...(continueWith
        ? {
            continueWith,
            instruction:
              'Continue only this independent work. Do not guess the answer or do dependent work. The reply arrives during the task. Call ask with waitFor when no independent work remains.'
          }
        : {
            waiting: true,
            instruction: 'The task is waiting for the user. Their reply resumes this turn.'
          })
    })
  });
  state.turnToolResults[call.id] = { name: call.name, success: true };
  if (!continueWith) sealUnansweredToolCalls(state.messages, 'waiting for the user’s answer');
  await saveQuestion(deps, task, key, state, !continueWith, {
    question,
    why,
    questionId: id,
    ...(options.length ? { options } : {}),
    ...(continueWith ? { continueWith } : {}),
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
  return !continueWith;
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
  state.question = { id: randomUUID(), question, askedAtStep: state.step, waiting: true, handoff };
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
