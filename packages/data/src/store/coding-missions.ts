import { createHash, randomUUID } from 'node:crypto';
import { AthanorError, type EncryptedEnvelope } from '@athanor/core';
import type { Database } from '../database.js';
import { type TaskStore, type TaskSignals, TASK_QUEUE_CHANNEL } from './tasks.js';
import type { WorkspaceStore } from './workspaces.js';
import { iso, json, optionalText } from './rows.js';
import { BillingStore } from './billing.js';

export interface CodingMissionRecord {
  id: string;
  userId: string;
  parentTaskId: string;
  parentWorkspaceId: string;
  childTaskId: string;
  childWorkspaceId: string;
  requestKey: string;
  requestHash: string;
  manifestCiphertext: EncryptedEnvelope;
  detailCiphertext: EncryptedEnvelope | null;
  phase:
    | 'preparing'
    | 'active'
    | 'conflicted'
    | 'integrating'
    | 'integrated'
    | 'cancelled'
    | 'failed';
  childStatus: string;
  parentStatus: string;
  generation: number;
  runnerGeneration: number;
  runnerSealed: boolean;
  spentUsd: number;
  reservedUsd: number;
  allocatedCredits: number;
  usedCredits: number;
  reservedCredits: number;
  pendingApprovals: number;
  reviewDigest: string | null;
  changedFiles: number | null;
  conflicts: number | null;
  createdAt: string;
  updatedAt: string;
}
const map = (r: Record<string, unknown>): CodingMissionRecord => ({
  id: String(r.id),
  userId: String(r.user_id),
  parentTaskId: String(r.parent_task_id),
  parentWorkspaceId: String(r.parent_workspace_id),
  childTaskId: String(r.child_task_id),
  childWorkspaceId: String(r.child_workspace_id),
  requestKey: String(r.request_key),
  requestHash: String(r.request_hash),
  manifestCiphertext: json(r.manifest_ciphertext),
  detailCiphertext: r.detail_ciphertext ? json(r.detail_ciphertext) : null,
  phase: String(r.phase) as CodingMissionRecord['phase'],
  childStatus: String(r.child_status),
  parentStatus: String(r.parent_status),
  generation: Number(r.generation),
  runnerGeneration: Number(r.runner_generation ?? 0),
  runnerSealed: r.runner_sealed === true,
  spentUsd: Number(r.spent_usd ?? 0),
  reservedUsd: Number(r.reserved_usd ?? 0),
  allocatedCredits: Number(r.allocated_credits),
  usedCredits: Number(r.used_credits ?? 0),
  reservedCredits: Number(r.reserved_credits ?? 0),
  pendingApprovals: Number(r.pending_approvals ?? 0),
  reviewDigest: optionalText(r.review_digest),
  changedFiles: r.changed_files === null ? null : Number(r.changed_files),
  conflicts: r.conflicts === null ? null : Number(r.conflicts),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at)
});
const SELECT_MISSIONS = `SELECT m.*,COALESCE(m.parent_workspace_id,p.workspace_id) AS parent_workspace_id,t.status AS child_status,p.status AS parent_status,
  GREATEST(m.updated_at,t.updated_at) AS updated_at,
  COALESCE((SELECT SUM(c.actual_usd) FROM coding_family_calls c WHERE c.task_id=m.child_task_id),0) AS spent_usd,
  COALESCE((SELECT SUM(c.reserved_usd) FROM coding_family_calls c WHERE c.task_id=m.child_task_id AND c.actual_usd IS NULL),0) AS reserved_usd,
  COALESCE((SELECT SUM(c.actual_credits) FROM coding_family_calls c WHERE c.task_id=m.child_task_id),0) AS used_credits,
  COALESCE((SELECT SUM(c.reserved_credits) FROM coding_family_calls c WHERE c.task_id=m.child_task_id AND c.actual_credits IS NULL),0) AS reserved_credits,
  (SELECT COUNT(*) FROM approvals a WHERE a.task_id=m.child_task_id AND a.status='pending' AND a.expires_at>NOW()) AS pending_approvals
  FROM coding_missions m JOIN tasks t ON t.id=m.child_task_id JOIN tasks p ON p.id=m.parent_task_id`;
