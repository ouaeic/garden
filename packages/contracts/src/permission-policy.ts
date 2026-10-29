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
      'Asks before consequential browser or desktop actions, a command reaching the internet, installing software, and setting up a schedule or a service; the built-in web tools read without asking. Other safeguards also apply.'
  },
  autonomous: {
    asksBeforeEveryChange: false,
    asksBeforeReachingTheInternet: false,
    asksBeforeInstallingSoftware: false,
    authorizesSurfaceActions: true,
    authorizesAccountActions: true,
    sentence:
      'Works without asking, within your granted access: commands, installs, the internet, browser and desktop actions, mail and calendar, uploads, submissions and sending. Only what needs you still asks: a password or other private input, a CAPTCHA, and paid media.'
  }
};

export const permissionModeSummary = (mode: SecurityMode): string =>
  mode === 'review'
    ? `${SECURITY_MODE_FLOOR.review.sentence} ${SECURITY_MODE_FLOOR.balanced.sentence}`
    : SECURITY_MODE_FLOOR[mode].sentence;
