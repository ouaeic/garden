import { randomUUID } from 'node:crypto';
import type { EncryptedEnvelope } from '@garden/core';
import type { Database } from '../database.js';
import type { TaskRecord, TaskScheduleRecord } from '../types.js';
import { json, mapTask, mapTaskSchedule, numericOrNull } from './rows.js';
import type { BillingStore } from './billing.js';
import { TASK_EVENT_CHANNEL, TASK_QUEUE_CHANNEL } from './tasks.js';
import type { TaskSignals } from './tasks.js';

/**
 * Schedules: the one thing on this box that starts work while nobody is watching.
 *
 * Everything unattended about that is in `materializeTaskSchedule`, and it is one transaction on
 * purpose. The lease, the spend guard, the task insert and the run row all take the same handle -
 * `spendGuardIn` is `Database`-parameterised for exactly this, so the ceiling a run is authorised
 * under is read on the handle that then commits the work. Give the guard its own connection and it
 * reads a total another connection is still free to change before the insert lands, which on an
 * hourly schedule is a brake that reports the wrong number all night.
 *
 * That is why this file holds the `BillingStore` itself rather than a copy of its statements.
 */
export class ScheduleStore {
  readonly #billing: BillingStore;
  readonly #taskSignals: TaskSignals;

  /**
   * Assigned in the constructor body rather than in field initialisers, for the reason `DataStore`
   * records: `database` is a parameter property, and with `useDefineForClassFields` on under ES2022
   * a field initialiser runs before the constructor body assigns it.
   */
  constructor(
    private readonly database: Database,
    billing: BillingStore,
    taskSignals: TaskSignals
  ) {
    this.#billing = billing;
    this.#taskSignals = taskSignals;
  }

