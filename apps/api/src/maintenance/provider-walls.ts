import { encryptJson, unwrapDataKey, type EncryptedEnvelope } from '@garden/core';
import { agentNotificationAad } from '@garden/data';
import type { SupportedContext } from '../http/server-context.js';
import { errorFields } from '../log.js';
import { taskFailure } from '../task-failure.js';

/**
 * The three ways a provider turns work away, and whether waiting is any use.
 *
 * A quota and an outage come down on the provider's own clock - a rate window closing, a credit
 * month rolling over, a machine coming back - so the only sensible answer is to wait and ask
 * again. A provider that is not connected is not a wall anything will take down: there is no
 * account on this box to ask, so asking it again at any interval is noise, and what actually
 * clears it is the owner saving a key, which wakes the work from the save route itself.
 *
 * The sentence is what reaches the phone, so it says what is stopped and what it depends on
 * rather than naming an error code the owner never chose.
 */
export const providerWalls: Record<string, { clearsOnItsOwn: boolean; notice: string }> = {
  provider_quota_exhausted: {
    clearsOnItsOwn: true,
    notice: 'Your provider has been refusing this work for the last hour: the quota is used up.'
  },
  provider_unavailable: {
    clearsOnItsOwn: true,
    notice: 'Your provider has been unreachable for the last hour, so this work is stopped.'
  },
  provider_not_connected: {
    clearsOnItsOwn: false,
    notice:
      'No model provider is connected, so this work cannot run. Save a key in Settings and it starts again on its own.'
  }
};

/**
 * How long to leave a wall standing before asking again: a minute, then five, fifteen, half an
 * hour, and hourly after that.
 *
 * A blip is over before the owner would have noticed it, and a quota that has lasted an hour will
 * not be talked round by asking every few seconds - each ask is a real request to someone else's
 * server, and the point of an unattended box is to be a good citizen of one. Twenty-four asks
 * spans about a day, which is long enough to sit through a daily quota resetting.
 */
const providerWallRetryMinutes = [1, 5, 15, 30, 60];
const PROVIDER_WALL_MAX_RETRIES = 24;

/**
 * How many refusals stand between the wall going up and the owner's phone.
 *
 * At the intervals above this is the ask made about fifty minutes in, which is the first moment
 * "the provider is refusing" has stopped being a blip and become a fact about the owner's account.
 * Waking someone at two in the morning for something that fixed itself by four past two is the
 * failure this number exists to avoid.
 */
const PROVIDER_WALL_NOTIFY_AFTER_RETRIES = 3;

/**
 * The public label on every line this leaves in a conversation.
 *
 * Event payloads are encrypted, so the summary column is the only part of a work-log line SQL can
 * read - which makes counting these rows the whole of the retry's memory. No separate counter to
 * reconcile after a restart: what has been tried is what is written in the log.
 */
const PROVIDER_WALL_EVENT_SUMMARY = 'Encrypted provider wall event';

/** Kept apart from the count above: a key being saved is the owner acting, not a retry. */
const PROVIDER_RECONNECTED_EVENT_SUMMARY = 'Encrypted provider reconnected event';

type ProviderWaitRow = {
  task_id: string;
  workspace_id: string;
  updated_at: string;
  agent_state_ciphertext: EncryptedEnvelope | null;
};

