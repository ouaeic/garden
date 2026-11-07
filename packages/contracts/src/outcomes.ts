/**
 * The two labels a delivered reply closes with.
 *
 * Owned here because two packages are held to them at once: the worker's operating contract asks
 * the model to end with them, and the API reads them back off the reply to build the cover note.
 * Reworded on one side only, every reply would keep its verdict inside its answer and nothing would
 * fail to say so.
 */
export const VERDICT_LABELS = { checked: 'Checked', yourCall: 'Your call' } as const;