const ACTIVE_CHILD = "('queued','planning','running','awaiting_user','awaiting_resource','paused')";

/** Allocate before a child exists; the parent row serializes allocations, calls and cancellation. */
export class CodingMissionStore {
  constructor(
    private readonly database: Database,
    private readonly tasks: TaskStore,
    private readonly workspaces: WorkspaceStore,
    private readonly signals: TaskSignals
  ) {}

  async listCodingMissions(userId: string, parentTaskId: string): Promise<CodingMissionRecord[]> {
    const rows = await this.database.query(
      `${SELECT_MISSIONS} WHERE m.user_id=$1 AND m.parent_task_id=$2 ORDER BY m.created_at LIMIT 32`,
      [userId, parentTaskId]
    );
    return rows.rows.map(map);
  }
  async getCodingMission(userId: string, id: string): Promise<CodingMissionRecord | null> {
    const rows = await this.database.query(`${SELECT_MISSIONS} WHERE m.user_id=$1 AND m.id=$2`, [
      userId,
      id
    ]);
    return rows.rows[0] ? map(rows.rows[0]) : null;
  }
  async codingMissionForTask(taskId: string): Promise<CodingMissionRecord | null> {
    const rows = await this.database.query(`${SELECT_MISSIONS} WHERE m.child_task_id=$1`, [taskId]);
    return rows.rows[0] ? map(rows.rows[0]) : null;
  }

