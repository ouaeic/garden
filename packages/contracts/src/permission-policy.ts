import type { SecurityMode } from './index.js';

/** Permission capabilities and their owner-visible explanation, shared without schema imports. */
export const SECURITY_MODE_FLOOR: Record<
  SecurityMode,
  {
    readonly asksBeforeEveryChange: boolean;
    readonly asksBeforeReachingTheInternet: boolean;
    readonly asksBeforeInstallingSoftware: boolean;
    readonly authorizesSurfaceActions: boolean;
    readonly authorizesAccountActions: boolean;
    readonly sentence: string;
  }
> = {
  review: {
    asksBeforeEveryChange: true,
    asksBeforeReachingTheInternet: true,
    asksBeforeInstallingSoftware: true,
    authorizesSurfaceActions: false,
    authorizesAccountActions: false,
    sentence:
      'Every command, every file written, and every browser or desktop action, on top of everything Balanced asks about.'
  },
  balanced: {
    asksBeforeEveryChange: false,
    asksBeforeReachingTheInternet: true,
    asksBeforeInstallingSoftware: true,
    authorizesSurfaceActions: false,
    authorizesAccountActions: false,
    sentence:
      'Asks before consequential browser or desktop actions, a command reaching the internet, and installing software; the built-in web tools read without asking. Other safeguards also apply.'
  },
  autonomous: {
    asksBeforeEveryChange: false,
    asksBeforeReachingTheInternet: false,
    asksBeforeInstallingSoftware: false,
    authorizesSurfaceActions: true,
    authorizesAccountActions: true,
    sentence:
      'Completes browser, desktop, mail and calendar work within your granted access without approval, including uploads, submissions and sending. CAPTCHA and private input need you. Other tools still ask about external changes, destructive operations, a durable instruction, schedule, service or tool configuration, and unverifiable network destinations.'
  }
};

export const permissionModeSummary = (mode: SecurityMode): string =>
  mode === 'review'
    ? `${SECURITY_MODE_FLOOR.review.sentence} ${SECURITY_MODE_FLOOR.balanced.sentence}`
    : SECURITY_MODE_FLOOR[mode].sentence;
