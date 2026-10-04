/**
 * Web search, as one route rather than as a browsing procedure the model has to improvise.
 *
 * The engine is DuckDuckGo's no-JavaScript results endpoint, and the choice is a deliberate one.
 * Every search API in this category wants an account and a key, which a fresh box does not have
 * and which would put a third party on the path of every question the owner asks. Of the engines
 * that answer without one, this is the only one that both permits it - html.duckduckgo.com serves
 * `Allow: /` to every user agent, where the engines whose results are richer disallow their search
 * paths outright - and renders title, link and snippet into plain HTML, so reading a result page
 * needs no more of the browser than reading any other page does.
 *
 * It does not run in the session browser, because a search is not a browsing session and sharing
 * one is wrong in three ways that all have the same shape. A challenge on the engine would close
 * that host for the rest of the session, so the first challenge would take the whole web capability
 * off the task - and the tool's own advice, carry on elsewhere, would have no elsewhere to point
 * at. A search would require the agent to be holding the browser, so every research task would stop
 * dead while the owner was using their own Chromium, which garden actively encourages them to do.
 * And all three delegated specialists would contend on that one session, so one wall would take
 * down the lead and every specialist at once.
 *
 * So a search runs where a one-shot read runs: an isolated browser with no profile, no cookies and
 * no shared state, launched for the search and closed after it, exactly as `readMany` does. The
 * session browser stays as a second attempt and only as one, because the argument for it survives
 * in that narrower form - the profile persists, so a challenge the owner cleared there stays
 * cleared, and a search that the isolated browser could not get is worth trying once through the
 * door the owner already opened. Nothing about the isolated attempt touches the session's walls,
 * and nothing about it needs the session browser to exist.
 */

/** What the results page yields before any of it is trusted. */
export interface RawSearchRow {
  href: string | null;
  title: string | null;
  snippet: string | null;
  advert: boolean;
}

export interface WebSearchResult {
  rank: number;
  title: string;
  url: string;
  /** The host on its own, because picking between ten links is mostly picking between sources. */
  site: string;
  snippet: string;
}

export const SEARCH_ENGINE = 'duckduckgo';

/** Ten is one page of results; asking for more would mean a second request per search. */
export const SEARCH_RESULT_LIMIT = 10;

/** Which browser answered a search, reported back so the trail says where the query went. */
export type SearchRoute = 'isolated' | 'session';

/**
 * How long a challenge on the isolated route holds that route off.
 *
 * Far shorter than the half hour a site is closed for in the session browser, and deliberately so:
 * that cooldown exists because retrying from the same profile, the same cookies and the same tab is
 * the retry the challenge is asking for, made against the owner's own address. A fresh isolated
 * browser is a different client every time, so the only thing worth avoiding here is hammering, and
 * a minute is long enough that no loop can sit on the engine.
 *
 * It is a rate limit and not a remedy: waiting it out helps when the challenge was about a moment,
 * and does nothing at all when it was about the address, which is the usual case on a server, so
 * `searchWallMessage` does not promise otherwise. The route that does work from a datacenter
 * address is the provider's own search, which `resolveWebToolPlan` in @garden/contracts hands this
 * box by default.
 */
export const SEARCH_WALL_BACKOFF_MS = 60_000;

/**
 * Which browsers may answer this search, in the order they are worth trying.
 *
 * The session browser is only ever a second attempt, and only when it can actually help: the actor
 * has to be the one holding it, because a search must not steal a browser the owner is typing in,
 * and the engine must not already be standing a challenge against that profile, because trying
 * again through it is the retry the wall is asking for. An empty plan is only reachable while the
 * isolated route is backing off and no usable session exists, which is the one case where the
 * honest answer is the remembered wall rather than another launch.
 */
export const searchRoutePlan = (input: {
  actor: 'agent' | 'user';
  sessionHolder: 'agent' | 'user' | 'secure_input' | null;
  sessionHostClosed: boolean;
  isolatedBackoffActive: boolean;
}): SearchRoute[] => [
  ...(input.isolatedBackoffActive ? [] : (['isolated'] as const)),
  ...(input.sessionHolder === input.actor && !input.sessionHostClosed ? (['session'] as const) : [])
];

const QUERY_LIMIT = 500;
const TITLE_LIMIT = 300;
/**
 * Long enough to tell a source that answers the question from one that merely mentions it, short
 * enough that ten of them still leave room for the rest of the turn.
 */
const SNIPPET_LIMIT = 400;

const DUCKDUCKGO_ORIGIN = 'https://duckduckgo.com';

export const duckDuckGoSearchUrl = (query: string): string => {
  const trimmed = query.trim();
  if (!trimmed) throw new Error('A web search needs a query');
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(trimmed.slice(0, QUERY_LIMIT))}`;
};

/**
 * Results link through a redirector, so the destination has to be taken out of the query string.
 * Anything that is not an ordinary web address after that - an ad slot, an internal link, a
 * scheme the browser would treat as code - is dropped rather than handed on as a source.
 */
export const unwrapResultLink = (href: string): string | null => {
  let resolved: URL;
  try {
    resolved = new URL(href, DUCKDUCKGO_ORIGIN);
  } catch {
    return null;
  }
  if (resolved.hostname === 'duckduckgo.com' || resolved.hostname.endsWith('.duckduckgo.com')) {
    const destination = resolved.searchParams.get('uddg');
    if (!destination) return null;
    try {
      resolved = new URL(destination);
    } catch {
      return null;
    }
  }
  return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.href : null;
};

const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();

export const searchResults = (rows: RawSearchRow[], limit: number): WebSearchResult[] => {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (results.length >= Math.min(limit, SEARCH_RESULT_LIMIT)) break;
    if (row.advert || !row.href || !row.title) continue;
    const url = unwrapResultLink(row.href);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    results.push({
      rank: results.length + 1,
      title: collapse(row.title).slice(0, TITLE_LIMIT),
      url,
      site: new URL(url).host,
      snippet: collapse(row.snippet ?? '').slice(0, SNIPPET_LIMIT)
    });
  }
  return results;
};

/**
 * Runs inside the results page, so it is written to be shipped there: no imports, no closure, and
 * nothing to decide. Everything worth judging is judged by `searchResults` on this side, where it
 * can be tested without a browser.
 */
export const readSearchRows = (): RawSearchRow[] =>
  Array.from(document.querySelectorAll('.result'))
    .slice(0, 40)
    .map((node) => {
      const link = node.querySelector('a.result__a');
      const snippet = node.querySelector('.result__snippet');
      return {
        href: link?.getAttribute('href') ?? null,
        title: link?.textContent?.trim() ?? null,
        snippet: snippet?.textContent?.trim() ?? null,
        advert: node.className.includes('result--ad')
      };
    });
