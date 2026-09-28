import { z } from 'zod';

/**
 * Where a web search and a web fetch are actually performed, and what that discloses.
 *
 * garden can answer a search two ways. In house means the workspace's own browser on the owner's
 * own machine: nothing leaves the box but the request the engine would have received from a person
 * sitting at it. On the provider means the model provider runs the search itself and hands the
 * model structured results with citations - faster, cheaper, and reachable from an address a search
 * engine will not serve directly.
 *
 * That last clause is why this file reads the way it does now. The in-house route is a browser
 * making an ordinary request from wherever garden is installed, and garden is built to be
 * installed on a server. Search engines challenge datacenter address ranges as a matter of course,
 * so on the deployment this product is designed for the in-house route does not degrade, it fails:
 * the engine answers with an anti-bot challenge instead of results, and it will answer the same way
 * to the next attempt, because what it is refusing is the address. Nothing in this repository may
 * work around a challenge. So a box whose only route is the in-house one is a box that cannot
 * search at all, and it finds that out one abandoned research task at a time.
 *
 * This module used to let zero data retention decide that, and it decided it twice. It read the
 * owner's stored credential enforcing zero retention, and it read the conversation's own privacy
 * route, and refused the provider on either. Those are not two facts: the credential's setting is
 * what labels every model in the catalogue `provider_zdr`, and a task may only run on a model whose
 * route matches its own, so a task's privacy route is a copy of the credential flag rather than
 * anything a conversation ever chose. The flag ships on. The result was that the shipped default
 * bought a promise about inference by spending the entire web, on every box, without saying so.
 *
 * The promise it was spending that on was never garden's to make. Zero-data-retention enforcement
 * is documented as covering inference routing only: "It does not apply to plugins and tools you
 * choose to enable, such as web search." A search query is frequently the most revealing sentence
 * in a conversation - more revealing than the answer - and it falls outside that guarantee whichever
 * way this file resolves. So reading the retention flag as a refusal never kept a query private. It
 * only kept the search from happening, and left the owner believing otherwise.
 *
 * What the owner is actually owed is the truth about where their queries go, in the place they
 * type them and in the model's own runtime context. That is what `WEB_TOOL_DISCLOSURE` is, and it
 * is the reason this decision is a contract rather than a flag: the settings page, the composer and
 * the tools that go on the wire all read this one verdict, so they cannot come to disagree.
 *
 * The two questions are therefore answered by the two settings that are about them. What a provider
 * may keep of an inference request is the credential's business, and reaches the wire as the
 * provider block on the request. Whether a search query may be sent to a search service at all is
 * `AI_FORCE_INHOUSE_WEB`, which was built for exactly this question, says so where it is declared,
 * and restores every previous refusal in one line of environment - no credential edit, and so no
 * passkey step-up, for an owner who wants the old behaviour back.
 *
 * What the two modes disclose, stated exactly rather than approximately. Provider search discloses
 * the query string, any domain filters, and an approximate location if one is configured, to
 * whoever runs the engine. Provider fetch additionally discloses which URLs the owner is interested
 * in, and a publisher may retain parameters passed in those URLs. Neither discloses the
 * conversation, the workspace, or any file. The in-house route discloses the query to the search
 * engine and nothing to the model provider.
 *
 * The mode is decided once per run, and the decision only ever moves one way afterwards. The
 * provider is read from the owner's stored credential, which they can replace from the settings
 * page while a task is still running: repointing a box at OpenRouter mid-run would otherwise flip a
 * task that began under the in-house promise into one sending its queries to a third party, without
 * the owner ever being asked about that task. So a run carries the mode it started on, in
 * `startedMode`, and a run that started in house stays in house until it ends. The other direction
 * is deliberately not pinned: a change that takes provider search off this box applies on the very
 * next step, because withholding a privacy fact that has just become true to protect a cache prefix
 * is the wrong trade every time.
 *
 * What the mode does not decide, and used to, is which tools the model is offered. That was the
 * mistake this revision repairs. A provider-side tool has no `function.name`: it is a name the
 * provider recognises on a request, not a name a model can call. It nevertheless travelled in the
 * same tools array as the function tools, with `web_search` and `parallel_web_read` withdrawn to
 * make room for it - so on the route this product ships on, the model was told by its operating
 * contract to start with a search, went looking for the search tool, found nothing by that name,
 * and had no name for what had replaced it. Asked to research something and cite sources, it made
 * no tool call at all and answered out of memory with invented projects, invented dates and
 * invented addresses. The catalogue was not degraded on that route; it was lying, and four other
 * tool descriptions still pointed at the two tools that had been taken away.
 *
 * So the catalogue is the same on both routes, and the mode decides only who answers a call. The
 * model calls `web_search` under one name, with one description, wherever it is running; in house
 * that call is answered by the workspace's own browser, and on the provider's route it is answered
 * by a request garden builds for the tool below and nothing else. The provider tool is an
 * implementation of a capability now, rather than a substitute for the name of one.
 */