  async createCodingMission(input: {
    id: string;
    parentTaskId: string;
    userId: string;
    workerId: string;
    requestKey: string;
    requestHash: string;
    manifestCiphertext: EncryptedEnvelope;
    allocatedCredits: number;
    workspace: Parameters<WorkspaceStore['createWorkspace']>[0];
    task: Parameters<TaskStore['createTask']>[0];
  }): Promise<CodingMissionRecord> {
    return this.database.transaction(async (tx) => {
      const parentRows = await tx.query(
        'SELECT * FROM tasks WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [input.parentTaskId, input.userId]
      );
      const parent = parentRows.rows[0];
      if (
        !parent ||
        parent.status !== 'running' ||
        parent.lease_owner !== input.workerId ||
        new Date(String(parent.lease_expires_at)).getTime() <= Date.now()
      )
        throw new AthanorError(
          'coding_parent_not_owned',
          'This worker no longer owns the parent task',
          409
        );
      if (parent.parent_mission_id)
        throw new AthanorError(
          'coding_mission_nested',
          'A coding specialist cannot create another specialist',
          409
        );
      const existing = await tx.query(`${SELECT_MISSIONS} WHERE m.request_key=$1`, [
        input.requestKey
      ]);
      if (existing.rows[0]) {
        const held = map(existing.rows[0]);
        if (
          held.userId !== input.userId ||
          held.parentTaskId !== input.parentTaskId ||
          held.requestHash !== input.requestHash
        )
          throw new AthanorError(
            'coding_mission_replay_conflict',
            'This mission request already identifies different work',
            409
          );
        return held;
      }
      if (
        !Number.isFinite(input.allocatedCredits) ||
        input.allocatedCredits <= 0 ||
        input.workspace.userId !== input.userId ||
        input.task.userId !== input.userId ||
        input.task.workspaceId !== input.workspace.id
      )
        throw new AthanorError(
          'coding_mission_invalid',
          'Mission ownership or allocation is invalid',
          400
        );
      const count = await tx.query(
        'SELECT COUNT(*) AS count FROM coding_missions WHERE parent_task_id=$1',
        [input.parentTaskId]
      );
      if (Number(count.rows[0]?.count) >= 32)
        throw new AthanorError(
          'coding_mission_limit',
          'This task has reached its retained coding mission limit',
          409
        );
      await tx.query(
        `INSERT INTO coding_families(parent_task_id,ceiling_credits,initial_credits)
        VALUES($1,$2,$3) ON CONFLICT(parent_task_id) DO NOTHING`,
        [
          input.parentTaskId,
          Number(parent.max_compute_credits),
          Number(parent.actual_compute_credits)
        ]
      );
      const available = await this.capacity(tx, input.parentTaskId);
      if (input.allocatedCredits > available.parentRemaining + 1e-9)
        throw new AthanorError(
          'coding_family_budget',
          'The parent does not have enough unallocated compute capacity for this mission',
          409
        );
      const workspace = await this.workspaces.createWorkspace(input.workspace);
      await tx.query('UPDATE workspaces SET internal_parent_task_id=$2 WHERE id=$1', [
        workspace.id,
        input.parentTaskId
      ]);
      const child = await this.tasks.createTask({
        ...input.task,
        projectId: String(parent.project_id),
        maxComputeCredits: input.allocatedCredits,
        maxSpendUsd: parent.max_spend_usd === null ? null : Number(parent.max_spend_usd)
      });
      await tx.query(
        "UPDATE tasks SET status='paused',parent_task_id=$2,parent_mission_id=$3,has_coding_family=TRUE WHERE id=$1",
        [child.id, input.parentTaskId, input.id]
      );
      await tx.query('UPDATE tasks SET has_coding_family=TRUE WHERE id=$1', [input.parentTaskId]);
      await tx.query(
        `INSERT INTO coding_missions(id,user_id,parent_task_id,child_task_id,child_workspace_id,request_key,request_hash,manifest_ciphertext,allocated_credits,parent_workspace_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
        [
          input.id,
          input.userId,
          input.parentTaskId,
          child.id,
          workspace.id,
          input.requestKey,
          input.requestHash,
          JSON.stringify(input.manifestCiphertext),
          input.allocatedCredits,
          parent.workspace_id
        ]
      );
      return (await this.getCodingMission(input.userId, input.id))!;
    });
  }

  private async capacity(tx: Database, parentTaskId: string) {
    const totals = await tx.query(
      `SELECT t.max_compute_credits,f.initial_credits,
      COALESCE((SELECT SUM(COALESCE(c.actual_credits,c.reserved_credits)) FROM coding_family_calls c WHERE c.parent_task_id=f.parent_task_id AND c.task_id=f.parent_task_id),0) AS parent_used,
      COALESCE((SELECT SUM(CASE WHEN m.phase IN ('preparing','active','conflicted','integrating') AND child.status IN ${ACTIVE_CHILD}
        THEN GREATEST(m.allocated_credits,COALESCE(used.credits,0)) ELSE COALESCE(used.credits,0) END)
        FROM coding_missions m JOIN tasks child ON child.id=m.child_task_id
        LEFT JOIN LATERAL(SELECT SUM(COALESCE(c.actual_credits,c.reserved_credits)) AS credits FROM coding_family_calls c WHERE c.task_id=m.child_task_id) used ON TRUE
        WHERE m.parent_task_id=f.parent_task_id),0) AS child_committed
      FROM coding_families f JOIN tasks t ON t.id=f.parent_task_id WHERE f.parent_task_id=$1`,
      [parentTaskId]
    );
    const row = totals.rows[0];
    if (!row)
      throw new AthanorError(
        'coding_family_missing',
        'Coding task budget was not initialized',
        409
      );
    return {
      parentRemaining:
        Number(row.max_compute_credits) -
        Number(row.initial_credits) -
        Number(row.parent_used) -
        Number(row.child_committed)
    };
  }

  async reserveCodingInference(
    taskId: string,
    workerId: string,
    credits: number,
    estimateUsd = 0,
    nativeRequestId?: string
  ): Promise<string> {
    if (nativeRequestId !== undefined && !/^[a-f0-9]{64}$/.test(nativeRequestId))
      throw new AthanorError(
        'native_input_identity_missing',
        'A native request requires a valid source identity',
        400
      );
    const hash =
      nativeRequestId === undefined
        ? null
        : createHash('sha256').update(`native-input:${taskId}:${nativeRequestId}`).digest('hex');
    const id = hash
      ? `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
      : randomUUID();
    return this.database.transaction(async (tx) => {
      const lookup = await tx.query(
        'SELECT user_id,CASE WHEN parent_mission_id IS NULL THEN id ELSE parent_task_id END AS root FROM tasks WHERE id=$1',
        [taskId]
      );
      const root = lookup.rows[0]?.root;
      if (!root)
        throw new AthanorError('coding_task_missing', 'The coding task no longer exists', 409);
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [lookup.rows[0]!.user_id]);
      if (
        nativeRequestId !== undefined &&
        (await tx.query('SELECT id FROM coding_family_calls WHERE id=$1', [id])).rows.length
      )
        throw new AthanorError(
          'native_input_submission_exists',
          'This native recording request was already reserved. Its provider result may be uncertain; do not submit it again.',
          409
        );
      const parent = (await tx.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [root])).rows[0];
      const task = (await tx.query('SELECT * FROM tasks WHERE id=$1', [taskId])).rows[0];
      if (
        !parent ||
        !task ||
        ['cancelled', 'failed'].includes(String(parent.status)) ||
        (taskId !== root && task.privacy_route !== parent.privacy_route) ||
        task.status !== 'running' ||
        task.lease_owner !== workerId ||
        new Date(String(task.lease_expires_at)).getTime() <= Date.now()
      )
        throw new AthanorError(
          'coding_task_stopped',
          'This task no longer has authority to spend',
          409
        );
      if (
        !Number.isFinite(credits) ||
        credits < 0 ||
        !Number.isFinite(estimateUsd) ||
        estimateUsd < 0
      )
        throw new AthanorError(
          'coding_budget_invalid',
          'The inference reservation is invalid',
          400
        );
      let remaining: number;
      if (taskId === root) remaining = (await this.capacity(tx, String(root))).parentRemaining;
      else {
        const row = (
          await tx.query(
            `SELECT m.allocated_credits,m.phase,COALESCE((SELECT SUM(COALESCE(c.actual_credits,c.reserved_credits)) FROM coding_family_calls c WHERE c.task_id=m.child_task_id),0) AS used
          FROM coding_missions m WHERE m.child_task_id=$1`,
            [taskId]
          )
        ).rows[0];
        if (!row || row.phase !== 'active')
          throw new AthanorError(
            'coding_task_stopped',
            'The coding mission is no longer active',
            409
          );
        remaining = Number(row.allocated_credits) - Number(row.used);
      }
      if (credits > remaining + 1e-9)
        throw new AthanorError(
          'coding_family_budget',
          'The next request would exceed this task family’s reserved compute capacity',
          409
        );
      const spend = await new BillingStore(tx).spendGuardIn(tx, {
        userId: String(task.user_id),
        taskId,
        estimateUsd,
        includeOpenCommitments: true
      });
      if (spend.outcome === 'deny')
        throw new AthanorError(
          'coding_family_spend',
          'This request exceeds the task family or owner spending allowance',
          402
        );
      await tx.query(
        'INSERT INTO coding_family_calls(id,parent_task_id,task_id,reserved_credits,reserved_usd,user_id,original_task_id) VALUES($1,$2,$3,$4,$5,$6,$3)',
        [id, root, taskId, credits, estimateUsd, task.user_id]
      );
      return id;
    });
  }

  async settleCodingInference(
    id: string,
    actualCredits: number | null,
    actualUsd: number | null = actualCredits === null ? null : 0
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      const call = (await tx.query('SELECT * FROM coding_family_calls WHERE id=$1', [id])).rows[0];
      if (!call)
        throw new AthanorError(
          'coding_reservation_missing',
          'The coding reservation no longer exists',
          409
        );
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [call.user_id]);
      await tx.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [call.parent_task_id]);
      if (actualCredits !== null && (!Number.isFinite(actualCredits) || actualCredits < 0))
        throw new AthanorError('coding_charge_invalid', 'The coding usage charge is invalid', 400);
      if (
        (actualCredits === null) !== (actualUsd === null) ||
        (actualUsd !== null && (!Number.isFinite(actualUsd) || actualUsd < 0))
      )
        throw new AthanorError('coding_charge_invalid', 'The coding cost receipt is invalid', 400);
      const updated = await tx.query(
        `UPDATE coding_family_calls SET actual_credits=$2,actual_usd=$3,state=CASE WHEN $2::double precision IS NULL THEN 'uncertain' ELSE 'settled' END WHERE id=$1 AND (state='reserved' OR (state='uncertain' AND $2::double precision IS NOT NULL)) RETURNING id`,
        [id, actualCredits, actualUsd]
      );
      if (!updated.rows.length) return;
      await tx.query(
        `UPDATE tasks t SET actual_compute_credits=GREATEST(t.actual_compute_credits, f.initial_credits+COALESCE((SELECT SUM(c.actual_credits) FROM coding_family_calls c WHERE c.parent_task_id=t.id),0))
        FROM coding_families f WHERE t.id=$1 AND f.parent_task_id=t.id`,
        [call.parent_task_id]
      );
    });
  }

  async activateCodingMission(userId: string, id: string, generation: number): Promise<boolean> {
    const changed = await this.database.transaction(async (tx) => {
      const mission = await this.getCodingMission(userId, id);
      if (!mission) return false;
      const parent = (
        await tx.query('SELECT status FROM tasks WHERE id=$1 FOR UPDATE', [mission.parentTaskId])
      ).rows[0];
      if (!parent || ['cancelled', 'failed'].includes(String(parent.status))) return false;
      const row = await tx.query(
        "UPDATE coding_missions SET phase='active',runner_generation=generation,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND generation=$3 AND phase='preparing' RETURNING child_task_id,child_workspace_id",
        [id, userId, generation]
      );
      if (!row.rows[0]) return false;
      await tx.query("UPDATE workspaces SET status='running',updated_at=NOW() WHERE id=$1", [
        mission.childWorkspaceId
      ]);
      await tx.query(
        "UPDATE tasks SET status='queued',updated_at=NOW() WHERE id=$1 AND status='paused'",
        [mission.childTaskId]
      );
      return mission.childTaskId;
    });
    if (changed) this.signals.signal(TASK_QUEUE_CHANNEL, changed);
    return Boolean(changed);
  }

  async cancelCodingMission(userId: string, id: string): Promise<CodingMissionRecord | null> {
    return this.database.transaction(async (tx) => {
      const found = await this.getCodingMission(userId, id);
      if (!found) return null;
      await tx.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [found.parentTaskId]);
      const mission = (await this.getCodingMission(userId, id))!;
      if (mission.phase === 'integrated')
        throw new AthanorError(
          'coding_already_integrated',
          'These changes are already integrated; use the parent recovery point to undo them',
          409
        );
      if (mission.phase === 'integrating')
        throw new AthanorError(
          'coding_integration_active',
          'Integration is active; wait for its atomic result before cancelling',
          409
        );
      await tx.query(
        "UPDATE coding_missions SET phase='cancelled',generation=generation+1,updated_at=NOW() WHERE id=$1 AND phase<>'cancelled'",
        [id]
      );
      await this.tasks.cancelTaskAndReleaseReservations(userId, mission.childTaskId);
      return (await this.getCodingMission(userId, id))!;
    });
  }
  async recordCodingMissionReview(
    userId: string,
    id: string,
    generation: number,
    review: { digest: string; changedFiles: number; conflicts: number }
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE coding_missions SET review_digest=$4,changed_files=$5,conflicts=$6,updated_at=NOW()
      WHERE user_id=$1 AND id=$2 AND generation=$3 AND phase IN ('active','conflicted') RETURNING id`,
      [userId, id, generation, review.digest, review.changedFiles, review.conflicts]
    );
    return result.rows.length === 1;
  }
  async beginCodingMissionIntegration(
    userId: string,
    id: string,
    generation: number,
    digest: string,
    workerId?: string
  ): Promise<CodingMissionRecord> {
    return this.database.transaction(async (tx) => {
      const found = await this.getCodingMission(userId, id);
      if (!found) throw new AthanorError('coding_mission_missing', 'Coding mission not found', 404);
      const parent = (
        await tx.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [found.parentTaskId])
      ).rows[0];
      const mission = (await this.getCodingMission(userId, id))!;
      if (
        mission.phase === 'integrated' &&
        mission.generation === generation &&
        mission.reviewDigest === digest
      )
        return mission;
      if (
        !parent ||
        ['failed', 'cancelled', 'queued', 'planning'].includes(String(parent.status)) ||
        (parent.status === 'running' &&
          (!workerId ||
            parent.lease_owner !== workerId ||
            new Date(String(parent.lease_expires_at)).getTime() <= Date.now()))
      )
        throw new AthanorError(
          'coding_parent_busy',
          'Wait until the parent task has released the workspace before integrating',
          409
        );
      if (
        mission.generation !== generation ||
        mission.reviewDigest !== digest ||
        !['active', 'conflicted', 'integrating'].includes(mission.phase) ||
        mission.childStatus !== 'completed'
      )
        throw new AthanorError(
          'coding_review_changed',
          'The completed coding mission must be reviewed again before integration',
          409
        );
      await tx.query(
        "UPDATE coding_missions SET phase='integrating',updated_at=NOW() WHERE id=$1",
        [id]
      );
      return (await this.getCodingMission(userId, id))!;
    });
  }
  async finishCodingMissionIntegration(
    userId: string,
    id: string,
    generation: number,
    digest: string,
    integrated: boolean
  ): Promise<boolean> {
    const changed = await this.database.query(
      `UPDATE coding_missions SET phase=CASE WHEN $5::boolean THEN 'integrated' WHEN EXISTS(SELECT 1 FROM tasks p WHERE p.id=coding_missions.parent_task_id AND p.status IN ('cancelled','failed')) THEN 'cancelled' ELSE 'active' END,updated_at=NOW()
      WHERE user_id=$1 AND id=$2 AND generation=$3 AND review_digest=$4 AND phase='integrating' RETURNING id`,
      [userId, id, generation, digest, integrated]
    );
    return changed.rows.length === 1;
  }
  async acknowledgeCodingMissionRunner(
    userId: string,
    id: string,
    generation: number,
    sealed = false
  ): Promise<void> {
    await this.database.query(
      'UPDATE coding_missions SET runner_generation=$3,runner_sealed=$4 WHERE user_id=$1 AND id=$2 AND generation=$3',
      [userId, id, generation, sealed]
    );
  }
  async codingMissionsNeedingSync(): Promise<CodingMissionRecord[]> {
    const rows = await this.database.query(`${SELECT_MISSIONS} WHERE
      (m.phase='integrating') OR
      (m.phase='active' AND t.status='completed' AND m.runner_sealed=FALSE) OR
      (m.phase IN ('active','preparing','conflicted') AND (t.status IN ('failed','cancelled') OR p.status IN ('failed','cancelled'))) OR
      (m.phase='cancelled' AND m.runner_generation<m.generation) OR
      (m.phase='preparing' AND m.updated_at<NOW()-INTERVAL '2 minutes' AND (p.status<>'running' OR p.lease_expires_at<NOW()))
      ORDER BY m.updated_at LIMIT 32`);
    return rows.rows.map(map);
  }
  async parkForCodingMissions(input: {
    taskId: string;
    workerId: string;
    agentStateCiphertext: EncryptedEnvelope;
    actualComputeCredits: number;
  }): Promise<boolean> {
    const parked = await this.database.transaction(async (tx) => {
      const held = (
        await tx.query(
          "SELECT id FROM tasks WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_expires_at>NOW() FOR UPDATE",
          [input.taskId, input.workerId]
        )
      ).rows[0];
      if (!held) return false;
      const active = await tx.query(
        `SELECT m.id FROM coding_missions m JOIN tasks t ON t.id=m.child_task_id WHERE m.parent_task_id=$1
        AND m.phase IN ('preparing','active','conflicted','integrating') AND t.status IN ${ACTIVE_CHILD} LIMIT 1`,
        [input.taskId]
      );
      if (!active.rows.length) return false;
      await tx.query('UPDATE coding_families SET wait_requested=TRUE WHERE parent_task_id=$1', [
        input.taskId
      ]);
      await tx.query(
        `UPDATE tasks SET status='awaiting_resource',lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW(),
        agent_state_ciphertext=$2::jsonb,actual_compute_credits=GREATEST(actual_compute_credits,$3) WHERE id=$1`,
        [input.taskId, JSON.stringify(input.agentStateCiphertext), input.actualComputeCredits]
      );
      return true;
    });
    if (parked) this.signals.signal(TASK_QUEUE_CHANNEL, input.taskId);
    return parked;
  }
  async replyToCodingMission(input: {
    messageId?: string;
    userId: string;
    taskId: string;
    expectedState: EncryptedEnvelope;
    agentStateCiphertext: EncryptedEnvelope;
    messageCiphertext: EncryptedEnvelope;
  }): Promise<boolean> {
    const replied = await this.database.transaction(async (tx) => {
      const found = await this.codingMissionForTask(input.taskId);
      if (!found || found.userId !== input.userId) return false;
      await tx.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [found.parentTaskId]);
      const result = await tx.query(
        `UPDATE tasks t SET status='queued',agent_state_ciphertext=$3::jsonb,attempt=0,updated_at=NOW()
        WHERE t.id=$1 AND t.user_id=$2 AND t.status='awaiting_user' AND t.lease_owner IS NULL AND t.agent_state_ciphertext=$4::jsonb
        AND EXISTS(SELECT 1 FROM coding_missions m JOIN tasks p ON p.id=m.parent_task_id WHERE m.child_task_id=t.id AND m.phase='active' AND NOT m.runner_sealed AND p.status NOT IN ('failed','cancelled'))
        AND NOT EXISTS(SELECT 1 FROM approvals a WHERE a.task_id=t.id AND a.status='pending' AND a.expires_at>NOW()) RETURNING t.id`,
        [
          input.taskId,
          input.userId,
          JSON.stringify(input.agentStateCiphertext),
          JSON.stringify(input.expectedState)
        ]
      );
      if (!result.rows.length) return false;
      await this.tasks.appendTaskEvent({
        ...(input.messageId ? { id: input.messageId } : {}),
        taskId: input.taskId,
        kind: 'user_message',
        summary: 'Owner clarification',
        payloadCiphertext: input.messageCiphertext
      });
      return true;
    });
    if (replied) this.signals.signal(TASK_QUEUE_CHANNEL, input.taskId);
    return replied;
  }
  async wakeCodingMissionParents(): Promise<string[]> {
    const rows = await this.database.transaction(async (tx) => {
      const ready =
        await tx.query(`UPDATE tasks p SET status='queued',attempt=0,updated_at=NOW() FROM coding_families f
        WHERE f.parent_task_id=p.id AND f.wait_requested=TRUE AND p.status='awaiting_resource'
        AND NOT EXISTS(SELECT 1 FROM coding_missions holding WHERE holding.parent_task_id=p.id AND holding.phase='integrating')
        AND NOT EXISTS(SELECT 1 FROM coding_missions m JOIN tasks child ON child.id=m.child_task_id
          WHERE m.parent_task_id=p.id AND m.phase IN ('preparing','active','conflicted','integrating') AND child.status IN ${ACTIVE_CHILD}) RETURNING p.id`);
      const ids = ready.rows.map((r) => String(r.id));
      if (ids.length)
        await tx.query(
          'UPDATE coding_families SET wait_requested=FALSE WHERE parent_task_id=ANY($1::uuid[])',
          [ids]
        );
      return ids;
    });
    for (const id of rows) this.signals.signal(TASK_QUEUE_CHANNEL, id);
    return rows;
  }
}
