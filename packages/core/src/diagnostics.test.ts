import { describe, expect, it } from 'vitest';
import { createDiagnosticProjector, DiagnosticReplay } from './diagnostics.js';

const task = {
  id: 'private-task',
  modelId: 'private-model',
  status: 'awaiting_user',
  securityMode: 'autonomous',
  spentUsd: 0.04,
  attempt: 1
};
const at = '2026-09-17T00:00:00.000Z';
const projector = createDiagnosticProjector(Buffer.alloc(32, 7));
const event = (sequence: number, kind: string, payload: unknown) =>
  projector.event({ sequence, kind, createdAt: at }, payload);
const footer = (events: number, complete = true, unreadableEvents = 0, lastSequence = events) => ({
  type: 'footer',
  events,
  complete,
  unreadableEvents,
  lastSequence
});

describe('content-omitting operational diagnostics', () => {
  it('preserves a failed command, approval wait, usage and visible message shape without content', () => {
    const canary = 'UNIQUE_PRIVATE_CONTENT_credential_and_document';
    const rows = [
      projector.header(
        task,
        {
          messages: [
            { role: 'user', content: canary },
            { role: 'tool', content: { result: canary } }
          ],
          step: 4,
          turn: 1,
          preparedInputTokens: 241,
          pending: { toolCall: { id: 'second', name: 'shell', arguments: { stdin: canary } } }
        },
        5,
        at
      ),
      event(1, 'tool_started', {
        toolCallId: 'first',
        tool: 'shell',
        arguments: { args: [canary] }
      }),
      event(2, 'tool_result', { toolCallId: 'first', result: { exitCode: 1, stderr: canary } }),
      event(3, 'approval_requested', {
        approvalId: 'approval',
        sideEffect: 'external_reversible',
        preview: canary
      }),
      event(4, 'cost', {
        costUsd: 0.04,
        usage: { inputTokens: 200, outputTokens: 5 },
        context: { estimatedInputTokens: 241 },
        metadata: { key: canary }
      }),
      event(5, 'warning', { message: canary }),
      footer(5)
    ];
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain(task.id);
    expect(serialized).not.toContain(task.modelId);
    const replay = new DiagnosticReplay();
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((row) => replay.accept(row));
    expect(replay.result()).toMatchObject({
      providerCalls: 0,
      commandsRun: 0,
      complete: true,
      waiting: 'approval',
      unfinishedTools: 0,
      unresolvedApprovals: 1,
      failedEvents: 1,
      lastFailureSequence: 2,
      recordedCostUsd: 0.04
    });
    expect(rows[0]).toMatchObject({
      checkpoint: {
        pendingTool: { category: 'command' },
        messages: [{ role: 'user', bytes: canary.length + 2 }, { role: 'tool' }]
      }
    });
  });
  it('isolates private-input handoff and correlates references only inside one export', () => {
    const state = {
      pending: { handoffOnly: true, toolCall: { id: 'one', name: 'browser_act' } },
      messages: []
    };
    expect(projector.header(task, state, 0, at)).toMatchObject({
      checkpoint: { waiting: 'private_input' }
    });
    expect(createDiagnosticProjector().fingerprint('one')).not.toBe(
      createDiagnosticProjector().fingerprint('one')
    );
    expect(event(1, 'tool_started', { toolCallId: 'one', tool: 'browser_act' })).toMatchObject({
      tool: { reference: projector.fingerprint('one'), category: 'browser' }
    });
  });
  it('reports corrupt records, gaps and truncated exports instead of certifying complete history', () => {
    const replay = new DiagnosticReplay();
    replay.accept(projector.header(task, undefined, 3, at));
    replay.accept(projector.event({ sequence: 2, kind: 'error', createdAt: at }, undefined, true));
    expect(() => replay.accept(footer(1, true, 1, 2))).toThrow('footer');
    replay.accept(footer(1, false, 1, 2));
    expect(replay.result()).toMatchObject({
      complete: false,
      readable: false,
      missingEvents: 2,
      unreadableEvents: 1
    });
    expect(() => replay.accept(event(3, 'notice', {}))).toThrow('footer');
  });
  it('rejects invalid ordering, trailing content and missing footer', () => {
    const replay = new DiagnosticReplay();
    expect(() => replay.accept(event(1, 'notice', {}))).toThrow('header');
    replay.accept(projector.header(task, {}, 1, at));
    expect(() => replay.accept(projector.header(task, {}, 1, at))).toThrow('header');
    replay.accept(event(1, 'notice', {}));
    expect(() => replay.accept(event(1, 'notice', {}))).toThrow('order');
    expect(() => replay.result()).toThrow('incomplete');
    expect(() => replay.accept({ ...footer(1), private: 'canary' })).toThrow();
    replay.accept(footer(1));
    expect(replay.result().complete).toBe(true);
  });
  it('bounds message metadata and refuses content disguised as counters or enums', () => {
    const header = projector.header(
      task,
      { messages: Array.from({ length: 2001 }, () => ({ role: 'user', content: 'secret' })) },
      1,
      at
    );
    expect(header).toMatchObject({ checkpoint: { messagesOmitted: 1 } });
    if (header.type !== 'header') throw new Error('header required');
    expect(header.checkpoint.messages).toHaveLength(2000);
    const row = event(1, 'tool_result', {
      status: 'secret',
      tool: 'secret',
      toolCallId: 'id',
      result: { exitCode: 'secret', passed: 'secret', status: 'secret' },
      usage: { inputTokens: NaN, outputTokens: 'secret' },
      costUsd: -1
    });
    expect(row).not.toHaveProperty('metrics');
    expect(row).not.toHaveProperty('result');
    expect(row).not.toHaveProperty('status');
  });
  it('closes observed approval and tool lifecycles without counting them as unresolved', () => {
    const replay = new DiagnosticReplay();
    replay.accept(projector.header(task, {}, 4, at));
    replay.accept(event(1, 'approval_requested', { approvalId: 'a' }));
    replay.accept(event(2, 'approval_resolved', { approvalId: 'a', decision: 'approved' }));
    replay.accept(event(3, 'tool_started', { toolCallId: 'b', tool: 'file_read' }));
    replay.accept(event(4, 'tool_result', { toolCallId: 'b', result: { exitCode: 0 } }));
    replay.accept(footer(4));
    expect(replay.result()).toMatchObject({
      unfinishedTools: 0,
      unresolvedApprovals: 0,
      failedEvents: 0
    });
  });
});
