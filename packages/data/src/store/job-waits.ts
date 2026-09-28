import { randomUUID } from 'node:crypto';
import type { EncryptedEnvelope } from '@garden/core';
import type { Database } from '../database.js';
import { type TaskSignals, TASK_EVENT_CHANNEL, TASK_QUEUE_CHANNEL } from './tasks.js';
import { json } from './rows.js';

export class JobWaitStore {
  constructor(
    private readonly database: Database,
    private readonly signals: TaskSignals
  ) {}

  async parkTaskForJobs(input: {
    id: string;
    taskId: string;
    workerId: string;
    dependenciesCiphertext: EncryptedEnvelope;
    agentStateCiphertext: EncryptedEnvelope;
    eventCiphertext: EncryptedEnvelope;
    actualComputeCredits: number;
  }): Promise<boolean> {
    const parked = await this.database.transaction(async (tx) => {
      const held = await tx.query(
        "SELECT id FROM tasks WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_expires_at>NOW() FOR UPDATE",
        [input.taskId, input.workerId]
      );
      if (!held.rows.length) return false;
      await tx.query(
        `INSERT INTO task_job_waits(task_id,id,dependencies_ciphertext) VALUES($1,$2,$3::jsonb)
        ON CONFLICT(task_id) DO UPDATE SET id=EXCLUDED.id,dependencies_ciphertext=EXCLUDED.dependencies_ciphertext,
        outcome_ciphertext=NULL,state='waiting',checked_at=NULL,finished_at=NULL`,
        [input.taskId, input.id, JSON.stringify(input.dependenciesCiphertext)]
      );
      await tx.query(
        `UPDATE tasks SET status='awaiting_resource',lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW(),agent_state_ciphertext=$2::jsonb,actual_compute_credits=GREATEST(actual_compute_credits,$3) WHERE id=$1`,
        [input.taskId, JSON.stringify(input.agentStateCiphertext), input.actualComputeCredits]
      );
      await tx.query(
        `INSERT INTO task_events(id,task_id,sequence,kind,summary,payload_ciphertext)
        SELECT $1,$2,COALESCE(MAX(sequence),0)+1,'status','Encrypted job wait',$3::jsonb FROM task_events WHERE task_id=$2`,
        [randomUUID(), input.taskId, JSON.stringify(input.eventCiphertext)]
      );
      return true;
    });
    if (parked) this.signals.signal(TASK_EVENT_CHANNEL, input.taskId);
    return parked;
  }

  async claimJobWaits(limit = 32): Promise<
    Array<{
      id: string;
      taskId: string;
      userId: string;
      workspaceId: string;
      dependenciesCiphertext: EncryptedEnvelope;
    }>
  > {
    const result = await this.database.query(
      `WITH claimed AS (
      SELECT j.task_id FROM task_job_waits j JOIN tasks t ON t.id=j.task_id
      WHERE j.state='waiting' AND t.status='awaiting_resource' AND t.lease_owner IS NULL
        AND (j.checked_at IS NULL OR j.checked_at<NOW()-INTERVAL '1 minute')
      ORDER BY j.checked_at NULLS FIRST FOR UPDATE OF j SKIP LOCKED LIMIT $1
    ), touched AS (
      UPDATE task_job_waits j SET checked_at=NOW() FROM claimed c WHERE j.task_id=c.task_id RETURNING j.*
    ) SELECT touched.*,t.user_id,t.workspace_id FROM touched JOIN tasks t ON t.id=touched.task_id`,
      [Math.max(1, Math.min(128, Math.trunc(limit)))]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      userId: String(row.user_id),
      workspaceId: String(row.workspace_id),
      dependenciesCiphertext: json<EncryptedEnvelope>(row.dependencies_ciphertext)
    }));
  }

  async wakeTaskFromJobs(input: {
    id: string;
    taskId: string;
    expectedState: EncryptedEnvelope;
    agentStateCiphertext: EncryptedEnvelope;
    outcomeCiphertext: EncryptedEnvelope;
  }): Promise<boolean> {
    const ready = await this.database.transaction(async (tx) => {
      const held = await tx.query(
        `SELECT id FROM tasks WHERE id=$1 AND status='awaiting_resource' AND lease_owner IS NULL
        AND agent_state_ciphertext=$2::jsonb FOR UPDATE`,
        [input.taskId, JSON.stringify(input.expectedState)]
      );
      if (!held.rows.length) return false;
      const wait = await tx.query(
        "UPDATE task_job_waits SET state='delivered',finished_at=NOW(),outcome_ciphertext=$3::jsonb WHERE task_id=$1 AND id=$2 AND state='waiting' RETURNING id",
        [input.taskId, input.id, JSON.stringify(input.outcomeCiphertext)]
      );
      if (!wait.rows.length) return false;
      await tx.query(
        "UPDATE tasks SET status='queued',attempt=0,updated_at=NOW(),agent_state_ciphertext=$2::jsonb WHERE id=$1",
        [input.taskId, JSON.stringify(input.agentStateCiphertext)]
      );
      await tx.query(
        `INSERT INTO task_events(id,task_id,sequence,kind,summary,payload_ciphertext)
        SELECT $1,$2,COALESCE(MAX(sequence),0)+1,'status','Encrypted job completion',$3::jsonb FROM task_events WHERE task_id=$2`,
        [randomUUID(), input.taskId, JSON.stringify(input.outcomeCiphertext)]
      );
      return true;
    });
    if (ready) {
      this.signals.signal(TASK_EVENT_CHANNEL, input.taskId);
      this.signals.signal(TASK_QUEUE_CHANNEL, input.taskId);
    }
    return ready;
  }
}
