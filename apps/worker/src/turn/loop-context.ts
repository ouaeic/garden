import type { ModelRelease } from '@garden/contracts';
import type { TaskRecord } from '@garden/data';
import type { AgentState } from '../agent-state.js';
import type { CompactionOutcome } from '../context.js';

/**
 * What a phase lifted out of the step loop still needs from the loop it came out of.
 *
 * Two things, and deliberately only two. `TurnLoopControl` is the four closures `run()` builds over
 * the turn's own scope - the workspace key, the window, the task record - which a phase cannot
 * rebuild from its own arguments and which passing piecemeal would mean handing most of `run()` to
 * every phase. `TurnStepBudget` is the pair of numbers that are worked out once per turn and read
 * by every phase after.
 *
 * Declared once rather than re-declared per phase, because all six have to mean the same thing in
 * every phase or the ordering each call site's comment claims stops being true. A phase asks for
 * the subset of the controls it uses via `Pick`, so what it can reach for stays readable from its
 * own signature.
 *
 * Everything else a phase needs is already `TurnRun` - the model, its gateway, the catalogue, the
 * tools this request carries and the reserved-token count - which is passed whole for the same
 * reason: it is fixed for the life of the turn and rebuilding any of it per phase is how two ways
 * of measuring the same thing get into one loop.
 */
/**
 * Condensing the trajectory, named once because three of the five phases can ask for it and a
 * seventeen-line signature written out three times is how two ways of describing one operation get
 * into one loop. @see compactTurnContext in `compaction.ts` for what it actually does.
 *
 * All three callers reach the same method on the worker; what differs is only the `trigger` they
 * pass - `'budget'` when the harness decided, `'agent'` when the model asked.
 */
export type CompactContext = (
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  input: {
    model: ModelRelease;
    catalog: ModelRelease[];
    maxOutputTokens: number;
    reservedTokens: number;
    trigger: 'budget' | 'agent';
    turn: number;
    note?: string;
    contextTokensLimit?: number;
  }
) => Promise<CompactionOutcome | null>;

export interface TurnLoopControl {
  /**
   * Stop, pause, cancel, or another claimant. `true` means this run is over and has already said so
   * - the caller returns without writing anything further.
   */
  honorUserControl(): Promise<boolean>;
  /** A message the owner sent mid-turn, moved into the window. `true` when one arrived. */
  drainCorrection(): Promise<boolean>;
  /** Republishes the active plan; `true` when the version moved under this turn. */
  refreshActivePlan(): Promise<boolean>;
  /** Refreshes the owner's decision opt-out and the tail block that carries the clock. */
  refreshRuntimeContext(): void | Promise<void>;
}

/** The two per-turn numbers every phase after the claim is written against. */
export interface TurnStepBudget {
  /**
   * The output ceiling every request this turn makes is written against. A pure function of the
   * chosen model's window, worked out once because it was recomputed - identically, from the same
   * two constants - in five places.
   */
  readonly maxOutputTokens: number;
  /** Which turn of the conversation this is, which the ledger rows are keyed by. */
  readonly turn: number;
}
