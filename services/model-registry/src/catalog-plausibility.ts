/**
 * Whether a live answer is describing models the way an answer describes models.
 *
 * The refresh is a *destructive replace*: whatever the provider said an hour ago is deleted and
 * whatever it says now is written in its place. Nothing between the provider's JSON and that
 * delete validated a single one of the thirty-three upstream fields the importer reads. So one
 * rename at the provider - not an outage, not a 500, a rename - is silent and total:
 *
 * - `supported_parameters` moves, `supported.has('tools')` is false for every model, every row is
 *   written with `capabilities: ['chat']`, and `selectModel` - which requires `['chat','tools']` -
 *   ranks an empty pool. The refresh reports `refreshed`. `doctor` reports a current catalogue.
 *   The owner asks a question and nothing happens, with no message anywhere naming a cause.
 * - `pricing` moves, every `inputUsdPerMillionTokens` is null, `usageClassForPrice` calls the whole
 *   catalogue 'medium', and the price-ceiling arm tells the owner to raise a ceiling that is not
 *   what is stopping them.
 *
 * This is the gate. It runs where the previous catalogue is already in hand for the
 * zero-retention carry-forward, so it costs one pass over two arrays and no extra query.
 *
 * ## Why it compares shares and not counts
 *
 * The obvious gate - "refuse an answer that lost more than half the tools-capable models" - has a
 * false positive that wedges a box permanently: an owner who moves `MODEL_CATALOG_SCOPE` from
 * `provider_catalog` to `reviewed_open_weight` goes from a three-hundred-model catalogue to the
 * four reviewed seeds, deliberately, and every count collapses by 98%. A count gate would refuse
 * that for ever and there is nothing in this record that could tell it apart from the break.
 *
 * The *share* does tell them apart, because it asks a different question. A scope change keeps
 * four models out of four tools-capable: the share is unchanged and the answer is as well
 * described as the one before it. A field rename takes the share to zero whatever the size. So the
 * question this asks is not "is this answer as big as the last one" - a provider is entitled to
 * withdraw models, and withdrawing them is exactly what the replace exists to do - but "does this
 * answer still know what it is talking about".
 *
 * This means an honest shrink is never refused, which is the correct trade in both directions: a
 * catalogue that shrinks legitimately still serves the owner, and a catalogue that stops being
 * described stops the replace before it deletes the one that was.
 */

/**
 * A fact the catalogue must go on carrying, named as the owner would experience losing it.
 *
 * Three, because these are the three the rest of the computer acts on without asking twice:
 * `capabilities` decides whether any model at all can be ranked for agentic work, the input price
 * decides usage class and whether the owner's price ceiling admits a model, and the benchmark is
 * what ranks the ones that are left. A fourth field going missing degrades an answer; one of these
 * three going missing ends the box's ability to do work while every layer reports health.
 */
interface CatalogueFact {
  /** Used in the sentence the journal and `doctor` both carry, so it reads as a consequence. */
  readonly name: string;
  readonly holds: (row: Record<string, unknown>) => boolean;
}

const FACTS: readonly CatalogueFact[] = [
  {
    name: 'models that can be given tools',
    holds: (row) => Array.isArray(row.capabilities) && row.capabilities.includes('tools')
  },
  {
    name: 'models with a published price',
    holds: (row) =>
      typeof row.inputUsdPerMillionTokens === 'number' &&
      Number.isFinite(row.inputUsdPerMillionTokens)
  },
  {
    name: 'models with a benchmark score',
    holds: (row) => typeof row.measuredQuality === 'number' && Number.isFinite(row.measuredQuality)
  }
];

/**
 * How much of the previous catalogue has to have carried a fact before its disappearance is worth
 * refusing an answer over.
 *
 * Below this the fact was never broadly true on this box - an owner whose provider publishes
 * benchmarks for a tenth of its range, say - and a drop in it is noise rather than a shape change.
 * Gating on a fact a quarter of the catalogue carried is already generous to the gate.
 */
const ESTABLISHED_SHARE = 0.25;

/**
 * How much of that share the new answer has to keep.
 *
 * Half. Not a tuned number and not meant to be one: the failure this catches takes a share to
 * zero, and the ordinary week-to-week movement is a point or two. Anything between the two is a
 * provider doing something drastic enough that the owner should hear about it before their
 * catalogue is deleted and rebuilt from it.
 */
const RETAINED_SHARE = 0.5;

const shareCarrying = (
  rows: ReadonlyArray<Record<string, unknown>>,
  fact: CatalogueFact
): number => (rows.length === 0 ? 0 : rows.filter((row) => fact.holds(row)).length / rows.length);

const percent = (share: number): string => `${Math.round(share * 100)}%`;

/**
 * Null when the answer may be written, or the sentence saying why it may not.
 *
 * The sentence is the whole product of this function. It is what the journal prints, what
 * `garden doctor` reads back out of the state record, and the only thing that will exist on the
 * box connecting "garden stopped answering" to "the provider renamed a field" - so it names the
 * fact, both shares and the sizes, and it says what is still serving. A gate that refuses silently
 * would have swapped one silence for another.
 */
export const implausibleReplacement = (input: {
  previous: ReadonlyArray<Record<string, unknown>>;
  live: ReadonlyArray<Record<string, unknown>>;
}): string | null => {
  // Nothing to compare against is not a reason to refuse: a box being set up has an empty
  // catalogue and the first real answer is the one that fills it.
  if (input.previous.length === 0 || input.live.length === 0) return null;
  for (const fact of FACTS) {
    const before = shareCarrying(input.previous, fact);
    if (before < ESTABLISHED_SHARE) continue;
    const after = shareCarrying(input.live, fact);
    if (after >= before * RETAINED_SHARE) continue;
    return (
      `the provider's answer describes ${input.live.length} models, of which ${percent(after)} are ` +
      `${fact.name}, where ${percent(before)} of the ${input.previous.length} models already here ` +
      `are. That is a change in what the provider is saying about its models rather than a change ` +
      `in which models it offers, so the catalogue already here was kept and the answer discarded. ` +
      `Until this is looked at the picker goes on offering what it held, at the prices it held`
    );
  }
  return null;
};
