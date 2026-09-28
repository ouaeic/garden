/**
 * Says out loud that a task kept dying, which is the half of the attempt ceiling the queue
 * cannot do.
 *
 * A turn that takes the worker process down with it never reaches `AgentWorker.fail` - there is
 * no process left to write anything - so the only record of six deaths is a number in a column.
 */

import { encryptJson, unwrapDataKey } from '@garden/core';
import type { SupportedContext } from '../http/server-context.js';

export const createAttemptLimitSweep = (context: SupportedContext) => {
  const { log, store, masterKey } = context;
  /**
   * Says out loud that a task kept dying, which is the half of the attempt ceiling the queue itself
   * cannot do.
   *
   * A turn that takes the worker process down with it never reaches `AgentWorker.fail` - there is
   * no process left to write anything - so the only record of six deaths is a number in a column.
   * The ceiling stops the loop; this is what turns it into something the owner can see and act on,
   * in the timeline where every other stop is reported.
   */
  const failTasksAtAttemptLimit = async (): Promise<number> => {
    const exhausted = await store.failTasksAtAttemptLimit();
    for (const task of exhausted) {
      // `attempt` rather than `attempts` because the log field allowlist carries that name, and a
      // field nobody put on the list is dropped rather than printed.
      log.warn('task.attempt_limit_reached', { taskId: task.id, attempt: task.attempt });
      const workspace = await store.getWorkspaceById(task.workspaceId);
      if (!workspace?.wrappedKey) continue;
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      // The sweep is the only thing that ever reads the queue of a task whose worker died without
      // writing a word, so it is also the only thing that can say the message went nowhere. The
      // store has just taken those rows out of the queue, which is what stops the header counting
      // them; without this clause the owner would watch the number fall to zero and be told only
      // that the work failed.
      const undelivered =
        task.undeliveredMessages === 0
          ? ''
          : task.undeliveredMessages === 1
            ? ' The message you sent to it was never started.'
            : ` The ${task.undeliveredMessages} messages you sent to it were never started.`;
      await store.appendTaskEvent({
        taskId: task.id,
        kind: 'error',
        summary: 'Encrypted attempt limit event',
        payloadCiphertext: encryptJson(
          {
            __gardenEventVersion: 1,
            // Same shape as the approval-expiry line above it, deliberately: what happened, what
            // garden did about it, what starts it again. The advice to try "in smaller pieces"
            // was cut - nothing here knows that size was the problem.
            summary: `Started ${task.attempt} times and never finished, so garden has stopped retrying it and its reserved credits are back.${undelivered} Reply here to try again.`,
            // Owner-facing: the work is not there, and nothing else in the timeline says why - the
            // worker died before it could write a word.
            payload: {
              owner: true,
              code: 'task_attempt_limit',
              attempts: task.attempt,
              ...(task.undeliveredMessages > 0 ? { undelivered: task.undeliveredMessages } : {})
            }
          },
          key,
          `task-event:${task.id}`
        )
      });
    }
    return exhausted.length;
  };

  return failTasksAtAttemptLimit;
};