export const WebToolMode = z.enum(['in_house', 'server']);
export type WebToolMode = z.infer<typeof WebToolMode>;

/**
 * Why the route came out the way it did, as a value rather than a sentence, so the timeline, the
 * settings page and the audit trail can each say it in their own words.
 */
export const WebToolRouteReason = z.enum([
  /** The deployment turned provider-side web tools off for every task on this box. */
  'forced_in_house',
  /** The model is reached through an endpoint that has no provider-side web tools to offer. */
  'provider_has_no_server_tools',
  /**
   * Nothing about the task forbids it any more, but this run already started in house, so it
   * finishes in house. Only reachable when a fact changed underneath a running task.
   */
  'pinned_in_house_for_run',
  /** Nothing stands in the way: the provider answers searches for this task. */
  'provider_search_available'
]);
export type WebToolRouteReason = z.infer<typeof WebToolRouteReason>;

export interface WebToolRouteInput {
  /** Which kind of endpoint the task's model is reached through. */
  provider: string;
  /** The deployment-wide override, `AI_FORCE_INHOUSE_WEB`. Absent means the owner has not set it. */
  forceInHouse?: boolean | undefined;
  /**
   * The mode this run has already been running under, where there is a run. Absent when the
   * question is about a task that has not started - which is what the settings page asks - and
   * carried on every step after the first once one has.
   */
  startedMode?: WebToolMode | undefined;
}

export interface WebToolRoute {
  mode: WebToolMode;
  reason: WebToolRouteReason;
  /** One sentence for the owner about where their queries go. Never more, and never a prompt. */
  disclosure: string;
}

/**
 * The only two sentences garden says about this.
 *
 * Deliberately not a per-search confirmation: a prompt on every search makes the tool unusable, and
 * an owner who has to answer the same question thirty times stops reading it by the fourth. This is
 * a standing statement about the box instead, shown where a conversation is typed and carried into
 * the model's runtime context, so nobody has to open the source to learn where a query went.
 */
export const WEB_TOOL_DISCLOSURE: Readonly<Record<WebToolMode, string>> = Object.freeze({
  in_house: 'Web searches run on your own computer.',
  server: "Web searches are answered by your model provider's search service, which sees the query."
});

/**
 * The route, resolved from the facts and nothing else.
 *
 * Order is precedence, and every branch before the last one is a refusal, so a fact that is missing
 * or wrong can only ever move the answer towards the in-house route. `provider` is compared against
 * the one provider that has server tools rather than against a list of ones that do not, so a new
 * kind of endpoint arrives refused rather than arrives trusted.
 *
 * The deployment override is checked first because it is the one an operator set deliberately, and
 * every refusal reaches the same mode: an operator who took provider search off this box should be
 * told that is what decided it, not told about their model.
 *
 * The run pin is checked last of the refusals rather than first, so it is only ever the reported
 * reason when it is the thing actually holding the line. A run held in house by the deployment
 * switch is still told that is why, on every step, which is the sentence the owner can act on;
 * `pinned_in_house_for_run` appears only when the fact that refused this run has since stopped
 * being true.
 *
 * Not exported: `resolveWebToolPlan` below is the only way in, because a caller holding the mode
 * on its own is a caller that can send the provider's tools while keeping the in-house ones.
 */
