import { CONVERSATION_NAME_INDEX_STAMP } from '@garden/core';
import type { ConversationNameIndex, EncryptedEnvelope } from '@garden/core';
import type { Database } from '../database.js';
import type { TaskRecord } from '../types.js';
import { encryptedText, json, mapTask } from './rows.js';
import { taskNameTokens, taskNameTsv } from './sql/tasks.js';
import { NOTIFICATION_LEDGER_INTERVAL } from './notifications.js';
import { MAX_TASK_PAGE } from './tasks.js';

/**
 * How long the money is kept. Written into the statement rather than bound because it is one fact
 * in one place and both statements that use it must use the same one.
 *
 * Longer than the longest window anything measures spend over by an order of magnitude: the caps
 * roll over daily and monthly, the chart runs a month back, and the alert ledger's key is a window
 * occurrence. Four hundred days leaves a full year of history readable and a fortnight of margin on
 * top, so the first thing this sweep can remove is a figure nothing on the box has consulted since
 * the same date last year.
 */
const SPEND_RETENTION_INTERVAL = `INTERVAL '400 days'`;

/**
 * The passes nobody asks for: the backfills that carry rows an older garden wrote up to the shape
 * this one reads, the nightly sweep that bounds every table that would otherwise grow for ever, and
 * the account export that reads all of them at once.
 *
 * They are one file because they share one property no other domain has: each is allowed to find
 * nothing to do, and every one of them is written to be safe to run twice. Nothing here is on the
 * path of a turn.
 */
export class MaintenanceStore {
  constructor(private readonly database: Database) {}

