import { describe, expect, it } from 'vitest';
import type { TaskEvent, ComputationCell } from '@garden/contracts';
import { computationHistory } from './computation-history';
const sessionId = 'kernel-example';
const cell: ComputationCell = {
  cellId: 'cell-1',
  state: 'completed',
  startedAt: '2026-09-13T00:00:00Z',
  stdout: '2\n',
  stderr: '',
  result: 2,
  artifacts: []
};
const event = (sequence: number, kind: TaskEvent['kind'], payload: unknown): TaskEvent => ({
  id: `event-${sequence}`,
  taskId: 'task',
  sequence,
  kind,
  summary: '',
  payload,
  createdAt: '2026-09-13T00:00:00Z'
});
const start = (sequence = 1, code = '1+1', call = 'call-1') =>
  event(sequence, 'tool_started', {
    toolCallId: call,
    tool: 'process',
    arguments: { action: 'compute', sessionId, options: { action: 'cell', cellId: 'cell-1', code } }
  });
const result = (sequence = 2, value = cell, call = 'call-1', session = sessionId) =>
  event(sequence, 'tool_result', {
    toolCallId: call,
    result: { sessionId: session, latestCell: value }
  });
describe('computation execution history from encrypted transcript events', () => {
  it('joins code and native receipts by call and cell identity across unordered overlapping pages', () => {
    const entries = computationHistory([result(), start(), result()], sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: '1+1', receipt: cell, sequence: 1 });
  });
  it('preserves valid input records while refusing malformed untrusted manifests', () => {
    const manifest: NonNullable<ComputationCell['manifest']> = {
      format: 'garden-computation-manifest-1',
      capturedAt: '2026-09-13T00:00:00Z',
      requestSha256: 'a'.repeat(64),
      sourceSha256: 'b'.repeat(64),
      runtime: { version: '3.14.2', platform: 'linux', architecture: 'x86_64' },
      inputs: [
        { path: 'workspace/input.csv', status: 'hashed', bytes: 20, sha256: 'c'.repeat(64) }
      ],
      coverage: 'declared_inputs_before_execution'
    };
    expect(
      computationHistory([result(2, { ...cell, manifest })], sessionId)[0]?.receipt?.manifest
    ).toEqual(manifest);
    for (const invalid of [
      { ...manifest, inputs: null },
      { ...manifest, runtime: { version: { html: 'bad' } } },
      { ...manifest, inputs: [{ path: 'x', status: 'unavailable', reason: { html: 'bad' } }] },
      { ...manifest, inputs: [{ path: 'x', status: 'hashed', bytes: -1, sha256: 'wrong' }] }
    ]) {
      const malformed = event(2, 'tool_result', {
        toolCallId: 'x',
        result: { sessionId, latestCell: { ...cell, manifest: invalid } }
      });
      expect(computationHistory([malformed], sessionId)).toEqual([]);
    }
  });
  it('a status read updates the receipt without inventing source', () => {
    const entries = computationHistory([result(3, cell, 'poll')], sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBeUndefined();
    expect(entries[0]?.action).toBe('unknown');
  });
  it('does not promote submission or a tool error into completed execution', () => {
    const entries = computationHistory(
      [start(), event(2, 'error', { toolCallId: 'call-1', message: 'Timed out' })],
      sessionId
    );
    expect(entries[0]?.receipt).toBeUndefined();
    expect(entries[0]?.errors).toEqual(['Timed out']);
  });
  it('keeps the original accepted source when a changed-code retry is rejected', () => {
    const entries = computationHistory(
      [
        start(),
        result(),
        start(3, '99+99', 'retry'),
        event(4, 'error', { toolCallId: 'retry', message: 'Cell ID conflict' })
      ],
      sessionId
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe('1+1');
    expect(entries[0]?.receipt?.result).toBe(2);
    expect(entries[0]?.errors).toEqual(['Cell ID conflict']);
  });
  it('follows a later completed status receipt after an asynchronous cell', () => {
    const entries = computationHistory(
      [
        start(),
        result(2, { ...cell, state: 'running', stdout: '', result: undefined }),
        result(5, cell, 'poll')
      ],
      sessionId
    );
    expect(entries[0]?.source).toBe('1+1');
    expect(entries[0]?.receipt?.state).toBe('completed');
  });
  it('keeps sibling sessions and unrelated tools out of the history', () => {
    expect(
      computationHistory(
        [
          result(2, cell, 'x', 'other'),
          event(1, 'tool_started', {
            toolCallId: 'x',
            tool: 'shell',
            arguments: { action: 'compute', sessionId, options: { action: 'cell', code: 'no' } }
          })
        ],
        sessionId
      )
    ).toEqual([]);
  });
  it('joins a native generated cell ID without duplicating the provisional submission', () => {
    const submission = event(1, 'tool_started', {
      toolCallId: 'call-1',
      tool: 'process',
      arguments: { action: 'compute', options: { sessionId, action: 'cell', code: '1+1' } }
    });
    expect(computationHistory([submission, result()], sessionId)).toMatchObject([
      { cellId: 'cell-1', source: '1+1', receipt: cell }
    ]);
  });
  it('rejects malformed display data and records checkpoint paths separately from code', () => {
    const checkpoint = event(1, 'tool_started', {
      toolCallId: 'call-1',
      tool: 'process',
      arguments: {
        action: 'compute',
        sessionId,
        options: { action: 'checkpoint', cellId: 'cell-1', path: 'workspace/state.json' }
      }
    });
    const malformed = event(2, 'tool_result', {
      toolCallId: 'call-1',
      result: { sessionId, latestCell: { ...cell, stdout: { html: 'bad' } } }
    });
    const entries = computationHistory([checkpoint, malformed], sessionId);
    expect(entries[0]).toMatchObject({ action: 'checkpoint', path: 'workspace/state.json' });
    expect(entries[0]?.receipt).toBeUndefined();
  });
  it('does not attribute a mismatched native receipt to submitted code', () => {
    const entries = computationHistory(
      [start(), result(2, { ...cell, cellId: 'wrong-cell' })],
      sessionId
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.receipt).toBeUndefined();
  });
  it('attributes the accepted retry when the original submission had no receipt', () => {
    const entries = computationHistory(
      [
        start(),
        event(2, 'error', { toolCallId: 'call-1', message: 'Not started' }),
        start(3, '2*2', 'retry'),
        result(4, { ...cell, result: 4 }, 'retry')
      ],
      sessionId
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: '2*2',
      receipt: { result: 4 },
      errors: ['Not started']
    });
  });
});
