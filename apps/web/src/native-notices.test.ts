import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@garden/contracts';
import { createTaskNotifier } from './native-notices.js';
import { get } from './client.js';
import {
  nativeNotificationPermission,
  notifyNative,
  requestNativeNotifications
} from './native.js';

vi.mock('./native.js', () => ({
  nativeNotificationPermission: vi.fn(),
  notifyNative: vi.fn(),
  requestNativeNotifications: vi.fn()
}));
vi.mock('./client.js', () => ({ get: vi.fn() }));

const defaultSettings = {
  kinds: { approvalRequired: true, taskFinished: true, agentMessage: true },
  quietHoursStart: null as string | null,
  quietHoursEnd: null as string | null,
  quietHoursAllowApprovals: true,
  timeZone: 'UTC'
};
const load = vi.mocked(get);

const task = (id: string, status: Task['status']) => ({ id, title: `Work ${id}`, status });
const permission = vi.mocked(nativeNotificationPermission);
const notify = vi.mocked(notifyNative);
beforeEach(() => {
  vi.resetAllMocks();
  permission.mockResolvedValue(true);
  notify.mockResolvedValue(undefined);
  load.mockImplementation(async (path) =>
    path === '/v1/notifications/settings'
      ? defaultSettings
      : { events: [{ kind: 'approval_requested' }] }
  );
});
afterEach(() => vi.useRealTimers());

