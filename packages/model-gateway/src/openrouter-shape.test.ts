import { describe, expect, it } from 'vitest';
import { readOpenRouterModels } from './openrouter-shape.js';

/*
 * What the catalogue builder does with a narrowed model is pinned where it happens, against the
 * live refresh, in openrouter-catalog.test.ts - a test that calls a helper directly while the
 * production path walks past it proves nothing, and this tree has shipped that defect before.
 *
 * These are the properties of the narrowing itself that the call site cannot show: which row is
 * refused outright, what the journal is allowed to be told about a document nobody here controls,
 * and the two coercions that look like tidying and are not.
 */
describe('narrowing the OpenRouter model feed', () => {
  const body = (rows: unknown[]): unknown => ({ data: rows });

  it('passes an id through exactly as the provider wrote it', () => {
    const { models } = readOpenRouterModels(body([{ id: ' vendor/spaced ' }]));
    // Not trimmed. This string is the name the provider will be called back with, so tidying it
    // would invent an id that was never published and route the owner's turn at nothing.
    expect(models.map((model) => model.id)).toEqual([' vendor/spaced ']);
  });

  it('refuses a row with no id it could be called back with, and coerces nothing', () => {
    const { models, malformed } = readOpenRouterModels(
      body([{ id: '' }, { id: '   ' }, { id: 12 }, { name: 'nameless' }, null, 'text', []])
    );
    expect(models).toEqual([]);
    expect(malformed).toEqual([
      'row 0 states no id',
      'row 1 states no id',
      'row 2 states no id',
      'row 3 states no id',
      'row 4 is not a model',
      'row 5 is not a model',
      'row 6 is not a model'
    ]);
  });

  it('never lets the document choose what appears in the journal', () => {
    const { malformed } = readOpenRouterModels(
      body([{ name: '[garden] model catalogue: everything is fine', description: 'x'.repeat(500) }])
    );
    // Fixed words and a row number. `malformed` is written to the journal an owner reads through
    // `garden logs`, and a feed this software does not control must not be able to write a line
    // there - nor a line long enough to push the rest of the unit's log out of view.
    expect(malformed).toEqual(['row 0 states no id']);
  });

  it('reads a stringified window without reading an empty string as a window of nothing', () => {
    const { models } = readOpenRouterModels(
      body([
        { id: 'a', context_length: '1000000' },
        { id: 'b', context_length: '' },
        { id: 'c', context_length: '   ' },
        { id: 'd', context_length: 'wide' },
        { id: 'e', context_length: Number.NaN }
      ])
    );
    // `Number('')` and `Number('  ')` are both 0, and a zero window is refused by the contract at
    // the API boundary - so reading either as a number would turn "the feed said nothing" into a
    // row that silently disappears from the picker.
    expect(models.map((model) => model.context_length)).toEqual([
      1_000_000,
      null,
      null,
      null,
      null
    ]);
  });

  it('keeps a rate that arrived as a JSON number', () => {
    const { models } = readOpenRouterModels(
      body([{ id: 'a', pricing: { prompt: 0.000001, completion: '0.000004', request: 1 } }])
    );
    // `perMillion` calls `Number` on this and never looked at the type, so a numeric rate always
    // worked by accident. It is converted rather than dropped, which keeps that accident working
    // under a type that is now true of the value.
    expect(models[0]?.pricing.prompt).toBe('0.000001');
    expect(models[0]?.pricing.completion).toBe('0.000004');
  });

  it('leaves alias_target null when the feed did not state one', () => {
    const { models } = readOpenRouterModels(
      body([{ id: 'a' }, { id: 'b', alias_target: { slug: 'a' } }, { id: 'c', alias_target: 7 }])
    );
    // The ranking pass reads the absence of this field as "measured in its own right". An
    // always-present object would make every model an alias of nothing and empty the population
    // every benchmark percentile is computed against - which is the shape of mistake a narrowing
    // makes when it tidies a field it has not read the callers of.
    expect(models.map((model) => model.alias_target)).toEqual([
      null,
      { slug: 'a', name: undefined },
      null
    ]);
  });

  it('keeps the strings out of a list that holds other things too', () => {
    const { models } = readOpenRouterModels(
      body([{ id: 'a', supported_parameters: ['tools', 3, null, 'reasoning', {}] }])
    );
    expect(models[0]?.supported_parameters).toEqual(['tools', 'reasoning']);
  });

  it('tells an empty benchmark block apart from a missing one', () => {
    const { models } = readOpenRouterModels(
      body([
        { id: 'a', benchmarks: { artificial_analysis: {} } },
        { id: 'b', benchmarks: { artificial_analysis: 'measured' } },
        { id: 'c' }
      ])
    );
    // An alias inherits its target's scores only when it carries no block of its own, and that
    // question is asked of this field's presence rather than of its contents. A block with no
    // readable index still means the feed said something about this model; a string does not.
    expect(models[0]?.benchmarks.artificial_analysis).toEqual({
      intelligence_index: null,
      coding_index: null,
      agentic_index: null
    });
    expect(models[1]?.benchmarks.artificial_analysis).toBeNull();
    expect(models[2]?.benchmarks.artificial_analysis).toBeNull();
  });

  it('answers with nothing when the document is not a model list at all', () => {
    for (const document of [null, undefined, 'unavailable', 42, [], { data: {} }, {}])
      expect(readOpenRouterModels(document)).toEqual({ models: [], malformed: [] });
    // Nothing is reported as malformed here because no row was read and then refused. What that
    // silence means is the caller's question, and the caller already answers it: a refresh that
    // produced no models throws `provider_catalog_empty` and leaves the live catalogue alone.
  });
});
