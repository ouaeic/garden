/**
 * The answer an owner gave by not answering.
 *
 * A question asked with a default says how long it will wait - "I'll skip it if I don't hear by
 * Wednesday" - and this pass keeps that promise: once the time passes with no reply, the default is
 * sent as the answer, in words that say it was the owner's silence, and the work carries on. A
 * question without a default still waits for as long as the owner takes.
 */

import { decryptJson, unwrapDataKey } from '@garden/core';
import type { RouteContext } from '../http/server-context.js';
import { answerQuestion } from '../routes/questions.js';
import { errorFields } from '../log.js';

export const createQuestionDefaultSweep = (context: RouteContext) => {
  const { log, database, store, masterKey } = context;
  return async (now = Date.now()): Promise<number> => {
    const waiting = await database.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM tasks WHERE status = 'awaiting_user'
       ORDER BY updated_at ASC LIMIT 200`
    );
    let answered = 0;
    for (const row of waiting.rows) {
      const task = await store.getTask(String(row.user_id), String(row.id));
      const workspace = task ? await store.getWorkspace(task.userId, task.workspaceId) : null;
      if (!task?.agentStateCiphertext || !workspace?.wrappedKey) continue;
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      const question = decryptJson<{
        question?: { id?: string; default?: string; answerBy?: string };
      }>(task.agentStateCiphertext, key).question;
      if (!question?.id || !question.default || !question.answerBy) continue;
      if (Date.parse(question.answerBy) > now) continue;
      const user = await store.getUserById(task.userId);
      if (!user) continue;
      try {
        await answerQuestion(context, user, task.id, {
          questionId: question.id,
          prompt: `No answer by ${new Date(question.answerBy).toUTCString()}, so I am taking the default I offered: ${question.default}.`
        });
        answered += 1;
        log.info('question.default_taken', { taskId: task.id });
      } catch (error) {
        // Answered from another device in the meantime is the race going the right way.
        log.warn('question.default_failed', { taskId: task.id, ...errorFields(error) });
      }
    }
    return answered;
  };
};