describe('native task transition notices', () => {
  it('waits for media delivery before announcing completed work', async () => {
    const notifier = createTaskNotifier();
    await notifier.update([task('video', 'running')]);
    await notifier.update([{ ...task('video', 'completed'), deliveryStatus: 'pending' }]);
    expect(notify).not.toHaveBeenCalled();
    await notifier.update([{ ...task('video', 'completed'), deliveryStatus: 'ready' }]);
    expect(notify.mock.calls).toEqual([['Work complete', 'Work video']]);
    await notifier.update([{ ...task('video', 'completed'), deliveryStatus: 'ready' }]);
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it('reads saved category preferences and suppresses disabled categories', async () => {
    load.mockImplementation(async (path) =>
      path === '/v1/notifications/settings'
        ? {
            ...defaultSettings,
            kinds: { approvalRequired: false, taskFinished: false, agentMessage: false }
          }
        : {
            events: [
              { kind: path.includes('/question/') ? 'question_asked' : 'approval_requested' }
            ]
          }
    );
    const notifier = createTaskNotifier();
    await notifier.update([
      task('approval', 'running'),
      task('question', 'running'),
      task('finished', 'running')
    ]);
    await notifier.update([
      task('approval', 'awaiting_user'),
      task('question', 'awaiting_user'),
      task('finished', 'completed')
    ]);
    expect(load).toHaveBeenCalledWith('/v1/notifications/settings');
    expect(notify).not.toHaveBeenCalled();
  });
  it('uses the owner timezone and approval exception without ringing for questions in quiet hours', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T21:30:00Z'));
    load.mockImplementation(async (path) =>
      path === '/v1/notifications/settings'
        ? {
            ...defaultSettings,
            quietHoursStart: '22:00',
            quietHoursEnd: '07:00',
            timeZone: 'Africa/Johannesburg'
          }
        : {
            events: [
              { kind: path.includes('/question/') ? 'question_asked' : 'approval_requested' },
              { kind: 'status' }
            ]
          }
    );
    const notifier = createTaskNotifier();
    await notifier.update([
      task('approval', 'running'),
      task('question', 'running'),
      task('finished', 'running')
    ]);
    await notifier.update([
      task('approval', 'awaiting_user'),
      task('question', 'awaiting_user'),
      task('finished', 'failed')
    ]);
    expect(notify.mock.calls).toEqual([['Work needs you', 'Work approval']]);
    expect(load).toHaveBeenCalledWith('/v1/tasks/question/events?limit=20&page=1');
    expect(requestNativeNotifications).not.toHaveBeenCalled();
  });
  it('honors a disabled approval exception and exact quiet-hour end boundaries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T22:00:00Z'));
    load.mockImplementation(async (path) =>
      path === '/v1/notifications/settings'
        ? {
            ...defaultSettings,
            quietHoursStart: '22:00',
            quietHoursEnd: '07:00',
            quietHoursAllowApprovals: false
          }
        : { events: [{ kind: 'approval_requested' }] }
    );
    const notifier = createTaskNotifier();
    await notifier.update([task('a', 'running')]);
    await notifier.update([task('a', 'awaiting_user')]);
    expect(notify).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-09-07T07:00:00Z'));
    await notifier.update([task('a', 'running')]);
    await notifier.update([task('a', 'completed')]);
    expect(notify.mock.calls).toEqual([['Work complete', 'Work a']]);
  });
  it('treats an equal quiet-hour window as disabled and suppresses unknown or resolved waiting reasons', async () => {
    load.mockImplementation(async (path) =>
      path === '/v1/notifications/settings'
        ? { ...defaultSettings, quietHoursStart: '07:00', quietHoursEnd: '07:00' }
        : { events: [{ kind: 'approval_requested' }, { kind: 'approval_resolved' }] }
    );
    const notifier = createTaskNotifier();
    await notifier.update([task('done', 'running'), task('answered', 'running')]);
    await notifier.update([task('done', 'completed'), task('answered', 'awaiting_user')]);
    expect(notify.mock.calls).toEqual([['Work complete', 'Work done']]);
  });
  it('does not deliver when the saved notification policy cannot be read', async () => {
    load.mockRejectedValue(new Error('Server offline'));
    const notifier = createTaskNotifier();
    await notifier.update([task('a', 'running')]);
    await expect(notifier.update([task('a', 'completed')])).resolves.toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });
  it('silently baselines initial snapshots and newly discovered historic tasks', async () => {
    const notifier = createTaskNotifier();
    await notifier.update([]);
    await notifier.update([task('old', 'completed'), task('waiting', 'awaiting_user')]);
    await notifier.update([
      task('old', 'completed'),
      task('waiting', 'awaiting_user'),
      task('archived', 'failed')
    ]);
    expect(notify).not.toHaveBeenCalled();
    expect(permission).not.toHaveBeenCalled();
  });
  it('announces meaningful observed transitions once and permits a new run to finish again', async () => {
    const notifier = createTaskNotifier();
    await notifier.update([task('a', 'running'), task('b', 'queued'), task('c', 'planning')]);
    await notifier.update([
      task('a', 'awaiting_user'),
      task('b', 'completed'),
      task('c', 'failed')
    ]);
    await notifier.update([
      task('a', 'awaiting_user'),
      task('b', 'completed'),
      task('c', 'failed')
    ]);
    expect(notify.mock.calls).toEqual([
      ['Work needs you', 'Work a'],
      ['Work complete', 'Work b'],
      ['Work needs attention', 'Work c']
    ]);
    await notifier.update([task('b', 'queued')]);
    await notifier.update([task('b', 'running')]);
    await notifier.update([task('b', 'completed')]);
    expect(notify).toHaveBeenCalledTimes(4);
    expect(requestNativeNotifications).not.toHaveBeenCalled();
  });
  it('ignores ongoing, paused, resource and cancelled statuses', async () => {
    const notifier = createTaskNotifier();
    await notifier.update([task('a', 'draft')]);
    const statuses: Task['status'][] = [
      'queued',
      'planning',
      'running',
      'awaiting_resource',
      'paused',
      'cancelled'
    ];
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) await notifier.update([task('a', status)]);
    expect(notify).not.toHaveBeenCalled();
    expect(permission).not.toHaveBeenCalled();
  });
  it('ignores an older task snapshot returned after a newer refresh', async () => {
    const notifier = createTaskNotifier();
    await notifier.update([{ ...task('a', 'running'), updatedAt: '2026-09-06T12:02:00Z' }]);
    await notifier.update([{ ...task('a', 'awaiting_user'), updatedAt: '2026-09-06T12:01:00Z' }]);
    await notifier.update([{ ...task('a', 'running'), updatedAt: '2026-09-06T12:04:00Z' }]);
    await notifier.update([{ ...task('a', 'completed'), updatedAt: '2026-09-06T12:03:00Z' }]);
    expect(notify).not.toHaveBeenCalled();
    await notifier.update([{ ...task('a', 'completed'), updatedAt: '2026-09-06T12:05:00Z' }]);
    expect(notify.mock.calls).toEqual([['Work complete', 'Work a']]);
  });
  it('never prompts or replays a suppressed transition when notification permission changes', async () => {
    permission.mockResolvedValue(false);
    const notifier = createTaskNotifier();
    await notifier.update([task('a', 'running')]);
    await notifier.update([task('a', 'completed')]);
    permission.mockResolvedValue(true);
    await notifier.update([task('a', 'completed')]);
    expect(notify).not.toHaveBeenCalled();
    expect(permission).toHaveBeenCalledOnce();
    expect(requestNativeNotifications).not.toHaveBeenCalled();
  });
  it('drops stale pending notices and deduplicates concurrent refreshes', async () => {
    let resolvePermission!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      resolvePermission = resolve;
    });
    permission.mockReturnValueOnce(pending);
    const notifier = createTaskNotifier();
    await notifier.update([task('a', 'running')]);
    const waiting = notifier.update([task('a', 'awaiting_user')]);
    await Promise.resolve();
    expect(permission).toHaveBeenCalledOnce();
    const completed = notifier.update([task('a', 'completed')]);
    const duplicate = notifier.update([task('a', 'completed')]);
    resolvePermission(true);
    await Promise.all([waiting, completed, duplicate]);
    expect(notify.mock.calls).toEqual([['Work complete', 'Work a']]);
  });
  it('contains OS delivery and permission failures without retrying an uncertain notice', async () => {
    notify.mockRejectedValueOnce(new Error('OS channel unavailable'));
    const notifier = createTaskNotifier();
    await notifier.update([task('a', 'running'), task('b', 'running')]);
    await expect(
      notifier.update([task('a', 'completed'), task('b', 'failed')])
    ).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(2);
    await notifier.update([task('a', 'completed'), task('b', 'failed')]);
    expect(notify).toHaveBeenCalledTimes(2);
    permission.mockRejectedValueOnce(new Error('Permission API unavailable'));
    await notifier.update([task('a', 'running')]);
    await expect(notifier.update([task('a', 'completed')])).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(requestNativeNotifications).not.toHaveBeenCalled();
  });
});