  /**
   * One batch of tasks still carrying a plaintext title. The API re-encrypts these while booting,
   * so the batch stays small: startup then costs a bounded index lookup instead of a scan whose
   * length grows with the task history, and any remainder is picked up on the next boot.
   */
  async listLegacyTaskTitles(limit = 500): Promise<TaskRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM tasks WHERE title NOT LIKE '{"v":%' ORDER BY created_at, id LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapTask).filter((task) => task.legacyTitle !== null);
  }

  async setTaskTitleCiphertext(
    id: string,
    titleCiphertext: EncryptedEnvelope,
    nameIndex: ConversationNameIndex
  ): Promise<void> {
    await this.database.query(
      `UPDATE tasks SET title=$2,updated_at=NOW(), name_tsv = ${taskNameTsv(3, 4, 5)} WHERE id=$1`,
      [id, JSON.stringify(titleCiphertext), ...taskNameTokens(nameIndex)]
    );
  }

  /**
   * One batch of conversations whose name is not indexed the way this build indexes names -
   * everything that existed before `name_tsv` did, anything a half-finished backfill did not reach,
   * and everything sealed by an earlier shape of the vector. The API drains this on the boot after
   * the update for the same reason it drains the legacy titles: the tokens are keyed, so only a
   * process holding the workspace key can produce them.
   *
   * The shape is asked about by the stamp every write puts in the vector rather than by looking for
   * the tokens themselves, because a name of one short word indexes to no prefixes and would then
   * be re-read on every boot for the life of the box.
   *
   * Oldest first, because the old end of the history is precisely the part a bounded decrypt window
   * could never see and the part this exists to recover.
   *
   * Four columns and not the row: a task carries its agent state, which is the entire conversation
   * it has had, and five hundred of those at once is a boot that runs the box out of memory to
   * write five hundred short vectors.
   */
  async listTasksMissingNameIndex(
    limit = 500
  ): Promise<
    Pick<
      TaskRecord,
      'id' | 'workspaceId' | 'titleCiphertext' | 'legacyTitle' | 'promptCiphertext'
    >[]
  > {
    const result = await this.database.query(
      // The stamp is written into the statement rather than bound, which is what keeps
      // `tasks_unindexed_name_idx` reachable under any plan the server decides to make.
      //
      // A partial index is only usable if the planner can prove the statement's predicate is
      // covered by the index's, and this predicate carries a constant. Bound as `$2` that proof
      // depends on the plan being a *custom* one, built with the parameter's value in hand.
      // Measured on 20,000 conversations, both arms, same index:
      //
      //   bound, custom plan          Index Scan using tasks_unindexed_name_idx
      //   bound, generic plan         Seq Scan + Sort (created_at, id)   <- the defect, restored
      //   interpolated, either        Index Scan using tasks_unindexed_name_idx
      //
      // Today the box gets custom plans for free, because node-postgres sends unnamed statements
      // and Postgres re-plans those every time. That is a property of the driver and not of this
      // statement, and the day anything names a prepared statement here the fifth execution
      // silently goes back to reading the whole table. Interpolating costs nothing and does not
      // depend on it - and it is what `taskNameTsv` already does with this same value: it comes
      // from `@garden/core`, it is a fixed hash over a fixed alphabet, and no caller supplies it.
      `SELECT id, workspace_id, title, prompt_ciphertext FROM tasks
       WHERE name_tsv IS NULL OR NOT (name_tsv @@ '${CONVERSATION_NAME_INDEX_STAMP}'::tsquery)
       ORDER BY created_at, id LIMIT $1`,
      [Math.max(1, Math.min(Math.trunc(limit), MAX_TASK_PAGE))]
    );
    return result.rows.map((row) => {
      const title = encryptedText(row.title);
      return {
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        titleCiphertext: title.ciphertext,
        legacyTitle: title.legacy,
        promptCiphertext: json<EncryptedEnvelope>(row.prompt_ciphertext)
      };
    });
  }

  /** Writes the search vector without touching the name it was built from, or `updated_at`. */
  async setTaskNameIndex(id: string, nameIndex: ConversationNameIndex): Promise<void> {
    await this.database.query(`UPDATE tasks SET name_tsv = ${taskNameTsv(2, 3, 4)} WHERE id=$1`, [
      id,
      ...taskNameTokens(nameIndex)
    ]);
  }

  /**
   * Replaces summaries and action names written before they were redacted. Also a boot-path
   * backfill, so it rewrites at most `batchSize * maxBatches` rows per call and reports whether
   * anything is left; the caller decides whether to keep draining or wait for the next boot.
   */
  async scrubLegacyContentSummaries(batchSize = 500, maxBatches = 20): Promise<boolean> {
    const events = await this.rewriteInBatches(
      `UPDATE task_events SET summary='Encrypted legacy event'
       WHERE id IN (
         SELECT id FROM task_events WHERE summary NOT LIKE 'Encrypted % event' LIMIT $1
       )`,
      batchSize,
      maxBatches
    );
    const approvals = await this.rewriteInBatches(
      `UPDATE approvals SET action='legacy_approval'
       WHERE id IN (
         SELECT id FROM approvals
         WHERE action NOT IN ('shell','browser_action','secure_input_handoff','legacy_approval')
         LIMIT $1
       )`,
      batchSize,
      maxBatches
    );
    return events || approvals;
  }

  /** Runs a `LIMIT $1` rewrite until it stops filling batches. True means rows may remain. */
  private async rewriteInBatches(
    sql: string,
    batchSize: number,
    maxBatches: number
  ): Promise<boolean> {
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const result = await this.database.query(sql, [batchSize]);
      if (result.rowCount < batchSize) return false;
    }
    return true;
  }

  async exportAccount(userId: string): Promise<Record<string, unknown>> {
    const [
      user,
      workspaces,
      tasks,
      taskPlans,
      schedules,
      previews,
      apiTokens,
      usage,
      providers,
      connectors,
      connectorAudit,
      approvals,
      security
    ] = await Promise.all([
      this.database.query('SELECT id,username,display_name,created_at FROM users WHERE id=$1', [
        userId
      ]),
      this.database.query(
        `SELECT w.id,w.name,w.status,w.storage_bytes,w.storage_limit_bytes,
        w.image_revision,w.region,k.wrapping_mode AS key_protection,w.created_at,w.updated_at
        FROM workspaces w JOIN workspace_keys k ON k.workspace_id=w.id
        WHERE w.user_id=$1 ORDER BY w.created_at`,
        [userId]
      ),
      this.database.query(
        'SELECT id,workspace_id,title AS title_ciphertext,status,model_id,privacy_route,max_compute_credits,actual_compute_credits,created_at,updated_at,completed_at FROM tasks WHERE user_id=$1 ORDER BY created_at',
        [userId]
      ),
      this.database.query(
        `SELECT p.id,p.task_id,p.version,p.parent_version,p.branch_name,p.created_by,p.created_at
        FROM task_plans p JOIN tasks t ON t.id=p.task_id
        WHERE t.user_id=$1 ORDER BY p.task_id,p.version`,
        [userId]
      ),
      this.database.query(
        'SELECT id,workspace_id,model_id,privacy_route,max_compute_credits,spec,enabled,next_run_at,last_run_at,last_task_id,last_error_code,created_at,updated_at FROM task_schedules WHERE user_id=$1 ORDER BY created_at',
        [userId]
      ),
      this.database.query(
        'SELECT id,workspace_id,label,port,visibility,status,expires_at,last_accessed_at,created_at,updated_at FROM workspace_previews WHERE user_id=$1 ORDER BY created_at',
        [userId]
      ),
      this.database.query(
        'SELECT id,label,token_prefix,scopes,last_used_at,expires_at,created_at,revoked_at FROM api_tokens WHERE user_id=$1 ORDER BY created_at',
        [userId]
      ),
      this.database.query(
        'SELECT workspace_id,task_id,kind,resource_class,quantity,unit,credits,state,created_at FROM usage_entries WHERE user_id=$1 ORDER BY created_at',
        [userId]
      ),
      // The connection itself, never its secret: this file is downloaded to a laptop, and the key
      // it names is the one that pays the provider.
      this.database.query(
        'SELECT provider,status,external_ref,monthly_limit_usd,created_at,updated_at FROM managed_provider_credentials WHERE user_id=$1 ORDER BY created_at',
        [userId]
      ),
      this.database.query(
        'SELECT id,kind,auth_mode,label,base_url,scopes,enabled,last_used_at,created_at,updated_at FROM connectors WHERE user_id=$1 ORDER BY created_at',
        [userId]
      ),
      this.database.query(
        'SELECT connector_id,task_id,operation,outcome,status_code,request_bytes,response_bytes,duration_ms,created_at FROM connector_audit_events WHERE user_id=$1 ORDER BY created_at',
        [userId]
      ),
      this.database.query(
        'SELECT task_id,action,origin,side_effect,status,expires_at,created_at,resolved_at FROM approvals WHERE user_id=$1 ORDER BY created_at',
        [userId]
      ),
      this.database.query(
        'SELECT kind,outcome,metadata,created_at FROM security_events WHERE user_id=$1 ORDER BY created_at',
        [userId]
      )
    ]);
    return {
      schemaVersion: 12,
      exportedAt: new Date().toISOString(),
      user: user.rows[0] ?? null,
      workspaces: workspaces.rows,
      tasks: tasks.rows,
      taskPlans: taskPlans.rows,
      schedules: schedules.rows,
      previews: previews.rows,
      apiTokens: apiTokens.rows,
      usage: usage.rows,
      providers: providers.rows,
      connectors: connectors.rows,
      connectorAudit: connectorAudit.rows,
      approvals: approvals.rows,
      securityEvents: security.rows
    };
  }

  async cleanupExpired(securityEventRetentionDays = 30, deltaPruneLimit = 10_000): Promise<void> {
    await this.database.query('DELETE FROM auth_challenges WHERE expires_at <= NOW()');
    await this.database.query('DELETE FROM native_authorizations WHERE expires_at <= NOW()');
    await this.database.query('DELETE FROM sessions WHERE expires_at <= NOW()');
    await this.database.query(
      "DELETE FROM device_enrollments WHERE created_at < NOW() - INTERVAL '7 days'"
    );
    await this.database.query(
      `DELETE FROM api_tokens
       WHERE expires_at < NOW() - INTERVAL '30 days'
          OR (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '30 days')`
    );
    // Unresolved effects need reconciliation; expiry must not authorize another attempt.
    await this.database.query(
      "DELETE FROM api_operations WHERE expires_at <= NOW() AND state='completed'"
    );
    await this.database.query('DELETE FROM connector_oauth_attempts WHERE expires_at <= NOW()');
    await this.database.query(
      "DELETE FROM security_events WHERE created_at < NOW() - ($1 * INTERVAL '1 day')",
      [securityEventRetentionDays]
    );
    // The other half of the same record, kept for the same length of time: a security event is who
    // signed in, and this is what the box then went and did to somebody else's server on the
    // owner's behalf. Two horizons for one question would only mean the export answered it twice
    // and disagreed with itself.
    await this.database.query(
      "DELETE FROM connector_audit_events WHERE created_at < NOW() - ($1 * INTERVAL '1 day')",
      [securityEventRetentionDays]
    );
    await this.database.query(
      `UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at <= NOW()`
    );
    await this.database.query(
      `DELETE FROM workspace_previews
       WHERE expires_at < NOW() - INTERVAL '30 days'
          OR (status='revoked' AND updated_at < NOW() - INTERVAL '30 days')`
    );
    // A closed share link on the same terms as a closed preview: the row stays a month so the
    // owner's list can say what became of it, then goes. An expired link keeps its bytes for that
    // month too - the owner may re-open the conversation and want to see what it carried - but
    // nothing serves them, because the public lookup refuses an expired row in its own statement.
    await this.database.query(
      `DELETE FROM task_shares
       WHERE expires_at < NOW() - INTERVAL '30 days'
          OR (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '30 days')`
    );
    // One row per notification per device, and nothing ever removed them. They exist to stop a
    // message being sent twice, so they are only needed while the thing they settled is still
    // something `listPendingNotifications` would consider.
    await this.database.query(
      'DELETE FROM notification_deliveries WHERE delivered_at < NOW() - $1::interval',
      [NOTIFICATION_LEDGER_INTERVAL]
    );
    // The destination ledger, on the same horizon and for the same reason. An approval card whose
    // outcome was never written back is past caring by then too: the approval itself lapsed within
    // a day of being raised.
    await this.database.query(
      'DELETE FROM notification_destination_deliveries WHERE delivered_at < NOW() - $1::interval',
      [NOTIFICATION_LEDGER_INTERVAL]
    );
    // A pairing secret nobody presented inside its window. The hash is useless once the window
    // has closed - the completing UPDATE refuses it - so clearing it only makes the row say so.
    await this.database.query(
      `UPDATE notification_destinations SET pairing_hash=NULL, pairing_expires_at=NULL
       WHERE pairing_hash IS NOT NULL AND pairing_expires_at <= NOW()`
    );
    // Streaming writes an assistant_delta several times a second, each an encrypted row of its own.
    // The assistant_message that closes the turn holds the final text, which makes every delta
    // before it redundant - but only once the task has stopped, because a live task is still
    // streaming into its own timeline. The writer already drops them as the closing message lands;
    // this catches the turns that ended without one, and the rows written before it did.
    await this.database.query(
      `DELETE FROM task_events WHERE id IN (
         SELECT delta.id FROM task_events delta
         JOIN tasks t ON t.id=delta.task_id
         WHERE delta.kind='assistant_delta'
           AND t.status IN ('completed','failed','cancelled')
           AND EXISTS (
             SELECT 1 FROM task_events final
             WHERE final.task_id=delta.task_id AND final.kind='assistant_message'
               AND final.sequence>delta.sequence
           )
         LIMIT $1
       )`,
      [deltaPruneLimit]
    );
    // Memories that expired long ago are never assembled into context again. The grace period
    // leaves room to notice and undo a wrong expiry date before the row is actually gone.
    await this.database.query(
      `DELETE FROM workspace_memories
       WHERE valid_until IS NOT NULL AND valid_until < NOW() - INTERVAL '90 days'`
    );
    // A run every fifteen minutes is a row every fifteen minutes, forever. They stop a due slot
    // being materialised twice, which is decided within one schedule lease, and they keep a
    // finished run from being pushed as though the owner had started it - that one lasts as long as
    // the run is still something `listPendingNotifications` would consider, so the horizon is the
    // ledger's rather than the candidate window's. The conversation each row produced is untouched;
    // the sidebar groups those by `tasks.schedule_id`, which never needed this table.
    await this.database.query(
      'DELETE FROM task_schedule_runs WHERE created_at < NOW() - $1::interval',
      [NOTIFICATION_LEDGER_INTERVAL]
    );
    // What the agent chose to tell the owner, which is theirs and is read long after the push that
    // carried it. Kept far past the fortnight in which it could still be sent, so this only ever
    // reaches a notification nobody has opened in a season. It also gives a conversation still
    // alive at that age its notification allowance back, which is the right answer: the cap is
    // there to stop one turn shouting, not to ration a watcher across a year.
    await this.database.query(
      "DELETE FROM agent_notifications WHERE created_at < NOW() - INTERVAL '90 days'"
    );
    // A crossing of a threshold in a window that closed more than a year ago. The row's only live
    // job is its own primary key - it is how `claimSpendAlert` learns it has already said this
    // about this day - and a window occurrence that old cannot recur. `listSpendAlerts` reads the
    // newest fifty, so nothing else notices.
    await this.database.query(
      `DELETE FROM spend_alerts WHERE created_at < NOW() - ${SPEND_RETENTION_INTERVAL}`
    );
    /*
     * The ledger, and the narrowest safe cut of it.
     *
     * `usage_entries` takes a row per model call, per media generation and per reservation, carries
     * five indexes, and nothing has ever removed one. `exportAccount` dumps the whole table.
     *
     * The horizon alone is not the whole answer, because the audit's premise - "every spend query
     * is correctly windowed so nothing breaks" - is false, and it is worth being exact about where.
     * Three reads sum this table with no window at all, all of them per task: `taskSpend`, the
     * `spent_usd` in TASK_LIVE_COUNTS that every conversation carries into the sidebar, and the
     * `COALESCE(max_spend_usd, SUM(...))` that re-baselines a follow-up's ceiling when the owner
     * says "spend $2 more". Pruning a settled row that still belongs to a conversation would make
     * the first two under-report a live figure and the third RAISE a spend ceiling - a retention
     * sweep that quietly loosens a brake, which is the last thing this table should do.
     *
     * So the cut is: settled work whose conversation is already gone. `task_id` is ON DELETE SET
     * NULL, so a null there means the conversation was deleted (or the charge was never task-scoped
     * - a media job outside a task, an account-level entry), and no per-task sum can reach it. The
     * windowed reads - `spendTotal`, `spendByDay`, `spendByModel`, `spendByTask`, `spendGuard` -
     * all work in the owner's day or month, so a year-and-a-bit horizon is far outside every one.
     *
     * `reserved` rows are left alone on purpose. An open reservation is a claim on the monthly
     * allowance, and deleting one is releasing it - which is a decision about orphaned commitments
     * (there is a real one: a dispatch failure can strand a reservation on a failed task for the
     * life of the box) and not about retention. That belongs to whoever fixes the stranding, with a
     * sweep that says so.
     *
     * No monthly roll-up. `data-layer` F17 proposed one and the triage's own kill list already
     * refuses it - "rolling settled usage into a daily aggregate" is a killed design - so the
     * retention half ships and the aggregate does not.
     */
    await this.database.query(
      `DELETE FROM usage_entries
       WHERE created_at < NOW() - ${SPEND_RETENTION_INTERVAL}
         AND task_id IS NULL AND state <> 'reserved'`
    );
  }
}
