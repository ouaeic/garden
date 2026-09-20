import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computationWaitObservation } from './computation-waits.js';

const owner = { id: randomUUID(), workspaceId: randomUUID() };
const sessionId = `kernel-${randomUUID()}`;
const snapshot = {
  sessionId,
  workspaceId: owner.workspaceId,
  taskId: owner.id,
  createdAt: '2026-09-20T10:00:00.000Z',
  state: 'busy',
  latestCell: {
    cellId: 'analysis',
    startedAt: '2026-09-20T10:01:00.000Z',
    state: 'running'
  }
};

describe('analysis wait metadata boundary', () => {
  it.each([
    ['busy', 'running'],
    ['expired', 'timed_out'],
    ['stopped', 'stopped'],
    ['lost', 'interrupted'],
    ['interrupted', 'interrupted']
  ])('maps a running cell in a %s interpreter to %s', (state, status) => {
    expect(computationWaitObservation({ ...snapshot, state }, owner, sessionId)).toMatchObject({
      status,
      runtimeState: state,
      cellId: 'analysis',
      interpreterCreatedAt: snapshot.createdAt
    });
  });

  it.each(['sessionId', 'workspaceId', 'taskId'])(
    'refuses a different %s before recording scheduling metadata',
    (field) => {
      const foreign = field === 'sessionId' ? `kernel-${randomUUID()}` : randomUUID();
      expect(() =>
        computationWaitObservation({ ...snapshot, [field]: foreign }, owner, sessionId)
      ).toThrow('another task or workspace');
    }
  );

  it('refuses an impossible idle interpreter with a running cell', () => {
    expect(() =>
      computationWaitObservation({ ...snapshot, state: 'idle' }, owner, sessionId)
    ).toThrow('inconsistent runtime state');
  });

  it('keeps a completed receipt after its interpreter expires', () => {
    expect(
      computationWaitObservation(
        {
          ...snapshot,
          state: 'expired',
          latestCell: { ...snapshot.latestCell, state: 'completed' }
        },
        owner,
        sessionId
      )
    ).toMatchObject({ status: 'completed', runtimeState: 'expired' });
  });
});
