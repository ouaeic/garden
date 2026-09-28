import { randomUUID } from 'node:crypto';
import { GardenError, type EncryptedEnvelope } from '@garden/core';
import type { Database } from '../database.js';
import type { NotificationStore } from './notifications.js';
import { TASK_EVENT_CHANNEL, type TaskSignals } from './tasks.js';

/** Only delivery identifiers are queued; event and notification bodies arrive already sealed. */
export class MediaDeliveryStore {
  constructor(
    private readonly database: Database,
    private readonly notifications: NotificationStore,
    private readonly signals: TaskSignals
  ) {}
  async leaseMediaDelivery(leaseOwner: string): Promise<{ jobId: string; userId: string } | null> {
    const result = await this.database.query(
      `WITH leased AS (UPDATE provider_media_delivery_outbox SET lease_owner=$1,lease_expires_at=NOW()+INTERVAL '60 seconds',attempts=attempts+1
      WHERE job_id=(SELECT job_id FROM provider_media_delivery_outbox WHERE delivered_at IS NULL AND next_attempt_at<=NOW()
      AND (lease_expires_at IS NULL OR lease_expires_at<=NOW()) ORDER BY created_at,job_id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING job_id) SELECT l.job_id,j.user_id FROM leased l JOIN provider_media_jobs j ON j.id=l.job_id`,
      [leaseOwner]
    );
    return result.rows[0]
      ? { jobId: String(result.rows[0].job_id), userId: String(result.rows[0].user_id) }
      : null;
  }
  async deferMediaDelivery(jobId: string, leaseOwner: string): Promise<void> {
    await this.database.query(
      `UPDATE provider_media_delivery_outbox SET lease_owner=NULL,lease_expires_at=NULL,
      next_attempt_at=NOW()+make_interval(secs=>LEAST(600,5*POWER(2,LEAST(attempts,6)))::double precision)
      WHERE job_id=$1 AND lease_owner=$2 AND delivered_at IS NULL`,
      [jobId, leaseOwner]
    );
  }
  async publishMediaDelivery(input: {
    jobId: string;
    leaseOwner: string;
    payloadCiphertext: EncryptedEnvelope;
    messageCiphertext: EncryptedEnvelope;
  }): Promise<boolean> {
    const taskId = await this.database.transaction(async (tx) => {
      const result = await tx.query(
        `SELECT j.task_id,j.user_id FROM provider_media_delivery_outbox o JOIN provider_media_jobs j ON j.id=o.job_id
        WHERE o.job_id=$1 AND o.lease_owner=$2 AND o.lease_expires_at>NOW() AND o.delivered_at IS NULL AND j.status='completed' AND j.artifact_id IS NOT NULL FOR UPDATE OF o`,
        [input.jobId, input.leaseOwner]
      );
      const row = result.rows[0];
      if (!row) return null;
      await tx.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [row.task_id]);
      await tx.query(
        `INSERT INTO task_events(id,task_id,sequence,kind,summary,payload_ciphertext)
        SELECT $1,$2,COALESCE(MAX(sequence),0)+1,'artifact','Encrypted media event',$3::jsonb FROM task_events WHERE task_id=$2`,
        [randomUUID(), row.task_id, JSON.stringify(input.payloadCiphertext)]
      );
      let notificationState = 'sent';
      try {
        await this.notifications.createAgentNotification({
          userId: String(row.user_id),
          taskId: String(row.task_id),
          kind: 'agent_message',
          messageCiphertext: input.messageCiphertext
        });
      } catch (error) {
        if (!(error instanceof GardenError && error.code === 'agent_notification_limit'))
          throw error;
        notificationState = 'suppressed_limit';
      }
      await tx.query(
        `UPDATE provider_media_delivery_outbox SET delivered_at=NOW(),notification_state=$3,lease_owner=NULL,lease_expires_at=NULL WHERE job_id=$1 AND lease_owner=$2`,
        [input.jobId, input.leaseOwner, notificationState]
      );
      return String(row.task_id);
    });
    if (taskId) this.signals.signal(TASK_EVENT_CHANNEL, taskId);
    return taskId !== null;
  }
}
