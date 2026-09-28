import { describe, expect, it } from 'vitest';
import {
  duplicatedWebCapabilities,
  resolveWebToolPlan,
  serverToolUseFrom,
  webCitationsFrom,
  SERVER_WEB_SEARCH_MAX_RESULTS,
  SERVER_WEB_SEARCH_MAX_USES,
  WEB_TOOL_DISCLOSURE,
  WebCitation,
  WebToolRouteReason,
  type WebToolRouteInput
} from './web-tools.js';

/** The route half of the plan, which is what every question about precedence is about. */
const resolveWebToolRoute = (input: WebToolRouteInput) => {
  const { mode, reason, disclosure } = resolveWebToolPlan(input);
  return { mode, reason, disclosure };
};

const serverWebTools = (input: WebToolRouteInput) => resolveWebToolPlan(input).serverTools;

/** The only combination of facts that lets a query leave the box. Everything else is a refusal. */
const permitting: WebToolRouteInput = { provider: 'openrouter' };

describe('web tool route', () => {
  it('answers searches on the provider only when nothing about the box forbids it', () => {
    expect(resolveWebToolRoute(permitting)).toEqual({
      mode: 'server',
      reason: 'provider_search_available',
      disclosure: WEB_TOOL_DISCLOSURE.server
    });
  });

  /**
   * The precedence this module used to have, and why it is gone.
   *
   * Two refusals stood above the provider check: a credential enforcing zero data retention, and a
   * conversation started on the zero-retention route. On an OpenRouter box those are one bit - the
   * credential's flag is what labels every model `provider_zdr`, and a task may only run on a model
   * whose route matches its own - and that bit ships on. So the shipped default refused provider
   * search everywhere, which on a server is the only search that works, and the owner was never
   * told that is what their privacy setting bought.
   *
   * It bought nothing. Zero-retention enforcement covers inference routing and says in terms that
   * it does not cover tools, so the query was outside that guarantee either way; refusing only
   * decided that the search would not happen. The retention facts are therefore not inputs here at
   * all, and this asserts the absence rather than trusting a comment to hold the line - a reason
   * added back would be a refusal added back.
   */
  it('names no retention reason, because a promise about inference never covered a search', () => {
    expect(WebToolRouteReason.options).toEqual([
      'forced_in_house',
      'provider_has_no_server_tools',
      'pinned_in_house_for_run',
      'provider_search_available'
    ]);
  });

  it('refuses an endpoint that has no server tools, rather than sending a name it will reject', () => {
    for (const provider of ['custom', 'openai-compatible', 'ollama-cloud', ''])
      expect(resolveWebToolRoute({ ...permitting, provider })).toMatchObject({
        mode: 'in_house',
        reason: 'provider_has_no_server_tools'
      });
  });

  it('lets the deployment take provider web tools off the box entirely', () => {
    expect(resolveWebToolRoute({ ...permitting, forceInHouse: true })).toMatchObject({
      mode: 'in_house',
      reason: 'forced_in_house'
    });
  });

  it('states the deployment override first, so the operator is told what actually decided it', () => {
    // Every refusal reaches the same mode; only the reason differs, and the reason is what the
    // settings page shows. An operator who set the override should not be told it was their model.
    expect(
      resolveWebToolRoute({ provider: 'custom', forceInHouse: true, startedMode: 'in_house' })
        .reason
    ).toBe('forced_in_house');
  });

  /**
   * The switch an owner who wants the old behaviour reaches for.
   *
   * It is the whole of the escape hatch now, so it has to be enough on its own: with it set, this
   * box searches in house on every task, exactly as a zero-retention credential used to make it -
   * and unlike the credential it takes no passkey step-up to set, which matters to an owner whose
   * saved credential is the thing holding their box in the broken state.
   */
  it('restores the old in-house-everywhere behaviour from the one switch that is about search', () => {
    for (const provider of ['openrouter', 'custom'])
      for (const startedMode of ['in_house', 'server', undefined] as const)
        expect(resolveWebToolRoute({ provider, forceInHouse: true, startedMode })).toEqual({
          mode: 'in_house',
          reason: 'forced_in_house',
          disclosure: WEB_TOOL_DISCLOSURE.in_house
        });
  });

  it('never resolves to the provider from an unspecified override', () => {
    for (const forceInHouse of [undefined, false])
      expect(resolveWebToolRoute({ ...permitting, forceInHouse }).mode).toBe('server');
  });

  // The owner can replace the stored credential from the settings page while a task is still
  // running. Without the pin, repointing the box at a provider that answers searches would move a
  // task that began under the in-house promise onto that search service, for a task the owner was
  // never asked about.
  it('keeps a run that started in house there after the fact that refused it stops being true', () => {
    expect(resolveWebToolRoute({ ...permitting, startedMode: 'in_house' })).toEqual({
      mode: 'in_house',
      reason: 'pinned_in_house_for_run',
      disclosure: WEB_TOOL_DISCLOSURE.in_house
    });
    expect(serverWebTools({ ...permitting, startedMode: 'in_house' })).toEqual([]);
  });

  it('still moves a run onto the in-house route the moment a refusing fact becomes true', () => {
    // The pin is one-directional on purpose: a deployment that takes provider search off the box
    // takes effect on the next step, cache prefix or no cache prefix.
    for (const refusing of [
      { ...permitting, forceInHouse: true },
      { ...permitting, provider: 'custom' }
    ])
      expect(resolveWebToolRoute({ ...refusing, startedMode: 'server' }).mode).toBe('in_house');
  });

  it('leaves a run that started on the provider alone while nothing has changed', () => {
    expect(resolveWebToolRoute({ ...permitting, startedMode: 'server' }).reason).toBe(
      'provider_search_available'
    );
    expect(resolveWebToolRoute({ ...permitting, startedMode: undefined }).mode).toBe('server');
  });

  it('reports the fact that refused this run, not the pin, while that fact still holds', () => {
    // The pin is not an explanation the owner can act on, and it is only the honest answer once
    // nothing else refuses.
    expect(
      resolveWebToolRoute({ ...permitting, forceInHouse: true, startedMode: 'in_house' }).reason
    ).toBe('forced_in_house');
  });

  it('says one sentence per mode and never asks a question', () => {
    for (const line of Object.values(WEB_TOOL_DISCLOSURE)) {
      expect(line.split('. ').length).toBe(1);
      expect(line).not.toContain('?');
    }
    // The line the owner reads has to name the disclosure, not merely mention that a choice exists.
    expect(WEB_TOOL_DISCLOSURE.server).toContain('sees the query');
    expect(WEB_TOOL_DISCLOSURE.in_house).toContain('your own computer');
  });
});

