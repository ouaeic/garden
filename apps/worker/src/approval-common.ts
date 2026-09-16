/** Shared approval facts and presentation bounds; no authority is derived here. */
import { type SecurityMode, type TaskApprovalScope } from '@athanor/contracts';
import { type ResolvedMediaModel } from './media.js';
import { textValue } from './values.js';

export interface ApprovalContext {
  nativeInput?: {
    model: string;
    reservationUsd: number;
    sha256: string;
  };
  mediaCommittedUsd?: number;
  mediaModel?: ResolvedMediaModel;
  existingSkill?: {
    version: number;
    enabled: boolean;
    useCount: number;
    updatedAt: string;
  };
  undoPoint?: {
    id: string | null;
    uncovered?: readonly string[];
  };
  taintSources?: readonly string[];
  knownOrigins?: readonly string[];
  knownAddresses?: readonly string[];
  ownerText?: string;
  selfOrigins?: readonly string[];
  spentNoveltyBytes?: number;
}

export interface ApprovalRequirement {
  taskGrant?: TaskApprovalScope;
  sideEffect: 'workspace_write' | 'external_reversible' | 'external_consequential';
  action: string;
  preview: string;
  /** Reject this proposal and let Autonomous try a separately checked alternative. */
  recovery?: 'verify_public_source' | 'separate_network_steps' | 'use_explicit_cwd';
}

export const APPROVAL_RANK: Record<ApprovalRequirement['sideEffect'], number> = {
  workspace_write: 0,
  external_reversible: 1,
  external_consequential: 2
};

export const SECURITY_MODE_FLOOR: Record<
  SecurityMode,
  {
    readonly asksBeforeEveryChange: boolean;
    readonly asksBeforeReachingTheInternet: boolean;
    readonly asksBeforeInstallingSoftware: boolean;
    readonly authorizesSurfaceActions: boolean;
    readonly sentence: string;
  }
> = {
  review: {
    asksBeforeEveryChange: true,
    asksBeforeReachingTheInternet: true,
    asksBeforeInstallingSoftware: true,
    authorizesSurfaceActions: false,
    sentence:
      'Every command, every file written, and every browser or desktop action, on top of everything Balanced asks about.'
  },
  balanced: {
    asksBeforeEveryChange: false,
    asksBeforeReachingTheInternet: true,
    asksBeforeInstallingSoftware: true,
    authorizesSurfaceActions: false,
    sentence:
      'Asks before consequential browser or desktop actions, a command reaching the internet, and installing software; the built-in web tools read without asking. Other safeguards also apply.'
  },
  autonomous: {
    asksBeforeEveryChange: false,
    asksBeforeReachingTheInternet: false,
    asksBeforeInstallingSoftware: false,
    authorizesSurfaceActions: true,
    sentence:
      'Completes browser and desktop work, including uploads and submissions, without approval. CAPTCHA and private input need you. Other tools still ask about external changes, destructive operations, a durable instruction, schedule, service or tool configuration, and unverifiable network destinations.'
  }
};

export const DEFERRED_EXECUTION_ACTION = 'Change a file this computer runs on its own';

const CARD_NAMED_OBJECTS = 6;

export const namedObjects = (values: readonly string[]): string => {
  const distinct = [...new Set(values.filter(Boolean))];
  const hidden = distinct.length - CARD_NAMED_OBJECTS;
  const shown = distinct.slice(0, CARD_NAMED_OBJECTS).join(', ');
  return hidden > 0 ? `${shown} and ${hidden} more` : shown;
};

const CARD_COMMAND_CHARS = 400;

export const shellInvocation = (args: Record<string, unknown>): string => {
  const invocation = [
    [
      textValue(args.executable).split('/').pop() ?? '',
      ...(Array.isArray(args.args) ? args.args.map(String) : [])
    ]
      .filter(Boolean)
      .join(' '),
    ...(textValue(args.stdin) ? [textValue(args.stdin)] : [])
  ]
    .filter(Boolean)
    .join(' << ');
  return invocation.length > CARD_COMMAND_CHARS
    ? `${invocation.slice(0, CARD_COMMAND_CHARS)}… and ${invocation.length - CARD_COMMAND_CHARS} more characters`
    : invocation;
};