const resolveWebToolRoute = (input: WebToolRouteInput): WebToolRoute => {
  const inHouse = (reason: WebToolRouteReason): WebToolRoute => ({
    mode: 'in_house',
    reason,
    disclosure: WEB_TOOL_DISCLOSURE.in_house
  });
  if (input.forceInHouse === true) return inHouse('forced_in_house');
  if (input.provider !== 'openrouter') return inHouse('provider_has_no_server_tools');
  if (input.startedMode === 'in_house') return inHouse('pinned_in_house_for_run');
  return {
    mode: 'server',
    reason: 'provider_search_available',
    disclosure: WEB_TOOL_DISCLOSURE.server
  };
};

/**
 * A provider-side tool, which is not a function the client implements but a name the provider
 * recognises and runs on its own infrastructure. It travels in a `tools` array like a function tool
 * and has to survive serialisation without being wrapped in `{type:'function'}` - which would be
 * precisely the claim that this box answers the call.
 */
export interface ServerWebTool {
  readonly type: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/**
 * Ceilings, pinned rather than left null.
 *
 * These bound one request, and the request they bound is now the one garden builds to answer a
 * single `web_search` call rather than the agent's own step. That is what moved the use ceiling from
 * eight to two: eight was sized against a whole turn's research loop, where the runaway was the
 * expensive failure, and this request has one query to run. Two rather than one so that a provider
 * that reformulates a query it got nothing back from may do so once, which is the same second
 * attempt the tool's own description tells the model to make.
 *
 * Ten results is what one page of results has always been on the in-house route, so a search returns
 * the same amount of material to judge whichever route answered it.
 */
export const SERVER_WEB_SEARCH_MAX_USES = 2;
export const SERVER_WEB_SEARCH_MAX_RESULTS = 10;

/**
 * Every provider-side tool garden sends, each carried beside the in-house tool whose calls it
 * answers.
 *
 * The pairing lives in the same structure as the tool rather than in a list beside it because the
 * two can never be allowed to disagree. It no longer means a withdrawal - the in-house name stays in
 * the model's catalogue on every route - it means a request carrying this tool must not also offer
 * the model a function tool of that name, because such a request would be asking the provider to
 * search while telling the model to search for itself, and the answer would depend on which of the
 * two the model happened to reach for. `duplicatedWebCapabilities` below is what enforces it on the
 * way out. Only the tool half is ever serialised - `supersedes` is garden's own bookkeeping and has
 * no business on the wire.
 *
 * The provider's `web_fetch` used to stand here beside its search, and it is deliberately gone. It
 * was never callable by name either, so all it ever bought was pages the provider decided on its own
 * to fetch - and it cost `parallel_web_read`, withdrawn to make room for it, which is the tool three
 * other descriptions send the model to for the second half of a research pass. Reading a page whose
 * address is already known is not what a datacenter address gets refused for; a search engine
 * challenging the box is. So the in-house reader answers reads on every route, the browser is still
 * there for everything behind a session or a login, and the one thing this box genuinely cannot do
 * for itself is the one thing the provider is asked to do.
 */
const PROVIDER_WEB_TOOLS = Object.freeze([
  Object.freeze({
    supersedes: 'web_search',
    tool: Object.freeze({
      type: 'openrouter:web_search',
      parameters: Object.freeze({
        // `auto` resolves to the model vendor's own search where the model has one and to Exa
        // otherwise, so this is not a capability only the frontier models get.
        engine: 'auto',
        max_results: SERVER_WEB_SEARCH_MAX_RESULTS,
        max_uses: SERVER_WEB_SEARCH_MAX_USES
      })
    })
  })
]);

const SERVER_WEB_TOOLS: readonly ServerWebTool[] = Object.freeze(
  PROVIDER_WEB_TOOLS.map((entry) => entry.tool)
);

/**
 * Everything one run needs to know about the web, decided in a single call.
 *
 * The route and the tools that implement it are one decision, so they are one call. Asking
 * separately would mean resolving twice against facts the owner can edit from the settings page
 * between the two reads, and a run whose disclosure says one thing while its searches go somewhere
 * else is the failure this module exists to prevent.
 *
 * `serverTools` is empty on every route that stayed in house, and on the provider's route it is what
 * a search request carries. It is not a catalogue addition and must never be sent with the agent's
 * own tools beside it: the model is offered `web_search` by name on both routes, so a request that
 * carried both would be asking the same question twice, of two different answerers, in one breath.
 *
 * Nothing is withdrawn from the model's catalogue any more, which is why there is no longer a list
 * of withdrawals here. The browser tools in particular were always kept - they are the half of the
 * web nothing else reaches, everything behind a session, a login, a paywall or a form - and now
 * `web_search` and `parallel_web_read` are kept for the stronger reason that a tool the model cannot
 * name is a tool the model does not have.
 */
export interface WebToolPlan extends WebToolRoute {
  readonly serverTools: readonly ServerWebTool[];
}

export const resolveWebToolPlan = (input: WebToolRouteInput): WebToolPlan => {
  const route = resolveWebToolRoute(input);
  return route.mode === 'server'
    ? { ...route, serverTools: SERVER_WEB_TOOLS }
    : { ...route, serverTools: [] };
};

/**
 * The function tools on a request that is also asking the provider to do their job.
 *
 * The pairing above is a rule the request has to hold, and a rule nobody checks is a convention.
 * This is what lets the gateway check it on the way out, one line before the wire: the search
 * request is built in the worker and sent two packages away, so a caller that reached for the
 * agent's catalogue instead of an empty one would otherwise be told by nothing at all, and the
 * first evidence would be a model that sometimes searched one way and sometimes the other.
 */
export const duplicatedWebCapabilities = (
  serverTools: readonly ServerWebTool[],
  functionToolNames: readonly string[]
): readonly string[] => {
  const sending = new Set(serverTools.map((tool) => tool.type));
  const offered = new Set(functionToolNames);
  return PROVIDER_WEB_TOOLS.filter(
    (entry) => sending.has(entry.tool.type) && offered.has(entry.supersedes)
  ).map((entry) => entry.supersedes);
};

/**
 * The provider-side tools garden deliberately does not send, recorded here because this is the
 * file somebody reaches for when they notice how short the list above is.
 *
 * `openrouter:web_fetch`: dropped, and the argument is above `PROVIDER_WEB_TOOLS` because it is the
 * argument for what that list holds. In one line: it cost `parallel_web_read` and bought pages this
 * box can fetch for itself.
 *
 * `openrouter:shell`, code execution and hosted interpreters: refused. They run in network-isolated
 * containers that cannot install a package at runtime and cannot see the owner's files, against a
 * persistent Linux computer that can do both. The argument is set out in full above garden's own
 * exec route, in services/workspace-runner/src/execution.ts.
 *
 * `openrouter:apply_patch` and `openrouter:image_generation`: refused for the same reason in
 * smaller. garden's `file_patch` edits real files with conflict detection, and `generate_media`
 * prices a request against the owner's spend limit before anything is spent, which the provider
 * tool has no equivalent of.
 *
 * `openrouter:subagent`: refused. It accepts only provider server tools and rejects function tools
 * outright, so a subagent could not read the workspace - which is the entire point of garden's own
 * specialists.
 *
 * `openrouter:fusion`: held, not refused. A panel of models with an analyst is a real capability,
 * but its price is unpublished, and an unmetered spend does not belong in a product where one owner
 * pays the bill. It becomes buildable the day it is priced, through the same spend check
 * `generate_media` already uses.
 *
 * `openrouter:advisor`: wanted, and not yet built. Consulting a stronger model mid-generation on
 * one genuinely hard decision is the highest quality-per-token lever available and the one thing
 * garden cannot do at all today - a cheap lead model that meets a hard question can currently only
 * answer it badly or have the owner restart the task. It belongs on this same gate when it lands,
 * because a server tool is a server tool: zero retention does not cover it either.
 */

const CITATION_TITLE_LIMIT = 300;
/**
 * Long enough to hold the paragraph a claim came from, short enough that a dozen of them do not
 * become the answer. A provider that sends more is trimmed rather than refused - see below.
 */
const CITATION_EXCERPT_LIMIT = 4_000;

/**
 * The passage the provider attached, under whichever name that provider gives it.
 *
 * OpenRouter puts it in `content` on a `url_citation`; the vendors whose native citations arrive
 * through that route call it `cited_text`. Reading only one of those names is how the grounding
 * evidence gets silently dropped on every citation from the other, so all of them are read, in
 * garden's own order: an excerpt a caller has already normalised wins over either raw field.
 */
const citationPassage = (row: Record<string, unknown>): string | undefined => {
  for (const key of ['excerpt', 'content', 'cited_text']) {
    const value = row[key];
    if (typeof value === 'string' && value.trim() !== '')
      return value.slice(0, CITATION_EXCERPT_LIMIT);
  }
  return undefined;
};

/**
 * A grounded source the provider attached to an answer. Stronger evidence than a tool-call id,
 * because the provider fetched it rather than the model reporting that it did.
 *
 * Everything that is not the address itself is repaired rather than rejected, and that asymmetry is
 * deliberate: a citation whose title runs long, whose excerpt runs to a whole page, or whose title
 * arrives null - all of which real responses contain - is still a real source the owner can open,
 * and throwing it away to enforce a length would lose the evidence in order to protect the field
 * that was carrying it. A citation with no usable address is the one case where there is nothing
 * left to keep, so that alone is refused.
 */
export const WebCitation = z.preprocess(
  (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const row = value as Record<string, unknown>;
    const title =
      typeof row.title === 'string' ? row.title.slice(0, CITATION_TITLE_LIMIT) : undefined;
    const excerpt = citationPassage(row);
    return {
      url: row.url,
      ...(title === undefined ? {} : { title }),
      ...(excerpt === undefined ? {} : { excerpt })
    };
  },
  z.object({
    url: z.string().url(),
    title: z.string().max(CITATION_TITLE_LIMIT).default(''),
    /** The passage the provider says the claim came from, where it gives one. */
    excerpt: z.string().max(CITATION_EXCERPT_LIMIT).optional()
  })
);
export type WebCitation = z.infer<typeof WebCitation>;

/**
 * The citation as it arrives, which is one level deeper than the citation itself.
 *
 * A provider annotates an answer with `{type:'url_citation', url_citation:{url,title,content}}`,
 * naming the payload after the type. Reading `row.type` and unwrapping the field it names handles
 * that without a list of type names to keep current - and a shape that is already flat, or that
 * names a field it did not send, falls through to the row itself rather than being lost.
 */
const citationRow = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const nested = typeof row.type === 'string' ? row[row.type] : undefined;
  return typeof nested === 'object' && nested !== null && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : row;
};