describe('provider web tools', () => {
  it('hands out nothing at all on any route that refused the provider', () => {
    for (const refusing of [
      { ...permitting, provider: 'custom' },
      { ...permitting, forceInHouse: true },
      { ...permitting, startedMode: 'in_house' as const }
    ])
      expect(serverWebTools(refusing)).toEqual([]);
  });

  it('sends the one provider tool with its ceilings pinned, never null', () => {
    const tools = serverWebTools(permitting);
    expect(tools.map((tool) => tool.type)).toEqual(['openrouter:web_search']);
    expect(tools[0]?.parameters).toEqual({
      engine: 'auto',
      max_results: SERVER_WEB_SEARCH_MAX_RESULTS,
      max_uses: SERVER_WEB_SEARCH_MAX_USES
    });
    // Left null, these are the unbounded research loop that arrives as a surprise on the bill.
    for (const tool of tools)
      for (const value of Object.values(tool.parameters)) expect(value).not.toBeNull();
  });

  /**
   * The provider's fetch is gone, and this is the assertion that keeps it gone.
   *
   * It could not be called by name any more than the search could, so all it ever did was let the
   * provider fetch pages on its own initiative - and it cost `parallel_web_read`, withdrawn to make
   * room for it, which is the tool three other descriptions send the model to for the second half of
   * a research pass. What a datacenter address gets refused for is asking a search engine, not
   * reading a page whose address is already known, so this box keeps the reads it can do.
   */
  it('asks the provider for the search it cannot run here, and nothing it can', () => {
    expect(serverWebTools(permitting).map((tool) => tool.type)).not.toContain(
      'openrouter:web_fetch'
    );
    expect(serverWebTools(permitting)).toHaveLength(1);
  });

  /**
   * One frozen value, handed to every caller rather than rebuilt per call, so nothing a caller does
   * to what it was given can change what the next task sends to a search service.
   */
  it('serialises byte-identically on repeated calls for the same facts', () => {
    const first = JSON.stringify(serverWebTools(permitting));
    for (let attempt = 0; attempt < 8; attempt += 1)
      expect(JSON.stringify(serverWebTools({ ...permitting }))).toBe(first);
  });

  it('cannot be mutated by a caller into something a later task would send', () => {
    const tools = serverWebTools(permitting);
    expect(() => {
      (tools[0] as { type: string }).type = 'openrouter:shell';
    }).toThrow();
    expect(() => {
      (tools[0]?.parameters as Record<string, unknown>).max_uses = 10_000;
    }).toThrow();
    expect(serverWebTools(permitting)[0]?.type).toBe('openrouter:web_search');
  });

  it('puts nothing on the wire but the two fields the provider reads', () => {
    // `supersedes` is garden's own bookkeeping. A third key here would travel in the tools array
    // of the search request, where the provider has no field to put it in.
    const tools = serverWebTools(permitting);
    // A plan that offered no provider-side tool at all would satisfy the loop below without a
    // single key being read, and the claim - that nothing extra travels - would be about nothing.
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) expect(Object.keys(tool).sort()).toEqual(['parameters', 'type']);
  });

  /**
   * The plan hands out no list of tools to take away, and that absence is the fix.
   *
   * A provider-side tool has no `function.name`, so withdrawing the in-house tool it answers for
   * left the model with a capability it had been told to use and no name to call it by: told to
   * start research with a search, it went looking for `web_search`, found nothing, and answered from
   * memory with invented sources. The verdict decides where a query goes. What the model is offered
   * is not its business any more.
   */
  it('takes no tool away from the model, on any combination of facts', () => {
    for (const provider of ['openrouter', 'custom', ''])
      for (const forceInHouse of [true, false, undefined])
        for (const startedMode of ['in_house', 'server', undefined] as const) {
          const plan = resolveWebToolPlan({ provider, forceInHouse, startedMode });
          expect(Object.keys(plan).sort()).toEqual(['disclosure', 'mode', 'reason', 'serverTools']);
          expect(plan.serverTools.length > 0).toBe(plan.mode === 'server');
          expect(plan.disclosure).toBe(WEB_TOOL_DISCLOSURE[plan.mode]);
        }
  });
});

