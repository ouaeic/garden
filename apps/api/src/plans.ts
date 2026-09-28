/**
 * The ceilings this server enforces on itself.
 *
 * There used to be four of these - Core at $15 a month, Pro at $39, Max at $79 - and a lookup at
 * every call site that read a plan id off the subscription and fell back to the free one. Nothing
 * could ever have set that id to anything else: garden is a program the owner installs on their
 * own box and points at their own provider, so there is nobody to bill and nothing to sell. The
 * three paid tiers were unreachable branches, and the copy built from them told the owner what
 * their own machine "allows".
 *
 * What is left is what the numbers were always for: bounds that keep one runaway loop from filling
 * the disk with recovery points or the scheduler with jobs. They are deliberately generous, because
 * the only person they can inconvenience is the person who chose to install this.
 */
import { MAX_WORKSPACE_PREVIEWS } from '@garden/contracts';

export const serverLimits = {
  maxWorkspaces: 1,
  storageBytes: 100_000 * 1_000_000_000,
  maxSnapshots: 100,
  maxSchedules: 1_000,
  /** Shared with the agent's own publishing tools, which write preview rows through the store. */
  maxPreviews: MAX_WORKSPACE_PREVIEWS
} as const;

/**
 * The window the usage pane totals against: the owner's current calendar month, in UTC.
 *
 * It used to be read off a stored billing period that was written when the account was created and
 * never advanced, so a box a year old was still summing the month it was installed in. Nothing is
 * being billed, so nothing has to remember a period - the month is a fact about the calendar.
 */
export const currentPeriod = (now = new Date()): { start: Date; end: Date } => ({
  start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
});
