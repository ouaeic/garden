import type { Task } from '@garden/contracts';
import { post } from './client.js';

export function createQuestionAnswerSender(
  write: (taskId: string, prompt: string, key: string, questionId: string) => Promise<Task> = (
    taskId,
    prompt,
    key,
    questionId
  ) => post<Task>(`/v1/tasks/${taskId}/answer`, { prompt, questionId }, { idempotencyKey: key })
) {
  let attempt: { signature: string; key: string; pending?: Promise<Task>; result?: Task } | null =
    null;
  return (taskId: string, questionId: string, prompt: string): Promise<Task> => {
    const signature = JSON.stringify([taskId, questionId, prompt]);
    if (attempt?.signature !== signature) {
      if (attempt?.pending)
        return Promise.reject(new Error('Wait for the current answer to finish sending.'));
      attempt = { signature, key: crypto.randomUUID() };
    }
    if (attempt.result) return Promise.resolve(attempt.result);
    if (attempt.pending) return attempt.pending;
    const current = attempt;
    current.pending = write(taskId, prompt, current.key, questionId)
      .then((result) => {
        current.result = result;
        return result;
      })
      .finally(() => {
        delete current.pending;
      });
    return current.pending;
  };
}
