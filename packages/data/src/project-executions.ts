import { GardenError, type EncryptedEnvelope } from '@garden/core';
import type { Database } from './database.js';
import { json, mapTask } from './store/rows.js';
import { TASK_QUEUE_CHANNEL, type TaskSignals } from './store/tasks.js';

export interface ProjectExecutionRecord {
  taskId: string;
  parentWorkspaceId: string;
  sourceWorkspaceId: string;
  workspaceId: string;
  status: 'preparing' | 'ready' | 'shared' | 'failed';
  seedKind: 'new' | 'legacy';
  sourceTaskStatus: string;
  sourceManifestCiphertext: EncryptedEnvelope;
  receiptCiphertext: EncryptedEnvelope | null;
  lastErrorCode: string | null;
}
const map = (r: Record<string, unknown>): ProjectExecutionRecord => ({
  taskId: String(r.task_id),
  parentWorkspaceId: String(r.parent_workspace_id),
  sourceWorkspaceId: String(r.source_workspace_id),
  workspaceId: String(r.workspace_id),
  status: r.status as ProjectExecutionRecord['status'],
  seedKind: r.seed_kind as ProjectExecutionRecord['seedKind'],
  sourceTaskStatus: String(r.source_task_status),
  sourceManifestCiphertext: json(r.source_manifest_ciphertext),
  receiptCiphertext: r.receipt_ciphertext ? json(r.receipt_ciphertext) : null,
  lastErrorCode: typeof r.last_error_code === 'string' ? r.last_error_code : null
});

