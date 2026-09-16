/**
 * Matching an owner's answer to the thing they were asked about.
 *
 * An approval card is raised in one turn and answered in another, possibly after a restart, so the
 * arguments the owner saw have to be pinned to the call that eventually runs. The hash is that pin,
 * and it is compared with a timing-safe equality because it is keyed on a secret.
 *
 * Lifted out of `agent.ts` unchanged by Wave 7.1.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson, textValue } from './values.js';
import type { TaskApprovalScope } from '@athanor/contracts';

export interface AgentApprovalRequirement {
  destinations?: string[];
  taskGrant?: TaskApprovalScope;
  sideEffect: 'workspace_write' | 'external_reversible' | 'external_consequential';
  action: string;
  preview: string;
  handoffOnly?: boolean;
  recovery?: 'verify_public_source' | 'separate_network_steps';
}

/**
 * Binds an approval to the exact call it was requested for. The workspace key is used as the HMAC
 * key so a stored row cannot be re-pointed at a different action by anyone who can write the
 * approvals table but not decrypt the workspace.
 *
 * The tool's name is part of the pin, and it was not. The hash covered the arguments alone, so two
 * tools that take the same argument shape - and this catalogue has several: every `path` taker,
 * every `{action}` taker - produced the same hash for the same object, and an approval granted for
 * one covered a call to the other. `canonicalJson` sorts keys, so the name goes in as its own
 * field rather than as a prefix somebody could construct inside an argument value.
 */
export const approvalPreviewHash = (
  key: Uint8Array,
  callName: string,
  toolArguments: Record<string, unknown>
): string =>
  createHmac('sha256', key)
    .update(canonicalJson({ tool: callName, arguments: toolArguments }))
    .digest('hex');

/**
 * Recomputed before an approved call runs: approval and execution are separated by a database
 * round trip and an arbitrary human delay, so what the user saw must be proven to be what runs.
 *
 * An approval created before this field joined the hash was pinned to the arguments alone, so it
 * will not match once the name is included. That is the correct outcome and it is not silent: the
 * caller takes the explicit refusal path, which tells the owner in their own conversation that the
 * action no longer matches what they approved and asks for the approval again.
 */
export const approvalArgumentsMatch = (
  storedHash: string,
  key: Uint8Array,
  callName: string,
  toolArguments: Record<string, unknown>
): boolean => {
  const stored = Buffer.from(storedHash, 'hex');
  const expected = Buffer.from(approvalPreviewHash(key, callName, toolArguments), 'hex');
  return stored.length === expected.length && timingSafeEqual(stored, expected);
};

export type ApprovalOutcome = 'approved' | 'denied' | 'expired' | 'waiting';

/**
 * Judges an approval row from the worker's side. The deadline is evaluated here rather than
 * trusting the stored status: nothing writes 'expired' until a maintenance sweep runs, and a task
 * that keeps reading its own request as still pending waits in awaiting_user - holding its compute
 * reservation - for as long as the row survives.
 */
export const approvalOutcome = (
  approval: { status?: unknown; expiresAt?: unknown } | null | undefined,
  now = Date.now()
): ApprovalOutcome => {
  if (!approval) return 'waiting';
  const status = textValue(approval.status);
  if (status === 'approved') return 'approved';
  if (status === 'expired') return 'expired';
  if (status !== 'pending') return 'denied';
  const expiresAt = Date.parse(textValue(approval.expiresAt));
  return Number.isFinite(expiresAt) && expiresAt <= now ? 'expired' : 'waiting';
};