describe('duplicated web capabilities', () => {
  /**
   * What this guards is no longer the agent's catalogue but the search request itself. That request
   * asks the provider to run one search and must offer the model no function tools at all: a request
   * carrying both would be asking the same question of two answerers in one breath, and which one
   * came back would depend on what the model reached for.
   */
  it('names a function tool on a request that is asking the provider to do its job', () => {
    const plan = resolveWebToolPlan(permitting);
    expect(
      duplicatedWebCapabilities(plan.serverTools, ['shell', 'web_search', 'file_read'])
    ).toEqual(['web_search']);
  });

  it('says nothing about the empty catalogue a search request actually carries', () => {
    const plan = resolveWebToolPlan(permitting);
    expect(duplicatedWebCapabilities(plan.serverTools, [])).toEqual([]);
    expect(
      duplicatedWebCapabilities(plan.serverTools, ['shell', 'browser_action', 'browser_snapshot'])
    ).toEqual([]);
    // And the agent's own request, which offers `web_search` by name on every route, is only ever
    // in breach if somebody puts a provider tool on it - which is what makes this the check that
    // the two arrangements cannot be mixed.
    const inHouse = resolveWebToolPlan({ ...permitting, forceInHouse: true });
    expect(
      duplicatedWebCapabilities(inHouse.serverTools, ['web_search', 'parallel_web_read'])
    ).toEqual([]);
  });
});