/** An execution root changes only while no worker owns its conversation. */
export class ProjectExecutionStore {
  constructor(
    private readonly database: Database,
    private readonly signals: TaskSignals
  ) {}
  async getProjectExecution(
    userId: string,
    taskId: string
  ): Promise<ProjectExecutionRecord | null> {
    const result = await this.database.query(
      `SELECT p.* FROM project_executions p JOIN tasks t ON t.id=p.task_id WHERE t.user_id=$1 AND p.task_id=$2`,
      [userId, taskId]
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  async beginProjectExecution(input: {
    userId: string;
    taskId: string;
    workspaceId: string;
    wrappedKey: string;
    sourceManifestCiphertext: EncryptedEnvelope;
    seedKind: ProjectExecutionRecord['seedKind'];
    independent?: boolean;
  }): Promise<ProjectExecutionRecord | null> {
    return this.database.transaction(async (tx) => {
      const rows = await tx.query(
        `SELECT t.*,w.parent_workspace_id,w.internal_parent_task_id,w.storage_limit_bytes,w.image_revision,w.region,w.runner_ref,w.status AS workspace_status FROM tasks t JOIN workspaces w ON w.id=t.workspace_id WHERE t.id=$1 AND t.user_id=$2 FOR UPDATE OF t`,
        [input.taskId, input.userId]
      );
      const t = rows.rows[0];
      if (!t) throw new GardenError('task_not_found', 'Task not found', 404);
      if (t.workspace_status !== 'running')
        throw new GardenError('workspace_unavailable', 'Workspace is not running', 409);
      const existing = await this.getProjectExecution(input.userId, input.taskId);
      if (existing?.status === 'ready') return existing;
      if (
        (!input.independent && t.parent_workspace_id && !existing) ||
        t.internal_parent_task_id ||
        t.parent_mission_id
      )
        return null;
      if (t.lease_owner && new Date(String(t.lease_expires_at)).getTime() > Date.now()) return null;
      if (existing) {
        await tx.query(
          `UPDATE project_executions SET status='preparing',last_error_code=NULL,source_task_status=$2,updated_at=NOW() WHERE task_id=$1`,
          [input.taskId, t.status]
        );
        return {
          ...existing,
          status: 'preparing',
          lastErrorCode: null,
          sourceTaskStatus: String(t.status)
        };
      }
      await tx.query(
        `INSERT INTO workspaces(id,user_id,name,status,storage_limit_bytes,image_revision,region,security_mode,runner_ref,parent_workspace_id,project_task_id) VALUES($1,$2,'Project execution','provisioning',$3,$4,$5,$6,$7,$8,$9)`,
        [
          input.workspaceId,
          input.userId,
          t.storage_limit_bytes,
          t.image_revision,
          t.region,
          t.security_mode,
          t.runner_ref,
          t.parent_workspace_id ?? t.workspace_id,
          input.taskId
        ]
      );
      await tx.query(
        `INSERT INTO workspace_keys(workspace_id,wrapped_key,wrapping_mode) VALUES($1,$2,'hosted')`,
        [input.workspaceId, input.wrappedKey]
      );
      const created = await tx.query(
        `INSERT INTO project_executions(task_id,parent_workspace_id,source_workspace_id,workspace_id,seed_kind,source_manifest_ciphertext,source_task_status) VALUES($1,$7,$2,$3,$4,$5::jsonb,$6) RETURNING *`,
        [
          input.taskId,
          t.workspace_id,
          input.workspaceId,
          input.seedKind,
          JSON.stringify(input.sourceManifestCiphertext),
          t.status,
          t.parent_workspace_id ?? t.workspace_id
        ]
      );
      return map(created.rows[0]!);
    });
  }
  async finishProjectExecution(input: {
    userId: string;
    taskId: string;
    workspaceId: string;
    receiptCiphertext: EncryptedEnvelope;
    rewrite: (task: ReturnType<typeof mapTask>) => {
      titleCiphertext: EncryptedEnvelope;
      promptCiphertext: EncryptedEnvelope;
      pendingApprovalId?: string;
    };
    sharedReason?: string;
  }): Promise<boolean> {
    const result = await this.database.transaction(async (tx) => {
      const rows = await tx.query(
        `SELECT t.* FROM tasks t WHERE t.id=$1 AND t.user_id=$2 FOR UPDATE`,
        [input.taskId, input.userId]
      );
      const row = rows.rows[0];
      const execution = await this.getProjectExecution(input.userId, input.taskId);
      if (!row || !execution || execution.workspaceId !== input.workspaceId) return false;
      if (execution.status === 'ready') return row.workspace_id === input.workspaceId;
      if (
        execution.status !== 'preparing' ||
        (['completed', 'failed', 'cancelled'].includes(String(row.status)) &&
          row.status !== execution.sourceTaskStatus) ||
        row.workspace_id !== execution.sourceWorkspaceId ||
        (row.lease_owner && new Date(String(row.lease_expires_at)).getTime() > Date.now())
      )
        return false;
      if (!input.sharedReason) {
        const sealed = input.rewrite(mapTask(row));
        if (sealed.pendingApprovalId) {
          const approval = await tx.query(
            'SELECT status FROM approvals WHERE id=$1 AND task_id=$2 FOR UPDATE',
            [sealed.pendingApprovalId, input.taskId]
          );
          if (approval.rows[0]?.status === 'approved') {
            await tx.query(
              "UPDATE project_executions SET status='shared',last_error_code='project_approved_action',updated_at=NOW() WHERE task_id=$1",
              [input.taskId]
            );
            return true;
          }
          await tx.query(
            "UPDATE approvals SET status='denied',resolved_at=NOW() WHERE id=$1 AND task_id=$2 AND status='pending'",
            [sealed.pendingApprovalId, input.taskId]
          );
        }
        await tx.query(
          `UPDATE tasks SET workspace_id=$2,title=$3,prompt_ciphertext=$4::jsonb,updated_at=NOW() WHERE id=$1`,
          [
            input.taskId,
            input.workspaceId,
            JSON.stringify(sealed.titleCiphertext),
            JSON.stringify(sealed.promptCiphertext)
          ]
        );
        await tx.query(`UPDATE workspaces SET status='running',updated_at=NOW() WHERE id=$1`, [
          input.workspaceId
        ]);
        await tx.query(
          `UPDATE workspaces SET lease_task_id=NULL,lease_expires_at=NULL WHERE id=$1 AND lease_task_id=$2`,
          [execution.sourceWorkspaceId, input.taskId]
        );
      }
      await tx.query(
        `UPDATE project_executions SET status=$2,receipt_ciphertext=$3::jsonb,last_error_code=$4,updated_at=NOW() WHERE task_id=$1`,
        [
          input.taskId,
          input.sharedReason ? 'shared' : 'ready',
          JSON.stringify(input.receiptCiphertext),
          input.sharedReason ?? null
        ]
      );
      return true;
    });
    if (result) this.signals.signal(TASK_QUEUE_CHANNEL, input.taskId);
    return result;
  }
  async failProjectExecution(userId: string, taskId: string, code: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM tasks WHERE id=$1 AND user_id=$2 FOR UPDATE', [
        taskId,
        userId
      ]);
      const changed = await tx.query(
        `UPDATE project_executions p SET status='failed',last_error_code=$3,updated_at=NOW() FROM tasks t WHERE t.id=p.task_id AND t.user_id=$1 AND t.id=$2 AND p.status='preparing' RETURNING p.task_id`,
        [userId, taskId, code.slice(0, 100)]
      );
      if (changed.rows.length)
        await tx.query(
          "UPDATE tasks SET status='awaiting_resource',updated_at=NOW() WHERE id=$1 AND status IN ('queued','planning') AND (lease_expires_at IS NULL OR lease_expires_at<NOW())",
          [taskId]
        );
    });
  }

  async listProjectWorkspaces(userId: string, parentWorkspaceId: string): Promise<string[]> {
    return (
      await this.database.query(
        'SELECT id FROM workspaces WHERE user_id=$1 AND parent_workspace_id=$2 ORDER BY id',
        [userId, parentWorkspaceId]
      )
    ).rows.map((row) => String(row.id));
  }
  async pendingProjectExecutions(): Promise<Array<{ userId: string; taskId: string }>> {
    const result = await this.database.query(
      `SELECT t.user_id,p.task_id FROM project_executions p JOIN tasks t ON t.id=p.task_id WHERE p.status='preparing' AND p.updated_at<NOW()-INTERVAL '2 minutes' AND t.status NOT IN ('paused','cancelled','completed','failed') ORDER BY p.updated_at LIMIT 10`
    );
    return result.rows.map((r) => ({ userId: String(r.user_id), taskId: String(r.task_id) }));
  }
}
