import type { OwnerKey, PlantDealRequest, PlantDealResponse, Task } from '@garden/contracts';
import { ApiError, patch, post, put } from '../client';
import { stepUp } from '../auth';
import { putTask, refreshSoon } from './store';

/**
 * Everything the owner can do from a card, each one followed by a fresh read of the desk.
 *
 * A route that wants a second factor says so with a code rather than a status, and the action is
 * repeated once after the owner gives it; that is the whole of the step-up handling here.
 */
const STEP_UP = new Set(['step_up_required', 'recent_authentication_required']);

async function sensitive<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ApiError) || !STEP_UP.has(error.code)) throw error;
    await stepUp();
    return run();
  }
}

const settle = async <T>(work: Promise<T>): Promise<T> => {
  const value = await work;
  refreshSoon();
  return value;
};

export const answer = (taskId: string, questionId: string, prompt: string) =>
  settle(post<Task>(`/v1/tasks/${taskId}/answer`, { questionId, prompt }));

export const approve = (approvalId: string, scope: 'once' | 'run' = 'once') =>
  settle(sensitive(() => post(`/v1/approvals/${approvalId}/approve`, { scope })));

export const deny = (approvalId: string, note?: string) =>
  settle(sensitive(() => post(`/v1/approvals/${approvalId}/deny`, note ? { note } : {})));

export const plantDeal = (taskId: string, body: PlantDealRequest) =>
  settle(post<PlantDealResponse>(`/v1/tasks/${taskId}/deal`, body));

export const taskAction = async (taskId: string, action: 'pause' | 'resume' | 'cancel') => {
  const task = await post<Task>(`/v1/tasks/${taskId}/${action}`);
  putTask(task);
  refreshSoon();
  return task;
};

/** Lifts a run's own ceiling and starts it again: the one thing that changes a spend pause. */
export const raiseCapAndResume = async (taskId: string, maxSpendUsd: number) => {
  putTask(await post<Task>(`/v1/tasks/${taskId}/spend-ceiling`, { maxSpendUsd }));
  return taskAction(taskId, 'resume');
};

/** The keys one goal holds beyond acting as the owner. */
export const setGoalKeys = (taskId: string, lentKeys: OwnerKey[]) =>
  settle(
    patch<Task>(`/v1/tasks/${taskId}/keys`, { lentKeys }).then((task) => (putTask(task), task))
  );

export const setTaskKeys = (taskId: string, actAsYou: boolean) =>
  settle(
    patch<Task>(`/v1/tasks/${taskId}/security-mode`, {
      securityMode: actAsYou ? 'autonomous' : 'balanced'
    }).then((task) => (putTask(task), task))
  );

/** Accepting a goal files it away: it leaves the desk and stays in search and the record. */
export const accept = (taskId: string, archived = true) =>
  settle(patch<Task>(`/v1/tasks/${taskId}`, { archived }).then((task) => (putTask(task), task)));

export const markLooked = (at = new Date().toISOString()) =>
  put('/v1/account/preferences', { lastLookAt: at }).catch(() => undefined);
