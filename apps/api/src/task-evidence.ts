import { TaskEvent } from '@garden/contracts';
import { decryptJson } from '@garden/core';
import type { Database } from '@garden/data';
import { z } from 'zod';
import { revealedTaskEvent } from './context.js';

export const PRESENTATION_EVENT_LIMIT = 1_024;
export const PRESENTATION_RECEIPT_LIMIT = 128;
export const PRESENTATION_PAYLOAD_BYTES = 4 * 1024 * 1024;
const EVENT_PAYLOAD_BYTES = 256 * 1024;
const CACHE_TASKS = 8;
const EventEnvelope = z
  .object({
    v: z.number().int(),
    iv: z.string(),
    tag: z.string(),
    ciphertext: z.string(),
    aad: z.string().optional()
  })
  .transform(({ aad, ...envelope }) => (aad === undefined ? envelope : { ...envelope, aad }));

export type TaskEvidence = {
  events: TaskEvent[];
  cursor: number;
  coverage: { scope: 'complete' | 'recent'; eventCount: number; omittedPayloads: number };
};

/** Sealed event bodies are decrypted only inside a bounded, owner-authorized read. */
export class TaskEvidenceReader {
  readonly #cache = new Map<string, TaskEvidence>();
  readonly #pending = new Map<string, Promise<TaskEvidence>>();
  constructor(private readonly database: Database) {}

  async read(taskId: string, key: Uint8Array): Promise<TaskEvidence> {
    const cursorRows = await this.database.query(
      `SELECT sequence FROM task_events WHERE task_id=$1 AND kind NOT IN ('assistant_delta','assistant_reasoning') ORDER BY sequence DESC LIMIT 1`,
      [taskId]
    );
    const cursor = Number(cursorRows.rows[0]?.sequence ?? 0);
    const cached = this.#cache.get(taskId);
    if (cached?.cursor === cursor) {
      this.#cache.delete(taskId);
      this.#cache.set(taskId, cached);
      return cached;
    }
    const pendingKey = `${taskId}:${cursor}`;
    const existing = this.#pending.get(pendingKey);
    if (existing) return existing;
    const pending = this.#load(taskId, key, cursor)
      .then((evidence) => {
        this.#cache.delete(taskId);
        this.#cache.set(taskId, evidence);
        while (this.#cache.size > CACHE_TASKS) this.#cache.delete(this.#cache.keys().next().value!);
        return evidence;
      })
      .finally(() => this.#pending.delete(pendingKey));
    this.#pending.set(pendingKey, pending);
    return pending;
  }

  async #load(taskId: string, key: Uint8Array, cursor: number): Promise<TaskEvidence> {
    const rows = await this.database.query(
      `
      WITH candidates AS (
        (SELECT id,sequence FROM task_events WHERE task_id=$1 AND sequence <= $2 AND kind NOT IN ('assistant_delta','assistant_reasoning') ORDER BY sequence DESC LIMIT $3)
        UNION
        (SELECT id,sequence FROM task_events WHERE task_id=$1 AND sequence <= $2 AND kind IN ('user_message','queued_message') ORDER BY sequence DESC LIMIT 32)
        UNION
        (SELECT id,sequence FROM task_events WHERE task_id=$1 AND sequence <= $2 AND kind='plan' ORDER BY sequence DESC LIMIT 64)
        UNION
        (SELECT id,sequence FROM task_events WHERE task_id=$1 AND sequence <= $2 AND kind='preview' ORDER BY sequence DESC LIMIT $4)
        UNION
        (SELECT id,sequence FROM task_events WHERE task_id=$1 AND sequence <= $2 AND kind='completed' ORDER BY sequence DESC LIMIT $4)
      ), sized AS (
        SELECT e.*, octet_length(COALESCE(e.payload_ciphertext::text,'')) AS payload_bytes
        FROM task_events e JOIN candidates c ON c.id=e.id
      ), budgeted AS (
        SELECT *, sum(CASE WHEN payload_bytes <= $5 THEN payload_bytes ELSE 0 END) OVER (ORDER BY CASE WHEN kind IN ('preview','completed') THEN 0 ELSE 1 END, sequence DESC) AS used_bytes FROM sized
      )
      SELECT id,task_id,sequence,kind,left(summary,1024) AS summary,created_at,
        CASE WHEN payload_bytes <= $5 AND used_bytes <= $6 THEN payload_ciphertext ELSE NULL END AS payload_ciphertext,
        (payload_bytes > $5 OR used_bytes > $6) AS omitted,
        EXISTS(SELECT 1 FROM task_events earlier WHERE earlier.task_id=$1 AND earlier.sequence <= $2 AND earlier.kind NOT IN ('assistant_delta','assistant_reasoning') AND NOT EXISTS(SELECT 1 FROM candidates c WHERE c.id=earlier.id)) AS has_earlier
      FROM budgeted ORDER BY sequence ASC`,
      [
        taskId,
        cursor,
        PRESENTATION_EVENT_LIMIT,
        PRESENTATION_RECEIPT_LIMIT,
        EVENT_PAYLOAD_BYTES,
        PRESENTATION_PAYLOAD_BYTES
      ]
    );
    let omittedPayloads = 0;
    const events: TaskEvent[] = [];
    for (const row of rows.rows) {
      if (row.omitted) {
        omittedPayloads++;
        continue;
      }
      const envelope: unknown =
        typeof row.payload_ciphertext === 'string'
          ? JSON.parse(row.payload_ciphertext)
          : row.payload_ciphertext;
      const revealed = revealedTaskEvent(
        String(row.summary),
        envelope
          ? decryptJson(EventEnvelope.parse(envelope), key, `task-event:${taskId}`)
          : undefined
      );
      events.push(
        TaskEvent.parse({
          id: row.id,
          taskId: row.task_id,
          sequence: Number(row.sequence),
          kind: row.kind,
          summary: revealed.summary,
          ...(revealed.payload === undefined ? {} : { payload: revealed.payload }),
          createdAt: new Date(String(row.created_at)).toISOString()
        })
      );
    }
    return {
      events,
      cursor,
      coverage: {
        scope: omittedPayloads || rows.rows.some((row) => row.has_earlier) ? 'recent' : 'complete',
        eventCount: events.length,
        omittedPayloads
      }
    };
  }
}

export const AVAILABILITY_TTL_MS = 10_000;
export class PresentationAvailability {
  readonly #cache = new Map<
    string,
    { expires: number; value: { status: 'ready' | 'unavailable' | 'unknown'; sizeBytes?: number } }
  >();
  readonly #pending = new Map<
    string,
    Promise<{ status: 'ready' | 'unavailable' | 'unknown'; sizeBytes?: number }>
  >();
  get(key: string) {
    const cached = this.#cache.get(key);
    return cached && cached.expires > Date.now() ? cached.value : undefined;
  }
  async check(
    key: string,
    probe: () => Promise<{ status: 'ready' | 'unavailable' | 'unknown'; sizeBytes?: number }>
  ) {
    const cached = this.get(key);
    if (cached) return cached;
    const pending = this.#pending.get(key);
    if (pending) return pending;
    const result = probe()
      .then((value) => {
        this.#cache.delete(key);
        this.#cache.set(key, { value, expires: Date.now() + AVAILABILITY_TTL_MS });
        while (this.#cache.size > 512) this.#cache.delete(this.#cache.keys().next().value!);
        return value;
      })
      .finally(() => this.#pending.delete(key));
    this.#pending.set(key, result);
    return result;
  }
}
