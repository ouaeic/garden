import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '@garden/data';
import { encryptJson } from '@garden/core';
import {
  AVAILABILITY_TTL_MS,
  PRESENTATION_EVENT_LIMIT,
  PRESENTATION_PAYLOAD_BYTES,
  PresentationAvailability,
  TaskEvidenceReader
} from './task-evidence.js';

describe('bounded task evidence reads', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  const key = Buffer.alloc(32, 9);
  beforeAll(async () =>
    database.exec(
      `CREATE TABLE task_events (id TEXT PRIMARY KEY, task_id TEXT, sequence INTEGER, kind TEXT, summary TEXT, payload_ciphertext JSONB, created_at TIMESTAMPTZ DEFAULT NOW());`
    )
  );
  afterAll(async () => database.close());
  const add = async (
    taskId: string,
    values: Array<{ sequence: number; kind: string; payload: unknown }>
  ) => {
    await database.query(
      `INSERT INTO task_events(id,task_id,sequence,kind,summary,payload_ciphertext)
      SELECT id,$1,sequence,kind,'Encrypted event',payload FROM jsonb_to_recordset($2::jsonb) AS r(id TEXT,sequence INT,kind TEXT,payload JSONB)`,
      [
        taskId,
        JSON.stringify(
          values.map((v) => ({
            id: randomUUID(),
            sequence: v.sequence,
            kind: v.kind,
            payload: encryptJson(v.payload, key, `task-event:${taskId}`)
          }))
        )
      ]
    );
  };

  it('keeps historical publication receipts alongside a bounded recent window and reuses decryption until the cursor changes', async () => {
    const task = randomUUID();
    await add(task, [
      { sequence: 1, kind: 'preview', payload: { previewId: 'historic-preview' } },
      { sequence: 2, kind: 'completed', payload: { deliverables: ['project/index.html'] } },
      ...Array.from({ length: PRESENTATION_EVENT_LIMIT + 80 }, (_, i) => ({
        sequence: i + 3,
        kind: 'status',
        payload: { detail: `step ${i}` }
      }))
    ]);
    const reader = new TaskEvidenceReader(database);
    const spy = vi.spyOn(database, 'query');
    const first = await reader.read(task, key);
    expect(first.events.length).toBeGreaterThan(0);
    expect(first.events.length).toBeLessThanOrEqual(PRESENTATION_EVENT_LIMIT + 2);
    expect(first.events[0]?.payload).toEqual({ previewId: 'historic-preview' });
    expect(first.events[1]?.payload).toEqual({ deliverables: ['project/index.html'] });
    expect(first.coverage.scope).toBe('recent');
    const before = spy.mock.calls.length;
    expect(await reader.read(task, key)).toBe(first);
    expect(spy.mock.calls.length - before).toBe(1);
    await add(task, [
      { sequence: first.cursor + 1, kind: 'status', payload: { detail: 'new receipt' } }
    ]);
    const newer = await reader.read(task, key);
    expect(newer.cursor).toBe(first.cursor + 1);
    expect(newer.events.at(-1)?.payload).toEqual({ detail: 'new receipt' });
    spy.mockRestore();
  });

  it('bounds encrypted payload transfer before decryption and marks oversized evidence as omitted', async () => {
    const task = randomUUID();
    await add(task, [
      { sequence: 1, kind: 'preview', payload: { previewId: 'older-than-heavy-activity' } },
      ...Array.from({ length: 40 }, (_, i) => ({
        sequence: i + 2,
        kind: 'status',
        payload: { detail: 'x'.repeat(150_000) }
      })),
      { sequence: 42, kind: 'status', payload: { detail: 'too-large'.repeat(40_000) } }
    ]);
    const evidence = await new TaskEvidenceReader(database).read(task, key);
    expect(evidence.events.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(evidence.events))).toBeLessThan(
      PRESENTATION_PAYLOAD_BYTES
    );
    expect(evidence.coverage.omittedPayloads).toBeGreaterThan(0);
    expect(evidence.coverage.scope).toBe('recent');
    expect(evidence.events.some((event) => event.sequence === 42)).toBe(false);
    expect(evidence.events[0]?.payload).toEqual({ previewId: 'older-than-heavy-activity' });
    expect((await new TaskEvidenceReader(database).read('different-task', key)).events).toEqual([]);
  });

  it('coalesces observations and refreshes after expiry instead of probing on each UI event', async () => {
    const cache = new PresentationAvailability();
    const probe = vi.fn(async () => ({ status: 'ready' as const }));
    await Promise.all([cache.check('preview:a', probe), cache.check('preview:a', probe)]);
    expect(probe).toHaveBeenCalledTimes(1);
    await cache.check('preview:a', probe);
    expect(probe).toHaveBeenCalledTimes(1);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + AVAILABILITY_TTL_MS + 1);
    try {
      const next = await cache.check('preview:a', async () => ({ status: 'unavailable' as const }));
      expect(next.status).toBe('unavailable');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('rejects malformed envelopes and ciphertext copied from a different task', async () => {
    const malformed = randomUUID(),
      copied = randomUUID();
    for (const [taskId, payload] of [
      [malformed, { v: 1, iv: 42, tag: 'invalid', ciphertext: 'invalid' }],
      [copied, encryptJson({ previewId: 'not-this-task' }, key, 'task-event:another-task')]
    ] as const) {
      await database.query(
        `INSERT INTO task_events(id,task_id,sequence,kind,summary,payload_ciphertext) VALUES($1,$2,1,'preview','Encrypted event',$3::jsonb)`,
        [randomUUID(), taskId, JSON.stringify(payload)]
      );
    }
    await expect(new TaskEvidenceReader(database).read(malformed, key)).rejects.toThrow();
    await expect(new TaskEvidenceReader(database).read(copied, key)).rejects.toThrow(
      'Encrypted envelope context mismatch'
    );
  });
});
