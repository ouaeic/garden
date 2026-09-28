import type { Task } from '@garden/contracts';
import { nativeNotificationPermission, notifyNative } from './native.js';
import { get } from './client.js';

type NoticeTask = Pick<Task, 'id' | 'title' | 'status'> &
  Partial<Pick<Task, 'updatedAt' | 'deliveryStatus'>>;
const noticeTitles = {
  awaiting_user: 'Work needs you',
  failed: 'Work needs attention',
  completed: 'Work complete'
} as const;

interface NotificationSettings {
  kinds: { approvalRequired: boolean; taskFinished: boolean; agentMessage: boolean };
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietHoursAllowApprovals: boolean;
  timeZone: string;
}
type NoticeKind = keyof NotificationSettings['kinds'];

const inQuietHours = (settings: NotificationSettings): boolean => {
  if (!settings.quietHoursStart || !settings.quietHoursEnd) return false;
  const minutes = (clock: string) => {
    const [hour, minute] = clock.split(':').map(Number);
    return (hour ?? 0) * 60 + (minute ?? 0);
  };
  const start = minutes(settings.quietHoursStart);
  const end = minutes(settings.quietHoursEnd);
  if (start === end) return false;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: settings.timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date());
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
    const current = hour * 60 + minute;
    return start < end ? current >= start && current < end : current >= start || current < end;
  } catch {
    return false;
  }
};

async function noticeKind(task: NoticeTask): Promise<NoticeKind | null> {
  if (task.status === 'completed' || task.status === 'failed') return 'taskFinished';
  const page = await get<{ events: { kind: string }[] }>(
    `/v1/tasks/${encodeURIComponent(task.id)}/events?limit=20&page=1`
  );
  const reason = [...page.events]
    .reverse()
    .find((event) =>
      ['approval_requested', 'approval_resolved', 'question_asked', 'user_message'].includes(
        event.kind
      )
    );
  if (reason?.kind === 'approval_requested') return 'approvalRequired';
  if (reason?.kind === 'question_asked') return 'agentMessage';
  return null;
}

export interface TaskNotifier {
  update(tasks: readonly NoticeTask[]): Promise<void>;
}

/** Snapshots establish observation; only a subsequent status change can produce a notice. */
export function createTaskNotifier(): TaskNotifier {
  const observed = new Map<string, NoticeTask>();
  let delivery: Promise<void> = Promise.resolve();
  return {
    update(tasks) {
      const changed: NoticeTask[] = [];
      for (const task of tasks) {
        const previous = observed.get(task.id);
        if (
          previous?.updatedAt &&
          task.updatedAt &&
          Date.parse(task.updatedAt) < Date.parse(previous.updatedAt)
        )
          continue;
        if (previous?.status === task.status && previous?.deliveryStatus === task.deliveryStatus) {
          previous.title = task.title;
          if (task.updatedAt) previous.updatedAt = task.updatedAt;
          continue;
        }
        const current = {
          id: task.id,
          title: task.title,
          status: task.status,
          deliveryStatus: task.deliveryStatus,
          ...(task.updatedAt ? { updatedAt: task.updatedAt } : {})
        };
        observed.set(task.id, current);
        if (previous && current.status in noticeTitles && current.deliveryStatus !== 'pending')
          changed.push(current);
      }
      if (!changed.length) return delivery;
      delivery = delivery
        .then(async () => {
          if (!(await nativeNotificationPermission())) return;
          const settings = await get<NotificationSettings>('/v1/notifications/settings');
          for (const task of changed) {
            // A newer snapshot may resolve a decision while the OS permission check is pending.
            if (observed.get(task.id) !== task) continue;
            try {
              const kind = await noticeKind(task);
              if (!kind || settings.kinds[kind] !== true) continue;
              if (
                inQuietHours(settings) &&
                !(kind === 'approvalRequired' && settings.quietHoursAllowApprovals)
              )
                continue;
              if (observed.get(task.id) !== task) continue;
              const title =
                task.deliveryStatus === 'incomplete'
                  ? 'Delivery needs attention'
                  : noticeTitles[task.status as keyof typeof noticeTitles];
              await notifyNative(title, task.title.trim() || 'Your garden work');
            } catch {
              // Notifications cannot prevent task refresh; an uncertain delivery is not replayed.
            }
          }
        })
        .catch(() => undefined);
      return delivery;
    }
  };
}
