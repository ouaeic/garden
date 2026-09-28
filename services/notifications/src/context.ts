import type { DataStore, PendingNotificationRecord } from '@garden/data';
import {
  defaultNotificationSettings,
  type ApprovalSideEffect,
  type NotificationSubject,
  type OwnerNotificationSettings
} from './model.js';
import { PRESENCE_WINDOW_MS } from './policy.js';

/**
 * The pending row as this service reads it.
 *
 * This was a widened copy while the data layer still knew two kinds and carried no title. It now
 * carries both, so the alias exists only to keep the service's own vocabulary in one place.
 */
export type PendingRow = PendingNotificationRecord;

const optionalText = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const sideEffect = (value: unknown): ApprovalSideEffect | null =>
  value === 'workspace_write' ||
  value === 'external_reversible' ||
  value === 'external_consequential'
    ? value
    : null;

/**
 * The owner's preferences, with the day boundary taken from the spending caps.
 *
 * There is one notion of the owner's day on this server and it belongs to the caps, so quiet hours
 * read it rather than storing a second copy that could disagree with it.
 *
 * Every failure here lands on the defaults, which is every kind on: a settings row that cannot be
 * read must not be able to silence a notification the owner never switched off. That is the whole
 * reason this is a merge over the defaults rather than a substitution of them.
 */
export const ownerSettings = async (
  store: DataStore,
  userId: string
): Promise<OwnerNotificationSettings> => {
  const limits = await store.effectiveSpendLimits(userId).catch(() => null);
  const defaults = defaultNotificationSettings(limits?.timeZone ?? 'UTC');
  const stored = await store.notificationSettings(userId).catch(() => null);
  return stored
    ? { ...stored, kinds: { ...defaults.kinds, ...stored.kinds }, timeZone: defaults.timeZone }
    : defaults;
};

/**
 * Whether the owner is at the keyboard right now.
 *
 * Every authenticated request refreshes the session's last-seen stamp, and the client polls the
 * open conversation and the approval list every three seconds while work is running, so a session
 * touched inside the presence window means the screen this notification describes is already in
 * front of them. The service worker also refuses to raise a notification over a focused window;
 * this is the half that stops the phone from lighting up in the first place.
 */
export const ownerPresent = async (
  store: DataStore,
  userId: string,
  now: Date,
  windowMs = PRESENCE_WINDOW_MS
): Promise<boolean> => {
  const sessions = await store.listSessions(userId).catch(() => []);
  return sessions.some((session) => {
    const seen = Date.parse(String(session.lastSeenAt));
    return Number.isFinite(seen) && now.getTime() - seen <= windowMs;
  });
};

/**
 * Everything the wording needs, gathered from rows this service can already read.
 *
 * The approval's tool name and side-effect class are plaintext columns, so an approval is fully
 * worded here. A spend pause is worded from the task's own settled spend and ceiling, which is the
 * right pair of numbers only when that is the ceiling it hit - see the branch below. The
 * conversation title and anything the agent asked to have said are encrypted with a workspace key
 * this service does not hold, which is why they arrive on the pending row instead, already
 * unwrapped by the only layer that holds both the envelope and the key.
 */
