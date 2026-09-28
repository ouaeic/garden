import { decryptJson, unwrapDataKey, type EncryptedEnvelope } from '@garden/core';
import { z } from 'zod';
import type { Task } from '@garden/contracts';
import type { RouteContext } from './http/server-context.js';
import { revealedTaskEvent } from './context.js';

const envelope = (value: unknown): EncryptedEnvelope =>
  (typeof value === 'string' ? JSON.parse(value) : value) as EncryptedEnvelope;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const sentence = (value: unknown, fallback: string) =>
  typeof value === 'string' && value.trim() ? value.slice(0, 320) : fallback;

/** One bounded batch for the visible conversations; progress comes from recorded work, without model calls. */
export async function projectActivity(
  context: RouteContext,
  userId: string,
  projectId: string,
  taskIds: string[]
): Promise<Map<string, NonNullable<Task['activity']>>> {
  if (!taskIds.length) return new Map();
  const result = await context.database.query(
    `
    SELECT t.id,t.workspace_id,k.wrapped_key,p.steps_ciphertext,p.created_at AS plan_at,
      e.id AS event_id,e.kind,e.summary,e.created_at AS event_at,
      CASE WHEN octet_length(e.payload_ciphertext::text)<65536 THEN e.payload_ciphertext ELSE NULL END AS payload_ciphertext,
      CASE WHEN octet_length(c.payload_ciphertext::text)<65536 THEN c.payload_ciphertext ELSE NULL END AS completion_ciphertext
    FROM tasks t JOIN workspace_keys k ON k.workspace_id=t.workspace_id
    LEFT JOIN LATERAL (SELECT steps_ciphertext,created_at FROM task_plans WHERE task_id=t.id ORDER BY version DESC LIMIT 1) p ON true
    LEFT JOIN LATERAL (SELECT id,kind,summary,payload_ciphertext,created_at FROM task_events WHERE task_id=t.id
      AND kind IN ('plan','tool_started','tool_result','assistant_message','notice','warning','error','completed','question_asked','approval_requested')
      ORDER BY sequence DESC LIMIT 1) e ON true
    LEFT JOIN LATERAL (SELECT payload_ciphertext FROM task_events WHERE task_id=t.id AND kind='completed'
      AND t.status='completed' ORDER BY sequence DESC LIMIT 1) c ON true
    WHERE t.user_id=$1 AND t.project_id=$2 AND t.id=ANY($3::uuid[])`,
    [userId, projectId, taskIds]
  );
  return new Map(
    result.rows.map((raw) => {
      const row = z
        .object({
          id: z.string(),
          workspace_id: z.string(),
          wrapped_key: z.string(),
          steps_ciphertext: z.unknown(),
          payload_ciphertext: z.unknown(),
          completion_ciphertext: z.unknown(),
          summary: z.string().nullable(),
          event_id: z.string().nullable(),
          event_at: z.union([z.string(), z.date()]).nullable()
        })
        .parse(raw);
      const key = unwrapDataKey(
        String(row.wrapped_key),
        context.masterKey,
        String(row.workspace_id)
      );
      const plan = row.steps_ciphertext
        ? object(decryptJson(envelope(row.steps_ciphertext), key, `task-plan:${row.id}`))
        : {};
      const steps = Array.isArray(plan.steps) ? plan.steps.map(object) : [];
      const current = steps.find((step) => step.status === 'in_progress');
      const decoded = row.payload_ciphertext
        ? decryptJson(envelope(row.payload_ciphertext), key, `task-event:${row.id}`)
        : undefined;
      const completed = row.completion_ciphertext
        ? revealedTaskEvent(
            '',
            decryptJson(envelope(row.completion_ciphertext), key, `task-event:${row.id}`)
          ).payload
        : undefined;
      const ending = object(completed);
      const verification = object(ending.verification);
      const event = revealedTaskEvent(String(row.summary ?? ''), decoded);
      return [
        String(row.id),
        {
          currentStep: current ? sentence(current.title, 'Work in progress') : null,
          stepsCompleted: steps.filter((step) => step.status === 'completed').length,
          stepsSkipped: steps.filter((step) => step.status === 'skipped').length,
          ...(completed
            ? {
                ending: {
                  interrupted: ending.interrupted === true,
                  verification: typeof verification.status === 'string' ? verification.status : null
                }
              }
            : {}),
          stepsTotal: steps.length,
          latest: sentence(event.summary, 'No recorded activity yet'),
          eventId: row.event_id ? String(row.event_id) : null,
          observedAt: row.event_at ? new Date(String(row.event_at)).toISOString() : null
        }
      ];
    })
  );
}
