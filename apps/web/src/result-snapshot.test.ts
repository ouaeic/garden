import type { TaskEvent, TaskResult } from '@garden/contracts';
import { describe, expect, it } from 'vitest';
import { resultSnapshot } from './result-snapshot';
const result: TaskResult = {
  id: 'preview',
  kind: 'preview',
  title: 'Game',
  url: 'https://garden.test/__garden/preview/owned/index.html',
  status: 'ready',
  accessPath: '/v1/previews/owned/access',
  downloadUrl: null,
  evidenceEventIds: ['receipt']
};
const snapshot = {
  id: 'observed',
  taskId: 'task',
  sequence: 3,
  kind: 'tool_result',
  summary: 'Checked',
  createdAt: '2026-09-06T00:00:00Z',
  payload: {
    result: { url: result.url + '?access=private', holder: 'agent', screenshotBase64: '/9j/AA==' }
  }
} as TaskEvent;
describe('result snapshots', () => {
  it('uses captured raster evidence from the exact registered preview without exposing its access query', () => {
    expect(resultSnapshot(result, [snapshot], 'task')).toEqual({
      src: 'data:image/jpeg;base64,/9j/AA==',
      eventId: 'observed',
      createdAt: snapshot.createdAt
    });
  });
  it('rejects another task, page, private-input screen or non-raster content', () => {
    expect(resultSnapshot(result, [{ ...snapshot, taskId: 'other' }], 'task')).toBeNull();
    for (const changes of [
      { url: 'https://untrusted.test/index.html' },
      { url: 'https://garden.test/__garden/preview/other/index.html' },
      { holder: 'secure_input' },
      { screenshotBase64: 'PHN2Zz4=' }
    ]) {
      const changed = {
        ...snapshot,
        payload: { result: { ...(snapshot.payload as { result: object }).result, ...changes } }
      };
      expect(resultSnapshot(result, [changed], 'task')).toBeNull();
    }
  });
});