export const notificationSubject = async (
  store: DataStore,
  row: PendingRow
): Promise<{ subject: NotificationSubject; eventAt: Date }> => {
  const task = await store.getTask(row.userId, row.taskId).catch(() => null);
  const startedAt = task ? Date.parse(task.createdAt) : Number.NaN;
  const endedAt = task ? Date.parse(task.updatedAt) : Number.NaN;
  const subject: NotificationSubject = {
    kind: row.kind,
    taskId: row.taskId,
    resourceId: row.resourceId,
    taskTitle: row.taskTitle ?? task?.legacyTitle ?? null,
    taskStatus: row.taskStatus ?? task?.status ?? null,
    approvalAction: null,
    approvalSideEffect: null,
    message: row.message,
    approvalExpired: false,
    spentUsd: task?.spentUsd ?? null,
    capUsd: task?.maxSpendUsd ?? null,
    // Wall-clock from the first message to the last change. There is no separate finished-at on
    // the record, and for a conversation that just reached a terminal state they are the same
    // thing; a receipt that says "in 6 min" is worth more than one that says nothing.
    durationMs:
      Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt > startedAt
        ? endedAt - startedAt
        : null
  };
  // When the reported thing happened travels on the row, which is the only value that is right for
  // every kind: a task's last update is not when its approval was raised, nor when the agent asked
  // for the owner, and the staleness horizon is measured against exactly this.
  const carried = Date.parse(row.eventAt);
  const eventAt = Number.isFinite(carried)
    ? new Date(carried)
    : Number.isFinite(endedAt)
      ? new Date(endedAt)
      : new Date();

  if (row.kind === 'spend_paused') {
    /*
     * Three different ceilings stop a task, and only one of them is on the task row.
     *
     * The spending guard blocks on the task's own cap, on the daily cap or on the monthly cap, and
     * it also pauses when it could not answer at all - and the pending row carries none of that,
     * only `spend_paused_at`. So the task's spend and the task's ceiling are the right pair of
     * numbers exactly when the task's spend has reached the task's ceiling. Otherwise it is a
     * household cap, and "Paused at your $5.00 limit after spending $0.31" would name a limit that
     * was never reached and a figure that is not what stopped anything. The payload's other
     * sentence says the same true thing without the numbers.
     */
    const ownCapReached =
      subject.spentUsd !== null && subject.capUsd !== null && subject.spentUsd >= subject.capUsd;
    if (!ownCapReached) {
      subject.spentUsd = null;
      subject.capUsd = null;
    }
    subject.durationMs = null;
  }

  if (row.kind === 'takeover_needed') {
    /*
     * Which of the two takeovers this is, asked of the row rather than guessed from the shape of
     * the other fields.
     *
     * The data layer raises `takeover_needed` from two places: the agent, whose row carries its
     * own sentence, and the candidate branch for an approval that expired unanswered, whose
     * `resourceId` is an approval id. Nothing else on the row separates them - a box with no
     * DATA_MASTER_KEY has a null message for both - so the approval is looked up and its status
     * read. One primary-key probe, on the rarest kind there is: a takeover means the work has
     * stopped for a person, so there is at most a handful of these in a batch of a hundred.
     *
     * Verified rather than inferred, deliberately. The sentence below claims the approval ran out,
     * and this is the row that says whether it did.
     */
    const approval = await store.getApproval(row.resourceId).catch(() => null);
    subject.approvalExpired =
      optionalText(approval?.status) === 'expired' && optionalText(approval?.userId) === row.userId;
    // The tool name, so the sentence can say what went unanswered rather than only that something
    // did. `getApproval` selects no side-effect column, so that half stays null and
    // `approvalPhrase` falls back to its own general wording - which is the honest answer, not a
    // gap: the class of side effect is on the card the owner is being sent to.
    if (subject.approvalExpired) subject.approvalAction = optionalText(approval?.action);
    // Same reason as the approval branch below: this is a decision the owner has to go and make,
    // and a dollar figure beside it reads as though the money is the thing being reported.
    subject.spentUsd = null;
    subject.capUsd = null;
    subject.durationMs = null;
  }

  if (row.kind === 'approval_required') {
    const approvals = await store.listApprovals(row.userId, 'pending').catch(() => []);
    const approval = approvals.find((item) => String(item.id) === row.resourceId);
    subject.approvalAction = optionalText(approval?.action);
    subject.approvalSideEffect = sideEffect(approval?.sideEffect);
    // A spend pause and a finished task both report money; an approval reports a decision, and a
    // dollar figure beside it reads as though the money is what is being approved.
    subject.spentUsd = null;
    subject.capUsd = null;
    subject.durationMs = null;
  }

  return { subject, eventAt };
};