describe('citations from a provider annotation list', () => {
  it('reads the citation out of the field the annotation names after its own type', () => {
    expect(
      webCitationsFrom([
        {
          type: 'url_citation',
          url_citation: {
            url: 'https://example.invalid/rate',
            title: 'Rates',
            content: 'The rate was 4.25 per cent.'
          }
        }
      ])
    ).toEqual([
      {
        url: 'https://example.invalid/rate',
        title: 'Rates',
        excerpt: 'The rate was 4.25 per cent.'
      }
    ]);
  });

  it('reads a flat annotation too, so one provider spelling is not the only one understood', () => {
    expect(webCitationsFrom([{ url: 'https://example.invalid/flat', title: 'Flat' }])).toEqual([
      { url: 'https://example.invalid/flat', title: 'Flat' }
    ]);
  });

  it('keeps a page cited twice for two different claims, and drops the same claim twice', () => {
    const cited = webCitationsFrom([
      { type: 'url_citation', url_citation: { url: 'https://example.invalid/a', content: 'one' } },
      { type: 'url_citation', url_citation: { url: 'https://example.invalid/a', content: 'two' } },
      { type: 'url_citation', url_citation: { url: 'https://example.invalid/a', content: 'one' } }
    ]);
    expect(cited.map((citation) => citation.excerpt)).toEqual(['one', 'two']);
  });

  it('drops what has no address and keeps the rest of the list', () => {
    expect(
      webCitationsFrom([
        { type: 'file_citation', file_citation: { file_id: 'f-1', quote: 'no address' } },
        null,
        'https://example.invalid/string',
        { url: 'https://example.invalid/kept' }
      ])
    ).toEqual([{ url: 'https://example.invalid/kept', title: '' }]);
  });

  it('answers nothing at all when the provider attached no annotations', () => {
    for (const value of [undefined, null, [], {}, 'annotations'])
      expect(webCitationsFrom(value)).toEqual([]);
  });
});

describe('server tool counters', () => {
  it('reports what the provider says it spent, under the provider’s own counter names', () => {
    expect(serverToolUseFrom({ web_search_requests: 3, web_fetch_requests: 0 })).toEqual({
      web_search_requests: 3,
      web_fetch_requests: 0
    });
  });

  it('keeps the counters it understands when one arrives in a shape it does not', () => {
    // The searches the owner was billed for must not be lost because a counter this build has
    // never seen arrived beside them.
    expect(
      serverToolUseFrom({ web_search_requests: 2, something_new: { calls: 4 }, negative: -1 })
    ).toEqual({ web_search_requests: 2 });
  });

  it('answers nothing rather than an empty object when no provider tool ran', () => {
    for (const value of [undefined, null, {}, [], 7, { web_search_requests: 'many' }])
      expect(serverToolUseFrom(value)).toBeUndefined();
  });
});

describe('web citation', () => {
  it('keeps the passage OpenRouter attaches, which it sends as content', () => {
    // The shape of a url_citation on the wire. Reading only `excerpt` here drops the grounding
    // evidence from every citation the provider sends and leaves a bare link behind.
    expect(
      WebCitation.parse({
        url: 'https://example.invalid/a',
        title: 'A',
        content: 'The rate was 4.25 per cent.',
        start_index: 10,
        end_index: 42
      })
    ).toEqual({
      url: 'https://example.invalid/a',
      title: 'A',
      excerpt: 'The rate was 4.25 per cent.'
    });
  });

  it('keeps the passage a vendor native citation calls cited_text', () => {
    expect(WebCitation.parse({ url: 'https://example.invalid/b', cited_text: 'Quoted.' })).toEqual({
      url: 'https://example.invalid/b',
      title: '',
      excerpt: 'Quoted.'
    });
  });

  it('prefers an excerpt a caller already normalised over either raw field', () => {
    expect(
      WebCitation.parse({
        url: 'https://example.invalid/c',
        excerpt: 'chosen',
        content: 'raw',
        cited_text: 'raw'
      }).excerpt
    ).toBe('chosen');
  });

  it('accepts a citation with no passage at all, and one with no title', () => {
    expect(WebCitation.parse({ url: 'https://example.invalid/d' })).toEqual({
      url: 'https://example.invalid/d',
      title: ''
    });
    // Providers do send an explicit null here, which a plain default would refuse outright.
    expect(WebCitation.parse({ url: 'https://example.invalid/e', title: null }).title).toBe('');
    expect(WebCitation.parse({ url: 'https://example.invalid/f', content: '   ' }).excerpt).toBe(
      undefined
    );
  });

  it('trims an over-long title or passage rather than losing the source', () => {
    const parsed = WebCitation.parse({
      url: 'https://example.invalid/g',
      title: 'T'.repeat(1_000),
      content: 'C'.repeat(20_000)
    });
    expect(parsed.title).toHaveLength(300);
    expect(parsed.excerpt).toHaveLength(4_000);
  });

  it('refuses a citation that does not carry a real address', () => {
    expect(() => WebCitation.parse({ url: 'not-a-url', title: 'A' })).toThrow();
    expect(() => WebCitation.parse({ title: 'A' })).toThrow();
    for (const value of [null, 'https://example.invalid/h', ['https://example.invalid/i']])
      expect(() => WebCitation.parse(value)).toThrow();
  });
});
