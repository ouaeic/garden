/** Shared approval facts and presentation bounds; no authority is derived here. */
import { type OwnerKey, type TaskApprovalScope } from '@garden/contracts';
import { type ResolvedMediaModel } from './media.js';
import { textValue } from './values.js';

export interface ApprovalContext {
  /** Set only by the floor after resolving the same saved inference connection and privacy policy. */
  decisionInference?: { boundToTaskConnection: true };
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
  /**
   * The owner's keys that answer this card in advance, all of them needed. Absent means no key
   * does: a card about untrusted content, a hand-off, or a check on the agent's own machinery.
   */
  keys?: readonly CardKey[];
}

/** An owner key, or "act": acting as the owner, which the Autonomous mode lends. */
export type CardKey = OwnerKey | 'act';

/** A requirement answered by keys - every one it names - that the owner has lent this goal. */
export const lentKeysCover = (
  requirement: Pick<ApprovalRequirement, 'keys'>,
  lent: { securityMode: string; lentKeys?: readonly OwnerKey[] }
): boolean =>
  Boolean(requirement.keys?.length) &&
  requirement.keys!.every((key) =>
    key === 'act' ? lent.securityMode === 'autonomous' : (lent.lentKeys ?? []).includes(key)
  );

/** Two cards that merge keep a key only when both sides name one: an unkeyed side stays unkeyed. */
export const mergeKeys = (
  left: ApprovalRequirement['keys'],
  right: ApprovalRequirement['keys']
): ApprovalRequirement['keys'] =>
  left?.length && right?.length ? [...new Set([...left, ...right])] : undefined;

export const APPROVAL_RANK: Record<ApprovalRequirement['sideEffect'], number> = {
  workspace_write: 0,
  external_reversible: 1,
  external_consequential: 2
};

export { SECURITY_MODE_FLOOR } from '@garden/contracts/permission-policy';

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
