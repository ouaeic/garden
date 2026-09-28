import type { PendingNotificationRecord } from '@garden/data';

/**
 * What a notification is about, separated from how it is worded and from whether it is sent.
 *
 * The three pieces were one function before, and the result was a push that said "Your cloud task
 * is ready" to every subscribed device whether or not the owner was already looking at the screen
 * it was describing. Owners turn that off, and turning it off also silences the approval prompts
 * the safety model depends on, so the wording and the send decision are now testable on their own.
 *
 * The set of kinds is taken from the row this service reads rather than restated here: the two
 * halves disagreeing would mean a kind the data layer raises and this one silently drops.
 */
export type NotificationKind = PendingNotificationRecord['kind'];

/** The side-effect classes the agent's approval requirement can carry. */
export type ApprovalSideEffect =
  | 'workspace_write'
  | 'external_reversible'
  | 'external_consequential';

export interface NotificationSubject {
  kind: NotificationKind;
  /** The conversation to open, which is what a tap on the notification body does. */
  taskId: string;
  /** Approval id for an approval, task id otherwise. Also the dedupe key. */
  resourceId: string;
  /** The owner's own name for the conversation. Null only when it could not be read. */
  taskTitle: string | null;
  taskStatus: string | null;
  /** Tool name the approval is bound to, e.g. `shell`. Plaintext on the approval row. */
  approvalAction: string | null;
  approvalSideEffect: ApprovalSideEffect | null;
  /** What the agent asked to have said, for the two kinds it raises. Null for the rest. */
  message: string | null;
  /**
   * True when this `takeover_needed` is the harness speaking rather than the agent: the approval
   * the conversation was parked on expired unanswered, and the sweep paused the task.
   *
   * The two arrive under one kind on purpose - see the branch that raises it in
   * `store/notifications.ts` - and they need different sentences, because "take control of the
   * Computer" is not what an owner does about an approval that ran out. Always false for every
   * other kind.
   */
  approvalExpired: boolean;
  /** Real currency, for the two kinds where money is the whole point of the message. */
  spentUsd: number | null;
  capUsd: number | null;
  /** How long the work ran, in milliseconds, when both ends of it are known. */
  durationMs: number | null;
}

/**
 * Minutes past local midnight. A window that wraps midnight is normal and expected — 22:00 to
 * 07:00 is the common case — so `startMinute > endMinute` is meaningful rather than invalid.
 */
export interface QuietHours {
  startMinute: number;
  endMinute: number;
}

export interface OwnerNotificationSettings {
  /**
   * Per-kind switches, one for every kind. A kind switched off is dropped by the server rather
   * than hidden by the device, so silencing it costs nothing and cannot be undone by a phone.
   *
   * Every kind is on until the owner says otherwise, including the two the agent raises: those are
   * the agent asking for the owner rather than reporting on itself, so the default has to be on -
   * but a default is not a rule, and an owner who never wants to be interrupted mid-run gets to
   * say so.
   */
  kinds: Record<NotificationKind, boolean>;
  quietHours: QuietHours | null;
  /**
   * Whether an approval still rings during quiet hours. Defaults to true: an approval is the one
   * message where silence has a cost — the agent stops and waits — and it is the message the owner
   * most needs to see. Everything else waits for morning.
   */
  quietHoursAllowApprovals: boolean;
  /**
   * The owner's day, taken from the spending caps rather than stored twice. There is exactly one
   * answer to "when does my day roll over" and it already has a home.
   */
  timeZone: string;
}

export const defaultNotificationSettings = (timeZone = 'UTC'): OwnerNotificationSettings => ({
  kinds: {
    approval_required: true,
    task_finished: true,
    spend_paused: true,
    agent_message: true,
    takeover_needed: true
  },
  quietHours: null,
  quietHoursAllowApprovals: true,
  timeZone
});

/**
 * What the agent is asking permission to do, in the owner's language, from the two plaintext
 * columns on the approval row.
 *
 * The exact sentence the approval card shows lives inside the encrypted preview, which this
 * service holds no key for. The tool name and the side-effect class are enough to say truthfully
 * what class of thing is about to happen, which is what a lock screen has room for anyway.
 *
 * Every case below is a name `agentToolsFor()` actually publishes, or `secure_input_handoff`, which
 * is the one action the worker writes on an approval row without a tool behind it. `http_request`
 * had a case here and has never been a tool in this catalogue - so the phrase was unreachable, and
 * an unreachable phrase reads to the next person as evidence that a tool by that name exists.
 * `scripts/check-repository.mjs` holds this list against the catalogue.
 */
export const approvalPhrase = (
  action: string | null,
  sideEffect: ApprovalSideEffect | null
): string => {
  switch (action) {
    case 'shell':
      return 'run a command on your computer';
    case 'connector_action':
      return 'use one of your connected accounts';
    /*
     * One tool, two reaches, and the difference is the whole point of the card. `publish_site` was
     * folded into `publish_preview` as a `reach` argument, and this function is handed the action
     * and the side effect and never the arguments - so the reach is read from the side effect,
     * which is the only thing here that carries it. A public reach is the one publishing shape the
     * floor raises `external_consequential` for; the private tier raises `workspace_write` on a
     * clean turn and `external_reversible` on a tainted one. Getting this wrong understates a
     * public deployment as "publish a file" on the owner's phone, which is the one surface where
     * they cannot go and look before answering.
     */
    case 'publish_preview':
      return sideEffect === 'external_consequential'
        ? 'publish something to a public address'
        : 'publish a file';
    case 'publish_artifact':
      return 'publish a file';
    case 'browser_action':
      return 'act inside a site you are signed in to';
    case 'desktop_action':
    case 'desktop_launch':
      return 'act on the desktop of your computer';
    case 'file_write':
    case 'file_patch':
      return 'change a file in your workspace';
    case 'schedule':
      return 'change your scheduled work';
    case 'memory':
      return 'change what it remembers about you';
    case 'skill':
      return 'change one of its reusable skills';
    case 'generate_media':
      return 'spend money generating media';
    case 'coding_agent':
      return 'hand this work to a coding agent';
    case 'secure_input_handoff':
      return 'hand control back so you can type something private';
    default:
      break;
  }
  switch (sideEffect) {
    case 'external_consequential':
      return 'do something outside this computer that cannot be undone';
    case 'external_reversible':
      return 'do something outside this computer';
    case 'workspace_write':
      return 'change something in your workspace';
    default:
      return 'do something it needs your permission for';
  }
};
