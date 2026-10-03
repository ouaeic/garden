/**
 * A web search answered by the model provider, returned in the shape the in-house search returns.
 *
 * The route this exists for is the one garden actually ships on. A search engine challenges
 * datacenter address ranges as a matter of course, so the workspace's own browser - which is an
 * ordinary client making an ordinary request from wherever garden is installed - is answered with
 * an anti-bot challenge rather than results, and will be answered the same way next time, because
 * what is being refused is the address. `resolveWebToolPlan` in @garden/contracts decides that this
 * box searches on the provider instead. This is the half that then has to do it.
 *
 * The provider's search is not a function tool. It has no `function.name`, so no model can call it
 * by name; it is a name the provider recognises on a request and acts on itself. Sent in the
 * agent's own tools array with `web_search` withdrawn to make room, it would leave the model told
 * to start with a search, finding no search tool, and holding no name for what had replaced it -
 * and a model in that position, asked to research something and cite its sources, can make no tool
 * call at all and answer from memory with fabricated projects and fabricated addresses.
 *
 * So `web_search` stays a named function tool on both routes and this answers it: one request whose
 * only job is to run that query, built by garden, carrying the provider's tool and no function
 * tools at all. What comes back are the provider's `url_citation` annotations, which are the sources
 * it actually retrieved rather than the model's account of them, and those become the ranked result
 * rows the model already knows how to read.
 *
 * There is deliberately no fall back to the in-house browser when this fails. The owner was told, in
 * the composer and in the run's own context, that this run's queries go to their provider's search
 * service; quietly sending the same query to a search engine instead because the first attempt came
 * back thin would make that sentence false at the moment it mattered most.
 */

import type { ServerToolUse, WebCitation } from '@garden/contracts';
import { GardenError } from '@garden/core';
import type { ModelMessage } from '@garden/model-gateway';

/**
 * One result row, field for field what `services/workspace-runner/src/search.ts` returns for an
 * in-house search. Two routes answering one tool have to answer it in one shape: `originsFromResult`
 * reads `results[].url` to learn where the turn has been, the timeline renders these rows, and the
 * model was given a single description of what a search returns.
 */
export interface WebSearchResult {
  rank: number;
  title: string;
  url: string;
  /** The host on its own, because picking between ten links is mostly picking between sources. */
  site: string;
  snippet: string;
}

export interface WebSearchAnswer {
  engine: string;
  query: string;
  route: 'provider';
  results: WebSearchResult[];
  /** Said only when the result rows alone would be read as an answer they are not. */
  note?: string;
}

/** The runner's own bounds, so a result row is the same size whichever route produced it. */
const TITLE_LIMIT = 300;
const SNIPPET_LIMIT = 400;
const QUERY_LIMIT = 500;

const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();

/**
 * What the provider retrieved, as rows.
 *
 * Deduplicated on the address alone, which is the one place this deliberately differs from
 * `webCitationsFrom`: that keeps a page cited twice for two different claims, because two claims
 * need two pieces of evidence, and this is a list of sources to choose between, where the same page
 * arriving three times costs the model two of its ten choices.
 *
 * Anything without an ordinary web address is dropped rather than refused. A citation with a scheme
 * the model cannot follow is not a source it can be sent to read, and one malformed annotation is
 * not a reason to lose the nine beside it.
 */
export const providerSearchResults = (
  citations: readonly WebCitation[],
  limit: number
): WebSearchResult[] => {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (const citation of citations) {
    if (results.length >= Math.max(1, limit)) break;
    let address: URL;
    try {
      address = new URL(citation.url);
    } catch {
      continue;
    }
    if (address.protocol !== 'http:' && address.protocol !== 'https:') continue;
    if (seen.has(address.href)) continue;
    seen.add(address.href);
    results.push({
      rank: results.length + 1,
      title: collapse(citation.title).slice(0, TITLE_LIMIT),
      url: address.href,
      site: address.host,
      snippet: collapse(citation.excerpt ?? '').slice(0, SNIPPET_LIMIT)
    });
  }
  return results;
};

/**
 * The request that runs one search, written to be about retrieval and not about the question.
 *
 * The instruction to list every result back is not decoration and is not for the model's benefit -
 * the reply text is discarded unread. Annotations are attached to what a response cites, so a
 * response that was told to answer briefly cites two of the ten sources it was handed and the other
 * eight never reach the agent. Asking for the whole list, addresses included, is what makes the
 * annotation list the search results rather than a sample of them.
 *
 * It is told not to answer for the same reason the tool's own description tells the agent a snippet
 * is a pointer and never a citation: this call finds sources, and the model that asked for them is
 * the one that reads and judges them.
 */
export const providerSearchMessages = (query: string): ModelMessage[] => [
  {
    role: 'system',
    content:
      'You run one web search and nothing else. Search the web for exactly the query the user gives, then list every result the search returned, one per line, as the page title followed by its full URL. Cite each one. Do not answer the question the query is about, do not summarise, do not judge the sources, and never list a page you did not just retrieve - a fabricated address is worse here than an empty list, because whoever reads this cannot tell the two apart.'
  },
  { role: 'user', content: `Query: ${query}` }
];

/** Whether the provider's own counters say a search was actually run and billed. */
const searchWasRun = (serverToolUse: ServerToolUse | undefined): boolean =>
  Object.values(serverToolUse ?? {}).some((count) => count > 0);

/**
 * One `web_search` call, answered by the provider.
 *
 * `ask` is the whole of the provider contact, passed in rather than reached for, so every branch
 * below - the empty query, the provider that answered without searching, the search that cited
 * nothing - is exercisable without a network and without a credential.
 *
 * The two empty-handed outcomes are deliberately not one outcome. A provider that never ran the
 * search has told the agent nothing about the web, and answering that with an empty result list
 * would be handing back "there is nothing" as though it were a finding - which is exactly how the
 * failure this whole route exists to fix looked from inside the model. That one raises, so the agent
 * sees a failure it can act on. A search that ran and attached no sources is thin evidence rather
 * than none, and comes back as rows with a sentence saying what actually happened.
 */
export const providerWebSearch = async (input: {
  query: string;
  limit: number;
  /** What ran the search, for the trail. garden is not told which engine the provider chose. */
  engine: string;
  ask: (messages: ModelMessage[]) => Promise<{
    citations?: readonly WebCitation[];
    usage: { serverToolUse?: ServerToolUse };
  }>;
}): Promise<WebSearchAnswer> => {
  const query = collapse(input.query).slice(0, QUERY_LIMIT);
  if (!query) throw new GardenError('web_search_invalid', 'A web search needs a query');
  const response = await input.ask(providerSearchMessages(query));
  const results = providerSearchResults(response.citations ?? [], input.limit);
  if (results.length > 0) return { engine: input.engine, query, route: 'provider', results };
  if (!searchWasRun(response.usage.serverToolUse))
    throw new GardenError(
      'web_search_not_run',
      `The search service did not run a search for "${query}", so nothing was retrieved and this is not evidence that nothing exists. Search again in different words, or use browser_action and browser_snapshot if you already have an address.`
    );
  return {
    engine: input.engine,
    query,
    route: 'provider',
    results: [],
    note: 'The search ran and came back with no sources at all. Treat that as a search that failed to find them rather than as a web with nothing on the subject: re-query in different words, drop any site: or quoted terms, or reach a page directly with browser_action if you already have its address.'
  };
};
