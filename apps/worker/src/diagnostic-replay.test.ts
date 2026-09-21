import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DIAGNOSTIC_EMPTY_HASH,
  diagnosticPlainHash,
  type PrivateDiagnosticBody,
  type PrivateDiagnosticKind,
  withPrivateDiagnostics,
  type PrivateDiagnosticSink
} from '@athanor/core';
import { DIAGNOSTIC_CAPTURE_BYTES } from '@athanor/contracts';
import { PrivateDecisionReplay } from './diagnostic-replay.js';
import { approvalRequirement } from './approval-policy.js';
import { requestDerivationBreach } from './turn-control.js';

const time = '2026-09-21T10:00:00.000Z';
function document(events: { kind: PrivateDiagnosticKind; data: unknown }[], unfinished = false) {
  const id = randomUUID(),
    segmentId = randomUUID();
  const bodies: PrivateDiagnosticBody[] = [
    { version: 1, kind: 'segment_start', at: time, data: { segmentId, value: {} } },
    ...events.map((row) => ({
      version: 1 as const,
      kind: row.kind,
      at: time,
      data: { segmentId, value: row.data }
    })),
    ...(!unfinished
      ? [
          {
            version: 1 as const,
            kind: 'segment_end' as const,
            at: time,
            data: { segmentId, value: {} }
          }
        ]
      : [])
  ];
  let hash = DIAGNOSTIC_EMPTY_HASH;
  const records = bodies.map((body, i) => {
    const previousHash = hash;
    hash = diagnosticPlainHash(i + 1, hash, body);
    return { type: 'record', sequence: i + 1, previousHash, hash, body };
  });
  return [
    {
      type: 'private_capture',
      format: 'garden-private-diagnostic',
      version: 1,
      id,
      taskId: randomUUID(),
      workspaceId: randomUUID(),
      through: records.length,
      status: {
        id,
        state: 'stopped',
        startedAt: time,
        stoppedAt: time,
        records: records.length,
        bytes: 100,
        limitBytes: DIAGNOSTIC_CAPTURE_BYTES,
        reason: null
      }
    },
    ...records,
    { type: 'footer', records: records.length, hash, complete: true }
  ];
}
const play = (rows: unknown[]) => {
  const replay = new PrivateDecisionReplay();
  rows.forEach((row) => replay.accept(row));
  return replay.result();
};
afterEach(() => vi.restoreAllMocks());
describe('private decision replay', () => {
  it('re-evaluates the production boundaries with their captured time and no network', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No network in replay'));
    const events: { kind: PrivateDiagnosticKind; data: unknown }[] = [];
    const sink: PrivateDiagnosticSink = {
      record: async (kind, data) => {
        events.push({ kind, data });
      }
    };
    await withPrivateDiagnostics(sink, async () => {
      approvalRequirement(
        'shell',
        { executable: 'python3', args: ['-c', 'print(1)'] },
        'balanced',
        {},
        new Date(time)
      );
      requestDerivationBreach({
        prepared: [{ role: 'user', content: 'Inspect' }],
        rederived: [{ role: 'user', content: 'Inspect' }],
        sent: [],
        entitled: [],
        reservedTokens: 0,
        reservedTokensOfSent: 0
      });
    });
    expect(events).toHaveLength(2);
    expect(play(document(events))).toMatchObject({
      complete: true,
      semantic: {
        approvalDecisions: 1,
        requestDerivations: 1,
        divergences: []
      },
      providerCalls: 0,
      commandsRun: 0
    });
    expect(network).not.toHaveBeenCalled();
    const changed = structuredClone(events);
    (changed[0]!.data as { result: unknown }).result = { sideEffect: 'made_up' };
    expect(play(document(changed)).semantic.divergences).toEqual([
      { sequence: 2, boundary: 'approval_decision' }
    ]);
  });
  it('validates retry and interrupted outcome order without treating failed inference as missing evidence', () => {
    const id = randomUUID();
    const events: { kind: PrivateDiagnosticKind; data: unknown }[] = [
      {
        kind: 'model_request',
        data: {
          id,
          request: {
            model: 'test',
            messages: [{ role: 'user', content: 'Inspect' }],
            tools: [],
            temperature: 0.2
          }
        }
      },
      { kind: 'model_attempt', data: { id, attempt: 1 } },
      { kind: 'model_outcome', data: { id, attempt: 1, outcome: 'failed' } },
      { kind: 'model_attempt', data: { id, attempt: 2 } },
      {
        kind: 'model_outcome',
        data: {
          id,
          attempt: 2,
          outcome: 'interrupted',
          response: {
            text: 'partial',
            toolCalls: [],
            finishReason: 'error',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            metadata: { model: 'test', provider: 'test' }
          }
        }
      },
      { kind: 'model_end', data: { id, attempts: 2, outcome: 'interrupted' } }
    ];
    expect(play(document(events)).complete).toBe(true);
    expect(play(document(events.slice(0, -1))).complete).toBe(false);
    expect(() => play(document(events.filter((_, index) => index !== 1)))).toThrow('ordering');
    expect(() =>
      play(document([...events.slice(0, -1), { kind: 'model_attempt', data: { id, attempt: 3 } }]))
    ).toThrow('ordering');
  });
  it('rejects corruption, unsupported versions, missing footer, missing segment end and empty evidence', () => {
    const rows = document([]);
    expect(play(rows.slice(0, -1)).complete).toBe(false);
    expect(play(document([], true)).complete).toBe(false);
    const corrupt = structuredClone(rows);
    (corrupt[1] as { hash: string }).hash = 'f'.repeat(64);
    expect(() => play(corrupt)).toThrow('hash mismatch');
    expect(() => play([{ ...rows[0], version: 2 }])).toThrow();
    expect(play([]).complete).toBe(false);
    expect(() => play([...rows, rows[1]])).toThrow('after diagnostic footer');
  });
});
