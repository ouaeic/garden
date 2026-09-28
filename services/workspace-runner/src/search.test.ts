import { describe, expect, it } from 'vitest';
import {
  SEARCH_RESULT_LIMIT,
  duckDuckGoSearchUrl,
  searchResults,
  searchRoutePlan,
  unwrapResultLink,
  type RawSearchRow
} from './search.js';

const row = (overrides: Partial<RawSearchRow> = {}): RawSearchRow => ({
  href: '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.invalid%2Fguide&rut=9f',
  title: 'A guide to the thing',
  snippet: 'The guide covers the thing end to end.',
  advert: false,
  ...overrides
});

describe('web search request', () => {
  it('asks the engine in the one way that needs no account and no rendering', () => {
    expect(duckDuckGoSearchUrl('  board deck template  ')).toBe(
      'https://html.duckduckgo.com/html/?q=board%20deck%20template'
    );
    expect(() => duckDuckGoSearchUrl('   ')).toThrow('needs a query');
  });

  it('bounds the query rather than sending an essay to a search box', () => {
    const asked = duckDuckGoSearchUrl('a'.repeat(900));
    expect(asked.length).toBeLessThan(600);
  });
});

describe('web search results', () => {
  it('hands back the destination rather than the engine redirector', () => {
    expect(
      unwrapResultLink('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.invalid%2Fa%3Fb%3D1')
    ).toBe('https://example.invalid/a?b=1');
    expect(unwrapResultLink('https://example.invalid/direct')).toBe(
      'https://example.invalid/direct'
    );
  });

  it('drops anything that is not a page the agent could have opened itself', () => {
    // An ad slot links through the engine with no destination of its own.
    expect(unwrapResultLink('//duckduckgo.com/y.js?ad_provider=x')).toBeNull();
    expect(unwrapResultLink('javascript:alert(1)')).toBeNull();
    expect(unwrapResultLink('not a url at all')).toBeNull();
  });

  it('returns what the model needs to choose: title, address, source and a real snippet', () => {
    const [first] = searchResults([row()], SEARCH_RESULT_LIMIT);
    expect(first).toEqual({
      rank: 1,
      title: 'A guide to the thing',
      url: 'https://example.invalid/guide',
      site: 'example.invalid',
      snippet: 'The guide covers the thing end to end.'
    });
  });

  it('leaves out the paid placements and the repeats', () => {
    const results = searchResults(
      [
        row({ advert: true, title: 'Buy the thing' }),
        row(),
        row({ snippet: 'A second listing of the same page.' }),
        row({ href: null }),
        row({ href: '//duckduckgo.com/l/?uddg=https%3A%2F%2Fother.invalid%2Fb', title: 'Other' })
      ],
      SEARCH_RESULT_LIMIT
    );
    expect(results.map((result) => result.url)).toEqual([
      'https://example.invalid/guide',
      'https://other.invalid/b'
    ]);
    expect(results.map((result) => result.rank)).toEqual([1, 2]);
  });

  it('keeps a snippet to something a turn can afford, whitespace collapsed', () => {
    const [only] = searchResults(
      [row({ title: ' spaced \n title ', snippet: `x\n\n${'y'.repeat(900)}` })],
      SEARCH_RESULT_LIMIT
    );
    expect(only?.title).toBe('spaced title');
    expect(only?.snippet.length).toBe(400);
  });

  it('never returns more than the caller asked for, or than one page holds', () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      row({ href: `//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.invalid%2F${index}` })
    );
    expect(searchResults(rows, 3)).toHaveLength(3);
    expect(searchResults(rows, 99)).toHaveLength(SEARCH_RESULT_LIMIT);
  });
});

describe('which browser answers a search', () => {
  const plan = (overrides: Partial<Parameters<typeof searchRoutePlan>[0]> = {}) =>
    searchRoutePlan({
      actor: 'agent',
      sessionHolder: 'agent',
      sessionHostClosed: false,
      isolatedBackoffActive: false,
      ...overrides
    });

  it('goes to a browser of its own first, and keeps the session as a second attempt', () => {
    expect(plan()).toEqual(['isolated', 'session']);
  });

  // The failure this whole route exists to end: the owner takes over their own browser, which
  // garden tells them to do, and every research task stops until they hand it back.
  it('still searches while the owner is using the browser themselves', () => {
    expect(plan({ sessionHolder: 'user' })).toEqual(['isolated']);
    expect(plan({ sessionHolder: 'secure_input' })).toEqual(['isolated']);
    expect(plan({ sessionHolder: null })).toEqual(['isolated']);
  });

  // A challenge standing in the session browser used to refuse every later search for the session.
  // It now removes the second attempt and nothing else.
  it('drops the session attempt when a challenge already stands there, and searches anyway', () => {
    expect(plan({ sessionHostClosed: true })).toEqual(['isolated']);
  });

  it('falls through to the session while the isolated route is backing off', () => {
    expect(plan({ isolatedBackoffActive: true })).toEqual(['session']);
  });

  it('has nothing left only when both are unavailable at once', () => {
    expect(plan({ isolatedBackoffActive: true, sessionHolder: 'user' })).toEqual([]);
    expect(plan({ isolatedBackoffActive: true, sessionHostClosed: true })).toEqual([]);
  });

  it('never hands a user-initiated search a browser the agent is holding', () => {
    expect(plan({ actor: 'user', sessionHolder: 'agent' })).toEqual(['isolated']);
    expect(plan({ actor: 'user', sessionHolder: 'user' })).toEqual(['isolated', 'session']);
  });
});