  /**
   * Says that this task has changed, to whoever is watching it and wherever they are.
   *
   * A materialised run is a task arriving, so it wakes the same worker slots and the same open
   * streams that `tasks.ts` wakes, through the same `TaskSignals`.
   */
  #signal(channel: string, payload: string): void {
    this.#taskSignals.signal(channel, payload);
  }

  async createTaskSchedule(input: {
    userId: string;
    workspaceId: string;
    titleCiphertext: EncryptedEnvelope;
    promptCiphertext: EncryptedEnvelope;
    modelId: string;
    privacyRoute: string;
    maxComputeCredits: number;
    maxSpendUsd?: number | null;
    spec: TaskScheduleRecord['spec'];
    nextRunAt: Date;
    maxSchedules?: number;
    /**
     * The inbound trigger, or nothing, which is what every schedule before migration 79 has.
     *
     * The three travel together or not at all - a path with no secret is an unauthenticated URL
     * that starts an agent turn, which is the worst thing this could ship - so the caller passes
     * one object and this statement writes three columns or three nulls.
     */
    trigger?: {
      spec: unknown;
      path: string;
      secretCiphertext: EncryptedEnvelope;
    };
  }): Promise<TaskScheduleRecord> {
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [input.userId]);
      if (input.maxSchedules !== undefined) {
        const count = await tx.query(
          'SELECT COUNT(*) AS count FROM task_schedules WHERE user_id=$1 AND next_run_at IS NOT NULL',
          [input.userId]
        );
        if (Number(count.rows[0]?.count ?? 0) >= input.maxSchedules) {
          throw new Error('schedule_limit');
        }
      }
      const result = await tx.query(
        `INSERT INTO task_schedules(
          id,user_id,workspace_id,title_ciphertext,prompt_ciphertext,model_id,privacy_route,
          max_compute_credits,spec,next_run_at,max_spend_usd,
          trigger,trigger_path,trigger_secret_ciphertext
         ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9::jsonb,$10,$11,
           $12::jsonb,$13,$14::jsonb) RETURNING *`,
        [
          randomUUID(),
          input.userId,
          input.workspaceId,
          JSON.stringify(input.titleCiphertext),
          JSON.stringify(input.promptCiphertext),
          input.modelId,
          input.privacyRoute,
          input.maxComputeCredits,
          JSON.stringify(input.spec),
          input.nextRunAt.toISOString(),
          input.maxSpendUsd ?? null,
          input.trigger ? JSON.stringify(input.trigger.spec) : null,
          input.trigger?.path ?? null,
          input.trigger ? JSON.stringify(input.trigger.secretCiphertext) : null
        ]
      );
      return mapTaskSchedule(result.rows[0]!);
    });
  }

  async countTaskSchedules(userId: string): Promise<number> {
    const result = await this.database.query(
      'SELECT COUNT(*) AS count FROM task_schedules WHERE user_id=$1 AND next_run_at IS NOT NULL',
      [userId]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async listTaskSchedules(userId: string): Promise<TaskScheduleRecord[]> {
    const result = await this.database.query(
      `SELECT s.* FROM task_schedules s JOIN workspaces w ON w.id=s.workspace_id
       WHERE w.user_id=$1 ORDER BY s.created_at DESC`,
      [userId]
    );
    return result.rows.map(mapTaskSchedule);
  }

  async getTaskSchedule(userId: string, id: string): Promise<TaskScheduleRecord | null> {
    const result = await this.database.query(
      `SELECT s.* FROM task_schedules s JOIN workspaces w ON w.id=s.workspace_id
       WHERE s.id=$2 AND w.user_id=$1`,
      [userId, id]
    );
    return result.rows[0] ? mapTaskSchedule(result.rows[0]) : null;
  }

  /**
   * The switch an owner throws, on either side.
   *
   * `consecutive_failures=0` is here because this is the statement a resume goes through, and a
   * schedule that has just been turned back on has to get its full patience back: the streak that
   * paused it is over the moment a person decides to try again. Before the counter existed the
   * streak was read out of `task_schedule_runs`, which this statement does not touch, so the three
   * failures that caused the pause were still the three newest rows and the very next failure
   * re-paused the schedule - measured through the resume route, one failure rather than three.
   *
   * It resets on the pause side too, which costs nothing: a disabled schedule is not dispatched, so
   * the only reader of the counter cannot run until something enables it again.
   */
  async setTaskScheduleEnabled(
    userId: string,
    id: string,
    enabled: boolean,
    nextRunAt: Date | null
  ): Promise<TaskScheduleRecord | null> {
    const result = await this.database.query(
      `UPDATE task_schedules SET enabled=$3,
       next_run_at=CASE WHEN $3 THEN $4 ELSE next_run_at END,lease_owner=NULL,
       lease_expires_at=NULL,last_error_code=NULL,consecutive_failures=0,updated_at=NOW()
       WHERE id=$2 AND EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.id=task_schedules.workspace_id AND w.user_id=$1
       ) RETURNING *`,
      [userId, id, enabled, nextRunAt?.toISOString() ?? null]
    );
    return result.rows[0] ? mapTaskSchedule(result.rows[0]) : null;
  }

  /**
   * Stops a schedule and says why, in one statement.
   *
   * `setTaskScheduleEnabled` above cannot do this: it clears `last_error_code`, because it is the
   * statement a RESUME goes through and clearing is right there. So a dispatcher that wanted to
   * pause a schedule with a reason had to write twice, and the only second write available was
   * `failMaterializedTaskSchedule` - which also stamps the run row `outcome='failed'`.
   *
   * That is a false record when the run has not failed. The overlap pause is exactly that case: the
   * schedule stops because its previous run is STILL GOING, and marking that run failed would put a
   * lie into `task_schedule_runs` about a conversation the owner can still open and watch working.
   * The dispatcher's own comment on the model-unavailable pause asked for this method by name; it
   * is used only where the run is genuinely not the thing that failed, and the model-unavailable
   * path keeps its two writes because there the run did fail and the stamp is true.
   *
   * Does not touch `consecutive_failures`, which belongs to a different streak, and does not touch
   * `next_run_at`, so an owner who resumes gets a fresh occurrence computed by the resume itself.
   */
  async pauseTaskScheduleWithReason(
    userId: string,
    id: string,
    errorCode: string
  ): Promise<TaskScheduleRecord | null> {
    const result = await this.database.query(
      `UPDATE task_schedules SET enabled=FALSE,lease_owner=NULL,lease_expires_at=NULL,
       last_error_code=$3,updated_at=NOW()
       WHERE id=$2 AND EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.id=task_schedules.workspace_id AND w.user_id=$1
       ) RETURNING *`,
      [userId, id, errorCode]
    );
    return result.rows[0] ? mapTaskSchedule(result.rows[0]) : null;
  }

  async updateTaskSchedule(
    userId: string,
    id: string,
    input: {
      titleCiphertext: EncryptedEnvelope;
      promptCiphertext: EncryptedEnvelope;
      spec: TaskScheduleRecord['spec'];
      maxComputeCredits: number;
      maxSpendUsd?: number | null;
      nextRunAt: Date | null;
    }
  ): Promise<TaskScheduleRecord | null> {
    const result = await this.database.query(
      `UPDATE task_schedules SET title_ciphertext=$3::jsonb,prompt_ciphertext=$4::jsonb,
       spec=$5::jsonb,max_compute_credits=$6,next_run_at=$7,max_spend_usd=$8,lease_owner=NULL,
       lease_expires_at=NULL,last_error_code=NULL,updated_at=NOW()
       WHERE id=$2 AND EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.id=task_schedules.workspace_id AND w.user_id=$1
       ) RETURNING *`,
      [
        userId,
        id,
        JSON.stringify(input.titleCiphertext),
        JSON.stringify(input.promptCiphertext),
        JSON.stringify(input.spec),
        input.maxComputeCredits,
        input.nextRunAt?.toISOString() ?? null,
        input.maxSpendUsd ?? null
      ]
    );
    return result.rows[0] ? mapTaskSchedule(result.rows[0]) : null;
  }

  async deleteTaskSchedule(userId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM task_schedules WHERE id=$2 AND EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.id=task_schedules.workspace_id AND w.user_id=$1
       )`,
      [userId, id]
    );
    return result.rowCount === 1;
  }

  async leaseDueTaskSchedule(
    workerId: string,
    leaseSeconds = 120
  ): Promise<TaskScheduleRecord | null> {
    const result = await this.database.query(
      `UPDATE task_schedules SET lease_owner=$1,
       lease_expires_at=NOW()+($2 * INTERVAL '1 second'),updated_at=NOW()
       WHERE id=(
         SELECT id FROM task_schedules
         WHERE enabled=TRUE AND next_run_at IS NOT NULL AND next_run_at<=NOW()
           AND (lease_expires_at IS NULL OR lease_expires_at<NOW())
         ORDER BY next_run_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       ) RETURNING *`,
      [workerId, leaseSeconds]
    );
    return result.rows[0] ? mapTaskSchedule(result.rows[0]) : null;
  }

  /**
   * The trigger columns for the schedules an owner can see, keyed by schedule id.
   *
   * A second query rather than three more fields on `TaskScheduleRecord`, because that record is
   * built by `mapTaskSchedule` in `rows.ts` and consumed by the whole tree; widening it to carry a
   * secret envelope would put trigger material into every reader of every schedule, including the
   * ones that only want a title. Only the two harmless halves come back here. The signing secret is
   * never returned by this method at all - `taskScheduleByTriggerPath` below is the only reader of
   * it, and it is reached by a request that already knows the path.
   *
   * Almost every row has no trigger, so this returns only the rows that do.
   */
  async listTaskScheduleTriggers(
    userId: string
  ): Promise<Map<string, { trigger: unknown; triggerPath: string }>> {
    const result = await this.database.query(
      `SELECT s.id, s.trigger, s.trigger_path FROM task_schedules s
       JOIN workspaces w ON w.id=s.workspace_id
       WHERE w.user_id=$1 AND s.trigger_path IS NOT NULL`,
      [userId]
    );
    return new Map(
      result.rows.map((row) => [
        String(row.id),
        { trigger: json(row.trigger), triggerPath: String(row.trigger_path) }
      ])
    );
  }

  /**
   * The schedule an unauthenticated inbound request names, with the material needed to judge it.
   *
   * This is the only lookup in this file reached by a caller with no session and no token, so it
   * selects on the path alone and hands back everything the verifier needs in one read: the
   * workspace the secret is sealed to, the sealed secret, and the trigger's own bounds. Nothing
   * about the owner's other schedules is reachable from it - the path is 256 bits of randomness
   * with a unique index on it, so naming one is proof of nothing except having been told it, which
   * is why the signature and not the path is what actually authorises the request.
   */
  async taskScheduleByTriggerPath(path: string): Promise<{
    id: string;
    userId: string;
    workspaceId: string;
    enabled: boolean;
    trigger: unknown;
    secretCiphertext: EncryptedEnvelope;
  } | null> {
    const result = await this.database.query(
      `SELECT id,user_id,workspace_id,enabled,trigger,trigger_secret_ciphertext
       FROM task_schedules WHERE trigger_path=$1`,
      [path]
    );
    const row = result.rows[0];
    return row
      ? {
          id: String(row.id),
          userId: String(row.user_id),
          workspaceId: String(row.workspace_id),
          enabled: Boolean(row.enabled),
          trigger: json(row.trigger),
          secretCiphertext: json<EncryptedEnvelope>(row.trigger_secret_ciphertext)
        }
      : null;
  }

  /**
   * Takes one verified inbound delivery and, if the trigger's own bounds allow it, arms the
   * schedule.
   *
   * ONE TRANSACTION, and the row is locked first, because everything that bounds an inbound trigger
   * is a count over rows this statement is about to add to. Two deliveries racing on separate
   * connections would each read the hour's count before the other's insert landed, and the cap that
   * is the whole defence against a retry storm would be the cap plus however many were in flight.
   *
   * The order is refuse, insert, arm. `duplicate` comes from the unique index on
   * `(schedule_id, signature)` rather than from a lookup: a signature covers the timestamp and the
   * exact body, so a replayed request inside the acceptance window produces the same signature, and
   * the index refuses it without anyone having to remember to check. That is also idempotency for a
   * publisher retrying on a timeout, which every real one does.
   *
   * ARMING IS NOT SCHEDULING. It moves `next_run_at` earlier, never later, and never earlier than
   * `minGapMinutes` after the last run: a thousand deliveries inside one gap produce exactly one
   * run, which reads all of them. That is the bound on the owner's money, and it is a bound on
   * MODEL TURNS rather than on requests, which is the only unit that costs anything. It leaves a
   * disabled schedule alone entirely - a paused watcher does not run because something posted to it
   * - and says so rather than pretending, so the sender learns its delivery is being stored and not
   * acted on.
   */
  async recordTriggerDelivery(input: {
    scheduleId: string;
    signature: string;
    bodyCiphertext: EncryptedEnvelope;
    byteSize: number;
    minGapMinutes: number;
    maxPending: number;
    maxPerHour: number;
  }): Promise<{
    outcome: 'accepted' | 'duplicate' | 'too_many_pending' | 'rate_limited' | 'not_armed';
    deliveryId: string | null;
    nextRunAt: string | null;
    /**
     * How many bytes of body are waiting for a run, not counting this request.
     *
     * This is the only reader `task_schedule_deliveries.byte_size` has, and it exists because the
     * count on its own does not answer the question a backed-up publisher asks: sixteen unread
     * deliveries is sixteen bytes or a megabyte, and which one it is decides whether the backlog is
     * a stuck schedule or a workspace filling up. The refusal sentence in `routes/schedules.ts` is
     * where it comes out. It is NOT a bound - nothing here compares it to anything - and the bound
     * on what one sender can store is still `MAX_DELIVERY_BYTES` multiplied by `maxPending`.
     */
    pendingBytes: number;
  }> {
    return this.database.transaction(async (tx) => {
      const locked = await tx.query(
        'SELECT id,enabled FROM task_schedules WHERE id=$1 FOR UPDATE',
        [input.scheduleId]
      );
      const schedule = locked.rows[0];
      if (!schedule)
        return {
          outcome: 'not_armed' as const,
          deliveryId: null,
          nextRunAt: null,
          pendingBytes: 0
        };
      const counts = await tx.query<{ pending: number; recent: number; pending_bytes: number }>(
        `SELECT
           COUNT(*) FILTER (WHERE delivered_at IS NULL) AS pending,
           COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour') AS recent,
           COALESCE(SUM(byte_size) FILTER (WHERE delivered_at IS NULL), 0) AS pending_bytes
         FROM task_schedule_deliveries WHERE schedule_id=$1`,
        [input.scheduleId]
      );
      const pending = Number(counts.rows[0]?.pending ?? 0);
      const recent = Number(counts.rows[0]?.recent ?? 0);
      const pendingBytes = Number(counts.rows[0]?.pending_bytes ?? 0);
      if (recent >= input.maxPerHour)
        return {
          outcome: 'rate_limited' as const,
          deliveryId: null,
          nextRunAt: null,
          pendingBytes
        };
      if (pending >= input.maxPending)
        return {
          outcome: 'too_many_pending' as const,
          deliveryId: null,
          nextRunAt: null,
          pendingBytes
        };
      const deliveryId = randomUUID();
      const inserted = await tx.query(
        `INSERT INTO task_schedule_deliveries(id,schedule_id,signature,body_ciphertext,byte_size)
         VALUES ($1,$2,$3,$4::jsonb,$5)
         ON CONFLICT (schedule_id,signature) DO NOTHING RETURNING id`,
        [
          deliveryId,
          input.scheduleId,
          input.signature,
          JSON.stringify(input.bodyCiphertext),
          input.byteSize
        ]
      );
      if (!inserted.rows[0])
        return { outcome: 'duplicate' as const, deliveryId: null, nextRunAt: null, pendingBytes };
      if (!schedule.enabled)
        return { outcome: 'not_armed' as const, deliveryId, nextRunAt: null, pendingBytes };
      /*
       * `LEAST` against whatever the clock had already planned, so a delivery can only ever bring a
       * run forward. `GREATEST(NOW(), last_run_at + gap)` is the floor: with no previous run the
       * coalesce falls back to an instant far enough in the past that the gap cannot reach NOW(),
       * which makes a first delivery immediate without a second statement to special-case it.
       */
      const armed = await tx.query<{ next_run_at: string }>(
        `UPDATE task_schedules
         SET next_run_at = LEAST(
               COALESCE(next_run_at, 'infinity'::timestamptz),
               GREATEST(
                 NOW(),
                 COALESCE(last_run_at, NOW() - INTERVAL '100 years')
                   + ($2 * INTERVAL '1 minute')
               )
             ),
             updated_at = NOW()
         WHERE id=$1 AND enabled=TRUE RETURNING next_run_at`,
        [input.scheduleId, input.minGapMinutes]
      );
      return {
        outcome: 'accepted' as const,
        deliveryId,
        nextRunAt: armed.rows[0] ? new Date(String(armed.rows[0].next_run_at)).toISOString() : null,
        pendingBytes
      };
    });
  }

  /**
   * The deliveries a run about to start has not seen yet, oldest first.
   *
   * Bounded by `limit` and not by the caller's patience: the pending set is already capped when a
   * delivery is accepted, and this bound is the second half of the same promise - whatever happens
   * to that cap, one run writes a knowable number of files into the owner's workspace.
   *
   * `task_id` is deliberately not in the predicate. A row `materializeTaskSchedule` claimed for a
   * run that then could not reach its workspace is still undelivered, and the next occurrence has
   * to be able to pick it up - so the claim marks which run PROMISED a delivery, and only
   * `delivered_at` marks which run got it. The recovery sweep is the one reader that asks by
   * `task_id`, because it is finishing a promise a specific prompt already made.
   */
  async pendingTriggerDeliveries(
    scheduleId: string,
    limit: number
  ): Promise<Array<{ id: string; bodyCiphertext: EncryptedEnvelope; createdAt: string }>> {
    const result = await this.database.query(
      `SELECT id,body_ciphertext,created_at FROM task_schedule_deliveries
       WHERE schedule_id=$1 AND delivered_at IS NULL ORDER BY created_at, id LIMIT $2`,
      [scheduleId, limit]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      bodyCiphertext: json<EncryptedEnvelope>(row.body_ciphertext),
      createdAt: new Date(String(row.created_at)).toISOString()
    }));
  }

  /**
   * Says which run took these deliveries, so the next poll does not hand them to a second one.
   *
   * Called AFTER the payloads are in the workspace, not before. The other order loses a delivery
   * outright if the write fails, where this one can at worst hand the same payload to two runs -
   * and a duplicate the owner can see beats a disappearance nobody can.
   */
  async markTriggerDeliveriesDelivered(ids: readonly string[], taskId: string): Promise<number> {
    if (!ids.length) return 0;
    const result = await this.database.query(
      `UPDATE task_schedule_deliveries SET delivered_at=NOW(),task_id=$2
       WHERE id = ANY($1::uuid[]) AND delivered_at IS NULL`,
      [[...ids], taskId]
    );
    return result.rowCount ?? 0;
  }

  /**
   * The run this schedule started last, if it has not finished yet.
   *
   * `leaseDueTaskSchedule` above selects on due-ness alone. Nothing in it, and nothing in
   * `materializeTaskSchedule` below, asks whether the previous run of the same schedule is still
   * going - so an interval watcher that takes longer than its own interval starts a second copy of
   * itself, and a third, each holding its own compute reservation and each spending the owner's
   * provider account on the same instruction over the same files. The schedule row reads healthy
   * throughout: `last_run_at` moves, `last_error_code` stays null. The fifteen-minute interval floor
   * is the shortest this software offers and is exactly the setting that invites it.
   *
   * The six statuses are the ones a run can hold while it is still costing something. `draft` is
   * not one, because nothing here creates a draft - a materialised run is inserted
   * `awaiting_resource` and promoted - and the four terminal statuses are not, because a schedule
   * whose last run completed, failed, was cancelled or was paused-to-completion has nothing in
   * flight to collide with. `paused` and `awaiting_user` ARE in flight: a run waiting for an
   * approval card holds its reservation and will resume, and starting a second copy beside it is
   * the multiplication this exists to stop.
   *
   * `idleSeconds` comes back with them because the caller has to tell "still working" from "stuck",
   * and it is measured on `tasks.updated_at` rather than counted in polls. A count of polls is the
   * scheduler's poll interval multiplied by the defer delay, so changing either would silently
   * change how long a schedule waits before it gives up - which is the drift the model-unavailable
   * streak had to move onto a column to escape.
   *
   * Reads through `last_task_id` rather than through `task_schedule_runs`, because `last_task_id`
   * is written in the same transaction that inserts the task and is exactly one row.
   */
  async taskScheduleRunInFlight(
    scheduleId: string
  ): Promise<{ taskId: string; status: string; idleSeconds: number } | null> {
    const result = await this.database.query(
      `SELECT t.id AS task_id, t.status,
       EXTRACT(EPOCH FROM (NOW() - t.updated_at)) AS idle_seconds
       FROM task_schedules s JOIN tasks t ON t.id = s.last_task_id
       WHERE s.id = $1 AND t.status IN
         ('queued','planning','running','awaiting_user','awaiting_resource','paused')`,
      [scheduleId]
    );
    const row = result.rows[0];
    return row
      ? {
          taskId: String(row.task_id),
          status: String(row.status),
          idleSeconds: Math.max(0, Number(row.idle_seconds ?? 0))
        }
      : null;
  }

  async deferTaskSchedule(
    scheduleId: string,
    workerId: string,
    errorCode: string,
    delaySeconds = 300
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE task_schedules SET next_run_at=NOW()+($4 * INTERVAL '1 second'),
       last_error_code=$3,lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW()
       WHERE id=$1 AND lease_owner=$2 AND enabled=TRUE`,
      [scheduleId, workerId, errorCode, delaySeconds]
    );
    return result.rowCount === 1;
  }

  async materializeTaskSchedule(input: {
    scheduleId: string;
    workerId: string;
    taskId: string;
    nextRunAt: Date | null;
    resourceClass: string;
    preparingEventCiphertext: EncryptedEnvelope;
    failureEventCiphertext: EncryptedEnvelope;
    forceFailureCode?: string;
    /**
     * The instruction this one run carries, when it is not exactly the schedule's own.
     *
     * There is one caller: a run started by an inbound delivery has to be told where the delivery
     * is, and the payload itself must never be what tells it - a body from outside interpolated
     * into a prompt is text a stranger wrote arriving in the position the owner writes from, which
     * is the whole shape of a prompt injection. So the dispatcher re-seals the owner's own
     * instruction with a sentence naming the FILES, whose names are ids this box generated, and the
     * bytes stay in the workspace where reading them taints the turn.
     *
     * Omitted is the ordinary case and means the schedule's stored prompt, unchanged.
     */
    promptCiphertext?: EncryptedEnvelope;
    /**
     * The deliveries `promptCiphertext` above names, claimed for this run inside this transaction.
     *
     * The claim is what makes the stranded-run recovery exact. A task is inserted
     * `awaiting_resource` with a prompt already naming
     * `workspace/downloads/inbound/<scheduleId>/<deliveryId>.<ext>`, and the files themselves are
     * written afterwards, outside this transaction, because that write is an HTTP round-trip to a
     * workspace that may be asleep. A restart in that window used to leave the recovery sweep with
     * a task and no way to learn which deliveries its prompt had promised - it re-queued the run
     * with the files missing, and the model was told to read something that was not there. Stamping
     * `task_id` here means the recovery reads exactly the rows this prompt named
     * (`WHERE task_id=$1 AND delivered_at IS NULL`) rather than whatever is pending for the
     * schedule now, which is a superset the moment a new delivery arrives in between.
     *
     * Only on a queued outcome. A run refused by the spend cap never writes anything, so its
     * deliveries stay unclaimed and the next occurrence picks them up.
     *
     * The stamp is not a lock: `pendingTriggerDeliveries` still selects on `delivered_at IS NULL`
     * alone, so a delivery claimed by a run that then failed to reach its workspace is offered to
     * the next occurrence and re-stamped. Losing a delivery is the failure worth avoiding; handing
     * the same one to a second run is the one the owner can see.
     */
    deliveryIds?: readonly string[];
  }): Promise<{
    task: TaskRecord;
    outcome: 'queued' | 'failed';
    errorCode: string | null;
    /**
     * How many runs in a row, ending with this one, have failed for `model_unavailable`. Zero after
     * any other outcome, including a queued run and a failure with a different code.
     *
     * Returned rather than left for the caller to query, because the value the caller needs is the
     * one this transaction just wrote: a separate read afterwards is a second answer to the same
     * question, and on a box with two schedulers it is a read of somebody else's write.
     */
    consecutiveFailures: number;
  } | null> {
    const materialized = await this.database.transaction(async (tx) => {
      const locked = await tx.query(
        `SELECT * FROM task_schedules WHERE id=$1 AND lease_owner=$2
         AND enabled=TRUE AND next_run_at IS NOT NULL AND next_run_at<=NOW() FOR UPDATE`,
        [input.scheduleId, input.workerId]
      );
      const schedule = locked.rows[0];
      if (!schedule) return null;

      let errorCode = input.forceFailureCode ?? null;
      if (!errorCode) {
        // The unattended path is the one that has to fail closed: nobody is watching a 3am run,
        // so a schedule that would take the account past its ceiling never starts at all. The
        // ceiling is the owner's own spend cap, in the currency the provider bills - there is no
        // allowance to check it against, because there is nobody selling one.
        const decision = await this.#billing.spendGuardIn(tx, {
          userId: String(schedule.user_id),
          estimateUsd: numericOrNull(schedule.max_spend_usd) ?? 0,
          includeOpenCommitments: true,
          taskCapUsd: numericOrNull(schedule.max_spend_usd)
        });
        if (decision.outcome === 'deny') errorCode = 'spend_cap_reached';
      }

      const outcome: 'queued' | 'failed' = errorCode ? 'failed' : 'queued';
      const status = errorCode ? 'failed' : 'awaiting_resource';
      const eventKind = errorCode ? 'error' : 'task_created';
      const eventCiphertext = errorCode
        ? input.failureEventCiphertext
        : input.preparingEventCiphertext;
      const taskResult = await tx.query(
        // The run says where it came from in the same statement that creates it. Anything later -
        // a second UPDATE, a join through task_schedule_runs at read time - leaves a window where a
        // run exists without its provenance, and the sidebar reads tasks, not runs.
        `INSERT INTO tasks(
          id,user_id,workspace_id,title,status,model_id,privacy_route,max_compute_credits,
          prompt_ciphertext,security_mode,completed_at,max_spend_usd,schedule_id,lent_keys
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,
           (SELECT security_mode FROM workspaces WHERE id=$3),
           CASE WHEN $5='failed' THEN NOW() ELSE NULL END,$10,$11,
           (SELECT lent_keys FROM workspaces WHERE id=$3)) RETURNING *`,
        [
          input.taskId,
          schedule.user_id,
          schedule.workspace_id,
          JSON.stringify(json(schedule.title_ciphertext)),
          status,
          schedule.model_id,
          schedule.privacy_route,
          schedule.max_compute_credits,
          JSON.stringify(input.promptCiphertext ?? json(schedule.prompt_ciphertext)),
          numericOrNull(schedule.max_spend_usd),
          input.scheduleId
        ]
      );
      if (!errorCode && input.deliveryIds?.length) {
        // Scoped to the schedule as well as to the ids, so a caller that passed an id belonging to
        // somebody else's schedule claims nothing rather than moving their delivery onto this run.
        await tx.query(
          `UPDATE task_schedule_deliveries SET task_id=$2
           WHERE id = ANY($1::uuid[]) AND schedule_id=$3 AND delivered_at IS NULL`,
          [[...input.deliveryIds], input.taskId, input.scheduleId]
        );
      }
      await tx.query(
        `INSERT INTO task_events(id,task_id,sequence,kind,summary,payload_ciphertext)
         VALUES ($1,$2,1,$3,$4,$5::jsonb)`,
        [
          randomUUID(),
          input.taskId,
          eventKind,
          errorCode ? 'Encrypted schedule error event' : 'Encrypted scheduled task event',
          JSON.stringify(eventCiphertext)
        ]
      );
      if (!errorCode) {
        await tx.query(
          `INSERT INTO usage_entries(
            id,user_id,workspace_id,task_id,kind,resource_class,quantity,unit,credits,state,
            idempotency_key
           ) VALUES ($1,$2,$3,$4,'task_compute',$5,$6,'credits',$6,'reserved',$7)`,
          [
            randomUUID(),
            schedule.user_id,
            schedule.workspace_id,
            input.taskId,
            input.resourceClass,
            schedule.max_compute_credits,
            `task:${input.taskId}:reservation`
          ]
        );
      }
      await tx.query(
        `INSERT INTO task_schedule_runs(schedule_id,scheduled_for,task_id,outcome,error_code)
         VALUES ($1,$2,$3,$4,$5)`,
        [input.scheduleId, schedule.next_run_at, input.taskId, outcome, errorCode]
      );
      /*
       * The streak moves in the same statement that records the run, so there is no window in which
       * the ledger and the counter disagree, and it is `RETURNING` rather than read back because a
       * second SELECT on a box running two schedulers reads whichever write landed last.
       *
       * `model_unavailable` is the only code that increments, matching the only code the dispatcher
       * escalates on: a workspace that is starting or being deleted is a state that ends, and
       * `spend_cap_reached` rolls over into the next window on its own. Every other outcome - a
       * queued run included - resets to zero, so the count is a streak ending at this run and not a
       * lifetime total.
       */
      const counted = await tx.query<{ consecutive_failures: number }>(
        `UPDATE task_schedules SET enabled=$3,next_run_at=$4,last_run_at=$5,last_task_id=$6,
         last_error_code=$7,consecutive_failures=CASE WHEN $7='model_unavailable'
           THEN consecutive_failures + 1 ELSE 0 END,
         lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW()
         WHERE id=$1 AND lease_owner=$2 RETURNING consecutive_failures`,
        [
          input.scheduleId,
          input.workerId,
          input.nextRunAt !== null,
          input.nextRunAt?.toISOString() ?? null,
          schedule.next_run_at,
          input.taskId,
          errorCode
        ]
      );
      return {
        task: mapTask(taskResult.rows[0]!),
        outcome,
        errorCode,
        consecutiveFailures: Number(counted.rows[0]?.consecutive_failures ?? 0)
      };
    });
    if (materialized) {
      if (materialized.task.status === 'queued') this.#signal(TASK_QUEUE_CHANNEL, input.taskId);
      this.#signal(TASK_EVENT_CHANNEL, input.taskId);
    }
    return materialized;
  }

  async failMaterializedTaskSchedule(
    scheduleId: string,
    taskId: string,
    errorCode: string
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.query(
        `UPDATE task_schedule_runs SET outcome='failed',error_code=$3
         WHERE schedule_id=$1 AND task_id=$2`,
        [scheduleId, taskId, errorCode]
      );
      await tx.query(
        `UPDATE task_schedules SET last_error_code=$3,updated_at=NOW()
         WHERE id=$1 AND last_task_id=$2`,
        [scheduleId, taskId, errorCode]
      );
    });
  }
}