/**
 * Every usable source in a provider's annotation list, in the order it cited them.
 *
 * Deduplicated on the address and the passage together rather than on the address alone: a provider
 * that grounds three separate claims in one page sends three annotations with three passages, and
 * collapsing those to one would throw away the evidence for two of the claims. What it does collapse
 * is the identical annotation arriving twice, which is what a streamed response does when it resends
 * the whole list on a later chunk instead of appending to it.
 *
 * Anything without a usable address is dropped rather than refused, because one malformed annotation
 * in a list of ten is not a reason to lose the other nine - and because there is nothing left in it
 * to keep. An answer's text never depends on this succeeding.
 */
export const webCitationsFrom = (value: unknown): WebCitation[] => {
  if (!Array.isArray(value)) return [];
  const citations: WebCitation[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const row = citationRow(entry);
    if (row === undefined) continue;
    const parsed = WebCitation.safeParse(row);
    if (!parsed.success) continue;
    const key = `${parsed.data.url}\n${parsed.data.excerpt ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push(parsed.data);
  }
  return citations;
};

/**
 * How many provider-side tool calls a response actually spent, keyed by the provider's own counter
 * name (`web_search_requests`, and whatever it adds later). Recorded so a search-heavy task is
 * visible against the owner's spend limit rather than arriving as a surprise line on the bill.
 */
export const ServerToolUse = z.record(
  z.string().min(1).max(64),
  z.number().int().nonnegative().max(1_000_000)
);
export type ServerToolUse = z.infer<typeof ServerToolUse>;

/**
 * The counters a response reported, entry by entry.
 *
 * Each is validated on its own so that one counter the provider has just started sending in a shape
 * this build does not recognise cannot discard the count of the searches the owner was actually
 * billed for. Nothing at all, rather than an empty object, when there is nothing to report: a task
 * that spent no provider tool call should carry no field saying so on every step of its trajectory.
 */
export const serverToolUseFrom = (value: unknown): ServerToolUse | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const counters: ServerToolUse = {};
  for (const [name, count] of Object.entries(value as Record<string, unknown>)) {
    const parsed = ServerToolUse.safeParse({ [name]: count });
    if (parsed.success) Object.assign(counters, parsed.data);
  }
  return Object.keys(counters).length > 0 ? counters : undefined;
};
