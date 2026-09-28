import { describe, expect, it, vi } from 'vitest';
import type { WebCitation } from '@garden/contracts';
import type { GardenError } from '@garden/core';
import {
  providerSearchMessages,
  providerSearchResults,
  providerWebSearch
} from './provider-search.js';

const cited = (url: string, title = 'Title', excerpt?: string): WebCitation => ({
  url,
  title,
  ...(excerpt === undefined ? {} : { excerpt })
});

/** A provider that answers with the sources it retrieved, and says it spent a search doing it. */
const answering = (citations: WebCitation[], requests = 1) =>
  vi.fn(async () => ({
    citations,
    usage: { serverToolUse: { web_search_requests: requests } }
  }));

describe('a provider’s citations read as search results', () => {
  it('ranks them into the rows an in-house search returns, field for field', () => {
    // Two routes answer one tool, so they answer it in one shape. The model was given a single
    // description of what a search returns, `originsFromResult` reads `url` to learn where the turn
    // has been, and the timeline draws these rows - none of that may depend on who searched.
    expect(
      providerSearchResults(
        [
          cited('https://regulator.example/notice', 'Rate notice', 'Held at 4.25 per cent.'),
          cited('https://press.example/story?ref=feed', 'The story')
        ],
        10
      )
    ).toEqual([
      {
        rank: 1,
        title: 'Rate notice',
        url: 'https://regulator.example/notice',
        site: 'regulator.example',
        snippet: 'Held at 4.25 per cent.'
      },
      {
        rank: 2,
        title: 'The story',
        url: 'https://press.example/story?ref=feed',
        site: 'press.example',
        snippet: ''
      }
    ]);
  });

  it('keeps one row per page, because these are sources to choose between', () => {
    // Deliberately not what `webCitationsFrom` does. A provider grounding three claims in one page
    // sends three annotations and all three are evidence; a list of ten links where the same page
    // appears three times has cost the model two of its ten choices.
    const rows = providerSearchResults(
      [
        cited('https://one.example/a', 'A', 'first claim'),
        cited('https://one.example/a', 'A', 'second claim'),
        cited('https://two.example/b', 'B')
      ],
      10
    );
    expect(rows.map((row) => row.url)).toEqual(['https://one.example/a', 'https://two.example/b']);
    expect(rows.map((row) => row.rank)).toEqual([1, 2]);
  });

  it('drops a source the model could not be sent to read and keeps the rest of the list', () => {
    expect(
      providerSearchResults(
        [
          cited('mailto:someone@example.invalid', 'Not a page'),
          cited('https://kept.example/page', 'Kept')
        ],
        10
      ).map((row) => row.url)
    ).toEqual(['https://kept.example/page']);
  });

  it('gives back no more than the model asked for', () => {
    const rows = providerSearchResults(
      Array.from({ length: 9 }, (_, index) => cited(`https://site.example/${index}`)),
      3
    );
    expect(rows).toHaveLength(3);
    expect(rows.at(-1)?.rank).toBe(3);
  });
});

describe('the request that runs one search', () => {
  it('asks for every result back, because annotations only cover what a response cited', () => {
    // The reply text is discarded unread, so this instruction is not for the reader of it. A
    // response told to answer briefly cites two of the ten sources it was handed and the other eight
    // never reach the agent at all - asking for the whole list is what makes the annotation list the
    // search results rather than a sample of them.
    const messages = providerSearchMessages('agent frameworks released in 2026');
    const asked = messages.map((message) => message.content).join('\n');
    expect(asked).toContain('list every result');
    expect(asked).toContain('full URL');
    expect(asked).toContain('agent frameworks released in 2026');
  });

  it('sends the query and nothing else about the conversation', () => {
    // The owner was told one sentence: their queries go to their provider's search service. Not
    // their workspace, not the task, not what they typed - the query.
    const messages = providerSearchMessages('local rainfall records');
    expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(messages.at(-1)?.content).toBe('Query: local rainfall records');
  });

  it('tells the search runner not to answer, because a fabricated address is worse than none', () => {
    expect(providerSearchMessages('anything')[0]?.content).toContain(
      'never list a page you did not'
    );
  });
});

describe('a web search answered by the provider', () => {
  it('returns the sources it retrieved, named as the route that ran them', async () => {
    const ask = answering([cited('https://regulator.example/notice', 'Notice', 'Held.')]);
    await expect(
      providerWebSearch({ query: '  rate decision  ', limit: 10, engine: 'provider:search', ask })
    ).resolves.toEqual({
      engine: 'provider:search',
      query: 'rate decision',
      route: 'provider',
      results: [
        {
          rank: 1,
          title: 'Notice',
          url: 'https://regulator.example/notice',
          site: 'regulator.example',
          snippet: 'Held.'
        }
      ]
    });
  });

  /**
   * The fabrication, one level down.
   *
   * A response with no sources and no search spent is the provider answering out of the model's
   * memory. Handed back as an empty result list it would let the agent report that the web has
   * nothing on the subject, on the strength of a search that never happened - which is exactly what
   * the owner saw when the search tool was missing from the catalogue entirely.
   */
  it('raises rather than report a web with nothing on it when no search was run', async () => {
    const ask = vi.fn(async () => ({ citations: [], usage: {} }));
    const failure = await providerWebSearch({
      query: 'notable projects',
      limit: 10,
      engine: 'provider:search',
      ask
    }).catch((error: unknown) => error);
    expect((failure as GardenError).code).toBe('web_search_not_run');
    expect((failure as GardenError).message).toContain('not evidence that nothing exists');
    expect((failure as GardenError).message).toContain('browser_action');
  });

  it('says a search that ran and cited nothing failed to find, not that there is nothing', async () => {
    // The one case the two are genuinely different: the provider spent the call, so something was
    // asked of a search engine, and the honest answer is an empty list with the reason attached
    // rather than a raise that throws away the fact that the search did happen.
    const answer = await providerWebSearch({
      query: 'rate decision',
      limit: 10,
      engine: 'provider:search',
      ask: answering([], 1)
    });
    expect(answer.results).toEqual([]);
    expect(answer.note).toContain('re-query in different words');
  });

  it('refuses an empty query before it spends a provider call on it', async () => {
    const ask = answering([]);
    const failure = await providerWebSearch({
      query: '   ',
      limit: 10,
      engine: 'provider:search',
      ask
    }).catch((error: unknown) => error);
    expect((failure as GardenError).code).toBe('web_search_invalid');
    expect(ask).not.toHaveBeenCalled();
  });
});