export const createProviderWallMaintenance = (context: SupportedContext) => {
  const { log, database, store, masterKey } = context;
  // Rotate bounded scans so long analysis waits cannot starve later provider holds.
  let retryCursor: string | null = null;
  /**
   * One line in a conversation's work log about the wall it is behind.
   *
   * A retry is a `status` event with no `owner`, which is what folds it into the collapsed log:
   * twenty-four asks over a day are evidence, not twenty-four things to read. The two lines that
   * are the owner's business - nothing is connected, or garden has stopped asking - say so, and
   * surface.
   */
  const sayWallInLog = async (input: {
    taskId: string;
    key: Uint8Array;
    kind: 'status' | 'warning';
    summary: string;
    code: string;
    owner?: boolean;
  }): Promise<void> => {
    await store.appendTaskEvent({
      taskId: input.taskId,
      kind: input.kind,
      summary: PROVIDER_WALL_EVENT_SUMMARY,
      payloadCiphertext: encryptJson(
        {
          __gardenEventVersion: 1,
          summary: input.summary,
          payload: { ...(input.owner ? { owner: true } : {}), code: input.code }
        },
        input.key,
        `task-event:${input.taskId}`
      )
    });
  };

  /**
   * Tells the owner their computer is stopped at their provider.
   *
   * `takeover_needed` because that is exactly what this is - work halted until a person does
   * something - and it is raised here rather than by the agent for the plain reason that by the
   * time it matters there is no agent left: the turn ended, the worker moved on, and the only
   * thing that still knows the conversation is parked is this sweep. A conversation that has
   * already spent its allowance of notifications is not a reason to abandon the pass.
   */
  const tellOwnerAboutWall = async (input: {
    userId: string;
    taskId: string;
    key: Uint8Array;
    notice: string;
  }): Promise<void> => {
    await store
      .createAgentNotification({
        userId: input.userId,
        taskId: input.taskId,
        kind: 'takeover_needed',
        messageCiphertext: encryptJson(
          { message: input.notice },
          input.key,
          agentNotificationAad(input.taskId)
        )
      })
      .catch((error: unknown) => {
        log.warn('provider_wall.notify_failed', { taskId: input.taskId, ...errorFields(error) });
      });
  };

  const providerWallCode = async (
    taskId: string,
    key: Uint8Array,
    stateCiphertext: EncryptedEnvelope | null
  ): Promise<string | null> => {
    return (await taskFailure(store, taskId, key, stateCiphertext))?.code ?? null;
  };

  const retryProviderWalls = async (): Promise<number> => {
    const parked = await database.query<ProviderWaitRow & { user_id: string; retries: string }>(
      // A scheduled task that has never been leased needs workspace dispatch, not provider recovery.
      `SELECT t.id AS task_id, t.user_id, t.workspace_id, t.updated_at::text AS updated_at, t.agent_state_ciphertext,
         (SELECT COUNT(*) FROM task_events e
           WHERE e.task_id = t.id AND e.summary = $1
             AND e.created_at > NOW() - INTERVAL '24 hours') AS retries
       FROM tasks t
       WHERE t.status = 'awaiting_resource' AND t.attempt > 0 AND t.lease_owner IS NULL
         AND ($2::uuid IS NULL OR t.id>$2::uuid)
       ORDER BY t.id
       LIMIT 20`,
      [PROVIDER_WALL_EVENT_SUMMARY, retryCursor]
    );
    retryCursor = parked.rows.length === 20 ? parked.rows.at(-1)!.task_id : null;
    let retried = 0;
    for (const row of parked.rows) {
      const taskId = String(row.task_id);
      const userId = String(row.user_id);
      const workspace = await store.getWorkspaceById(String(row.workspace_id));
      if (!workspace?.wrappedKey || workspace.userId !== userId) continue;
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      const code = await providerWallCode(taskId, key, row.agent_state_ciphertext);
      if (!code) continue;
      const wall = providerWalls[code];
      if (!wall) continue;
      const retries = Number(row.retries);
      if (!wall.clearsOnItsOwn) {
        // Nothing here will change by being asked again, so this is said once and then not again
        // for a day - which is as often as a box with nothing connected is worth mentioning.
        if (retries > 0) continue;
        await sayWallInLog({
          taskId,
          key,
          kind: 'warning',
          code,
          summary: wall.notice,
          owner: true
        });
        await tellOwnerAboutWall({ userId, taskId, key, notice: wall.notice });
        log.info('provider_wall.owner_needed', { taskId, code });
        continue;
      }
      if (retries > PROVIDER_WALL_MAX_RETRIES) continue;
      if (retries === PROVIDER_WALL_MAX_RETRIES) {
        await sayWallInLog({
          taskId,
          key,
          kind: 'warning',
          code,
          owner: true,
          summary: `Asked your provider ${PROVIDER_WALL_MAX_RETRIES} times over the last day and it is still refusing, so garden has stopped asking. Reply here to try again.`
        });
        log.warn('provider_wall.gave_up', { taskId, code });
        continue;
      }
      const waitMs =
        60_000 *
        (providerWallRetryMinutes[Math.min(retries, providerWallRetryMinutes.length - 1)] ?? 60);
      if (Date.now() - new Date(String(row.updated_at)).getTime() < waitMs) continue;
      const resumed = await store.resumeTaskFromResourceWait({
        userId,
        taskId,
        expectedUpdatedAt: row.updated_at,
        expectedStateCiphertext: row.agent_state_ciphertext,
        eventSummary: PROVIDER_WALL_EVENT_SUMMARY,
        eventCiphertext: encryptJson(
          {
            __gardenEventVersion: 1,
            summary: `Asking your provider again after it refused this work: attempt ${retries + 1} of ${PROVIDER_WALL_MAX_RETRIES}.`,
            payload: { code }
          },
          key,
          `task-event:${taskId}`
        )
      });
      if (!resumed) continue;
      if (retries === PROVIDER_WALL_NOTIFY_AFTER_RETRIES)
        await tellOwnerAboutWall({ userId, taskId, key, notice: wall.notice });
      log.info('provider_wall.retried', { taskId, code, attempt: retries + 1 });
      retried += 1;
    }
    return retried;
  };

  /** Saving credentials retries provider holds, while preserving waits for other work. */
  const resumeTasksWaitingOnAProvider = async (userId: string): Promise<number> => {
    let resumed = 0;
    let cursor: string | null = null;
    for (;;) {
      const parked: { rows: ProviderWaitRow[] } = await database.query<ProviderWaitRow>(
        `SELECT id AS task_id, workspace_id, updated_at::text AS updated_at, agent_state_ciphertext
       FROM tasks
       WHERE user_id = $1 AND status = 'awaiting_resource' AND attempt > 0 AND lease_owner IS NULL
         AND ($2::uuid IS NULL OR id>$2::uuid)
       ORDER BY id LIMIT 50`,
        [userId, cursor]
      );
      for (const row of parked.rows) {
        const taskId = String(row.task_id);
        const workspace = await store.getWorkspaceById(String(row.workspace_id));
        if (!workspace?.wrappedKey || workspace.userId !== userId) continue;
        const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
        const code = await providerWallCode(taskId, key, row.agent_state_ciphertext);
        if (!code || !providerWalls[code]) continue;
        if (
          await store.resumeTaskFromResourceWait({
            userId,
            taskId,
            expectedUpdatedAt: row.updated_at,
            expectedStateCiphertext: row.agent_state_ciphertext,
            eventSummary: PROVIDER_RECONNECTED_EVENT_SUMMARY,
            eventCiphertext: encryptJson(
              {
                __gardenEventVersion: 1,
                summary: 'A provider key was saved, so this work is going again.',
                payload: { code: 'provider_reconnected' }
              },
              key,
              `task-event:${taskId}`
            )
          })
        )
          resumed += 1;
      }
      if (parked.rows.length < 50) break;
      cursor = parked.rows.at(-1)!.task_id;
    }
    if (resumed) log.info('provider_wall.resumed_on_connect', { userId, count: resumed });
    return resumed;
  };

  return { retryProviderWalls, resumeTasksWaitingOnAProvider };
};
