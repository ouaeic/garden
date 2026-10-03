/**
 * The provider seam, proved without a provider.
 *
 * Every test here runs offline. The key is a string that authenticates nothing, the base URL is
 * under `.invalid` - the TLD reserved so that a name in it can never resolve - and the wire is a
 * stub this file hands the driver, so a test that reached past the stub would fail on DNS rather
 * than bill an account. That arrangement is the point: a rig whose whole subject is unmeasured
 * spend has to be able to state its own bounds without spending anything to do it.
 *
 * WHAT IS REAL IN THESE TESTS. `ModelGateway` and `OpenAICompatibleAdapter` are, and that is why
 * the usage assertions below mean something: the numbers are not read out of a fixture object,
 * they are parsed by garden's own adapter out of frames shaped like a route's - including
 * `prompt_tokens_details.cached_tokens`, which is the spelling `readCacheUsage` looks for first.
 * The harness is stubbed, because `runFixture` is 500 lines of machinery this file is not about.
 *
 * HOW TO RUN IT, from the repository root:
 *
 *   NODE_OPTIONS=--conditions=development pnpm exec vitest run evals/bench/provider.test.ts
 *
 * `pnpm test` is `pnpm -r test`, which runs each workspace package's own vitest, and `evals/` is
 * not a workspace package - so nothing in `pnpm check` runs this file, exactly as nothing in
 * `pnpm check` runs any other rig under `evals/`. What `pnpm check` DOES cover is `pnpm typecheck`,
 * which type-checks it through `evals/tsconfig.json`'s `bench/*.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { runFixture, type ModelTurn, type ScriptContext } from '../harness.js';

import {
  providerCredential,
  providerDriver,
  providerModelIdOf,
  PROVIDER_KEY_VARIABLES,
  type ProviderDriver
} from './provider.js';

/**
 * A key that authenticates nothing and a host that cannot resolve.
 *
 * `AI_REQUIRE_ZDR` is off so the adapter does not first fetch `/models` to check which parameters
 * the zero-retention route declares - a real request on a real box, and a second thing for these
 * stubs to answer for no gain. The zero-retention branch is `AgentWorker.#gateway`'s own condition
 * and is asserted separately, from `providerCredential`, where it costs no wire at all.
 */
const ENV = {
  AI_API_KEY: 'not-a-real-key',
  AI_BASE_URL: 'https://provider.invalid/v1',
  AI_REQUIRE_ZDR: 'false'
} as const;

const CHAT_URL = 'https://provider.test/v1/chat/completions';

const encoder = new TextEncoder();

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

/** A streamed completion, in the frames a route sends. */
const streamOf = (frames: readonly string[]): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );

interface WireUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
  readonly cost?: number;
  readonly prompt_tokens_details?: { cached_tokens: number };
}

/** One answer: a word of text, one tool call, and the usage frame every route closes with. */
const answer = (usage: WireUsage): Response =>
  streamOf([
    sse({ model: 'z-ai/glm-5.3-flash', choices: [{ delta: { content: 'on it' } }] }),
    sse({
      choices: [
        {
          finish_reason: 'tool_calls',
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call-1',
                function: { name: 'shell', arguments: '{"executable":"/bin/sh"}' }
              }
            ]
          }
        }
      ]
    }),
    sse({ choices: [], usage })
  ]);

/** The request body garden's own adapter puts on the wire, in miniature. */
const requestBody = (): string =>
  JSON.stringify({
    model: 'openrouter/some-release',
    messages: [
      {
        role: 'system',
        content: [{ type: 'text', text: 'preamble', cache_control: { type: 'ephemeral' } }]
      },
      { role: 'user', content: 'add up the integers' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call-0', type: 'function', function: { name: 'shell', arguments: '{"args":[]}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'call-0', content: '137' }
    ],
    tools: [
      {
        type: 'function',
        function: { name: 'shell', description: 'run a command', parameters: {} }
      },
      { type: 'web_search', web_search: {} }
    ],
    temperature: 0.2,
    max_tokens: 4096,
    stream: true,
    stream_options: { include_usage: true }
  });

interface Rig {
  readonly driver: ProviderDriver;
  /** Every turn the stubbed harness took off the driver, in order. */
  readonly turns: readonly ModelTurn[];
  /** How many requests actually reached the wire, by URL. */
  readonly wire: readonly string[];
  /** One provider request, driven the way `runFixture`'s stub drives one. */
  step(): Promise<void>;
}

const context = (index: number): ScriptContext => ({
  index,
  step: index,
  lastMessage: '',
  messages: [],
  summarising: false,
  delegated: false,
  vision: false
});

let open: ProviderDriver | null = null;

afterEach(() => {
  open?.detach();
  open = null;
});

/**
 * A driver on a stubbed wire, with a stand-in for the harness installed the way `runFixture`
 * installs its own: by assigning `globalThis.fetch` AFTER `attach`. That order is the whole
 * mechanism under test - a wrapper that merely assigned itself would be gone by this line.
 */
const rig = (options: {
  readonly answers: readonly (() => Response)[];
  readonly maxCalls?: number;
  readonly maxSpendUsd?: number;
}): Rig => {
  const turns: ModelTurn[] = [];
  const wire: string[] = [];
  let answered = 0;
  const wireFetch = ((input: string | URL | Request): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    wire.push(url);
    const next = options.answers[Math.min(answered, options.answers.length - 1)];
    answered += 1;
    return Promise.resolve(next ? next() : new Response('{}'));
  }) as typeof fetch;

  const driver = providerDriver({
    model: 'openrouter/z-ai/glm-5.3-flash',
    env: ENV,
    fetch: wireFetch,
    bounds: { maxCalls: options.maxCalls ?? 10, maxSpendUsd: options.maxSpendUsd ?? 100 }
  });
  open = driver;
  driver.attach();

  // The harness, in one line of what it does: take the turn, fabricate a reply from it.
  let calls = 0;
  globalThis.fetch = ((): Promise<Response> => {
    turns.push(driver.script(context(calls)));
    calls += 1;
    return Promise.resolve(new Response('data: [DONE]\n\n'));
  }) as typeof fetch;

  return {
    driver,
    turns,
    wire,
    step: async (): Promise<void> => {
      await globalThis.fetch(CHAT_URL, { method: 'POST', body: requestBody() });
    }
  };
};

describe('the credential', () => {
  it('is absent until the environment holds one, and names which variable answered', () => {
    expect(providerCredential({})).toBeNull();
    // Empty is absent, which is what both env schemas already say with a z.preprocess.
    expect(providerCredential({ AI_API_KEY: '  ' })).toBeNull();
    expect(providerCredential({ OPENROUTER_API_KEY: 'k' })?.variable).toBe('OPENROUTER_API_KEY');
    // AI_API_KEY first, in the order apps/worker/src/agent.ts:460 reads them.
    expect(providerCredential({ AI_API_KEY: 'a', OPENROUTER_API_KEY: 'b' })).toMatchObject({
      variable: 'AI_API_KEY',
      apiKey: 'a',
      baseUrl: 'https://openrouter.ai/api/v1',
      provider: 'openrouter',
      enforceZeroDataRetention: true
    });
    // A custom endpoint is sent no `provider` block: the block is OpenRouter's own vocabulary.
    expect(
      providerCredential({ AI_API_KEY: 'a', AI_PROVIDER: 'openai-compatible' })
        ?.enforceZeroDataRetention
    ).toBe(false);
  });

  it('strips the provider prefix a release id carries, and leaves a bare slug alone', () => {
    expect(providerModelIdOf('openrouter/z-ai/glm-5.3-flash')).toBe('z-ai/glm-5.3-flash');
    expect(providerModelIdOf('custom/local-model')).toBe('local-model');
    expect(providerModelIdOf('z-ai/glm-5.3-flash')).toBe('z-ai/glm-5.3-flash');
  });
});

describe('the driver refuses to start', () => {
  /*
   * NO KEY, NO RUN - the assertion that makes "off by default" a fact rather than an intention.
   *
   * Nothing else in this rig can stop a provider call: `pnpm check` never imports this file, but
   * an import is one line and a default key read from a shell that happens to have one exported is
   * how a benchmark quietly starts billing. The throw is the bound that does not depend on anyone
   * remembering.
   */
  it('with no provider key in the environment', () => {
    expect(() =>
      providerDriver({
        model: 'openrouter/z-ai/glm-5.3-flash',
        env: {},
        bounds: { maxCalls: 1, maxSpendUsd: 1 }
      })
    ).toThrow(new RegExp(PROVIDER_KEY_VARIABLES.join(' or ')));
  });

  it('with no model, or with a ceiling that is not a ceiling', () => {
    const bounds = { maxCalls: 1, maxSpendUsd: 1 };
    expect(() => providerDriver({ model: '  ', env: ENV, bounds })).toThrow(/model id is required/);
    expect(() =>
      providerDriver({ model: 'm', env: ENV, bounds: { maxCalls: 0, maxSpendUsd: 1 } })
    ).toThrow(/maxCalls/);
    expect(() =>
      providerDriver({ model: 'm', env: ENV, bounds: { maxCalls: 1, maxSpendUsd: 0 } })
    ).toThrow(/maxSpendUsd/);
  });

  it('and never fabricates a turn it was not handed one for', () => {
    const driver = providerDriver({
      model: 'openrouter/z-ai/glm-5.3-flash',
      env: ENV,
      bounds: { maxCalls: 1, maxSpendUsd: 1 }
    });
    // A ScriptContext carries no tool catalogue, so there is nothing honest to send. It says so
    // rather than answering in prose, which is what a task scored 0 on a silent degradation is.
    expect(() => driver.script(context(0))).toThrow(/no answer in hand/);
  });
});

describe('the ceilings', () => {
  it('stop the run at the call ceiling, and say so in the turn and in stopped()', async () => {
    const rigged = rig({
      maxCalls: 2,
      answers: [
        () => answer({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.001 })
      ]
    });
    await rigged.step();
    await rigged.step();
    expect(rigged.driver.stopped()).toBeNull();
    await rigged.step();

    expect(rigged.driver.totals().calls).toBe(2);
    // The ceiling is enforced where it matters: the third request never left the process.
    expect(rigged.wire).toHaveLength(2);
    expect(rigged.driver.stopped()).toMatchObject({ bound: 'calls', atCall: 2 });
    expect(rigged.driver.stopped()?.detail).toContain('2 provider calls made, 2 allowed');
    // The turn the loop is handed carries no tool call, so the turn ends rather than looping.
    expect(rigged.turns[2]?.calls).toBeUndefined();
    expect(rigged.turns[2]?.text).toContain('call ceiling');
  });

  it('stop the run at the spend ceiling, priced from what the route reported', async () => {
    const rigged = rig({
      maxSpendUsd: 0.05,
      answers: [
        () => answer({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.03 })
      ]
    });
    // 0.03, then 0.06 - the ceiling is asked BEFORE a call, so the crossing call is paid for and
    // the one after it is refused. A ceiling asked after would have let a third request out.
    await rigged.step();
    await rigged.step();
    await rigged.step();

    expect(rigged.driver.totals().calls).toBe(2);
    expect(rigged.driver.totals().costUsd).toBeCloseTo(0.06, 10);
    expect(rigged.wire).toHaveLength(2);
    expect(rigged.driver.stopped()).toMatchObject({ bound: 'spend', atCall: 2 });
    expect(rigged.driver.stopped()?.detail).toContain('$0.0600 spent');
    expect(rigged.driver.stopped()?.detail).toContain('$0.0500 allowed');
    expect(rigged.turns[2]?.text).toContain('spend ceiling');
  });
});

describe('the totals', () => {
  /*
   * THE FIGURES ARE THE ROUTE'S OWN, AND THE TEST IS BUILT SO THAT AN ESTIMATE CANNOT PASS IT.
   *
   * `cost` is 0.4242 against 8,000 input and 120 output tokens, which no per-million price table
   * produces from those counts; a driver that multiplied tokens by a published rate would land
   * somewhere else and fail here. The second call then reports NO cost at all, and the assertion
   * is that the total does not move - the one behaviour a price table cannot have, because a price
   * table always has an answer. What moves instead is `unpricedCalls`, which is the number that
   * tells a reader of the row that `costUsd` is a floor.
   */
  it('are summed from the wire usage frames, and never from a price table', async () => {
    const rigged = rig({
      answers: [
        () =>
          answer({
            prompt_tokens: 8_000,
            completion_tokens: 120,
            total_tokens: 8_120,
            cost: 0.4242,
            prompt_tokens_details: { cached_tokens: 6_000 }
          }),
        () =>
          answer({
            prompt_tokens: 9_000,
            completion_tokens: 40,
            total_tokens: 9_040,
            prompt_tokens_details: { cached_tokens: 7_500 }
          })
      ]
    });
    await rigged.step();

    expect(rigged.driver.totals()).toEqual({
      calls: 1,
      inputTokens: 8_000,
      cachedInputTokens: 6_000,
      outputTokens: 120,
      costUsd: 0.4242,
      unpricedCalls: 0,
      estimatedCalls: 0
    });

    await rigged.step();

    expect(rigged.driver.totals()).toEqual({
      calls: 2,
      inputTokens: 17_000,
      cachedInputTokens: 13_500,
      outputTokens: 160,
      // Unmoved. An estimator would have added a second figure here.
      costUsd: 0.4242,
      unpricedCalls: 1,
      estimatedCalls: 0
    });
  });

  it('carry the model answer back into the shape evals/harness.ts accepts', async () => {
    const rigged = rig({
      answers: [
        () => answer({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.0001 })
      ]
    });
    await rigged.step();

    expect(rigged.turns[0]).toEqual({
      text: 'on it',
      calls: [{ id: 'call-1', name: 'shell', args: { executable: '/bin/sh' } }]
    });
    // The provider-side tool on the captured request is counted and left off: which of those may
    // travel is `resolveWebToolPlan`'s decision and not this rig's. @see decodeTools.
    expect(rigged.driver.serverToolsDropped()).toBe(1);
  });
});

describe('the wire trap', () => {
  /*
   * A request the harness forwards must reach the wire rather than come back here.
   *
   * `runFixture` saves `globalThis.fetch` at the start of a run - which, with this driver
   * attached, is the driver's own wrapper - and calls it again to forward `Fixture.workspaceUrl`
   * traffic to the real socket. Without the marker on the delegated request that forward re-enters
   * the wrapper, is delegated again, and the runner request never leaves the process: the bench's
   * one live seam would hang rather than fail, which is the worst way for a rig to break.
   */
  it('lets the harness forward a runner request straight through', async () => {
    const rigged = rig({ answers: [() => new Response('{"ok":true}')] });
    const saved = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      // What the harness does with a workspaceUrl request: hand it back to the fetch it saved.
      saved(input, init)) as typeof fetch;

    const response = await globalThis.fetch('http://127.0.0.1:4300/exec', { method: 'POST' });

    expect(await response.text()).toBe('{"ok":true}');
    expect(rigged.wire).toEqual(['http://127.0.0.1:4300/exec']);
    // Nothing was billed: a runner request is not a model call.
    expect(rigged.driver.totals().calls).toBe(0);
  });

  /*
   * The second re-entry, which the same marker covers: between two runs the slot holds the wrapper.
   *
   * `runFixture` puts back the fetch it saved when a fixture ends, and what it saved was the
   * wrapper - so from the last line of one task to the first line of the next, the wrapper's own
   * inner fetch IS the wrapper, and a request in that window is delegated to itself. Written as a
   * test of its own because it is a different arrangement of the globals from the one above and
   * arrives at the same line; a driver reused across a task set spends its whole life passing
   * through this window between tasks. Reproduced by the two lines `runFixture` brackets a run
   * with, and nothing in between.
   */
  it('sends a request made between two runs out exactly once', async () => {
    const rigged = rig({ answers: [() => new Response('{"ok":true}')] });
    const saved = globalThis.fetch;
    globalThis.fetch = saved;

    const response = await globalThis.fetch('http://127.0.0.1:4300/health');

    expect(await response.text()).toBe('{"ok":true}');
    expect(rigged.wire).toEqual(['http://127.0.0.1:4300/health']);
  });

  it('gives the global back on detach', () => {
    const before = globalThis.fetch;
    const driver = providerDriver({
      model: 'm',
      env: ENV,
      bounds: { maxCalls: 1, maxSpendUsd: 1 }
    });
    open = driver;
    driver.attach();
    expect(globalThis.fetch).not.toBe(before);
    driver.detach();
    expect(globalThis.fetch).toBe(before);
  });
});

describe('the whole seam, against the real runFixture', () => {
  /*
   * THE LINE THAT WAS NEVER WRITTEN, for this seam: everything above proves the driver in
   * isolation, and isolation is exactly how the shapes this programme keeps finding survive.
   *
   * So this one runs the REAL `runFixture` - the real `AgentWorker`, the real context layer, the
   * real tool catalogue - with `driver.script` as its model and the driver attached, and asserts
   * on what reached the wire. The single most important assertion is the catalogue: the request
   * this driver sends is decoded from the one garden's own adapter assembled, so `finish` and
   * `shell` appearing in the outgoing body is the proof that the window survived capture, decode
   * and re-encode. A driver composing a request from `ScriptContext` could not put them there,
   * because a `ScriptContext` has never carried them.
   *
   * The model answers in prose and calls nothing, so the turn is short and this test is about the
   * seam rather than about a solution. Nothing is billed: the wire is the stub above.
   */
  it('carries garden own window out and the model answer back', async () => {
    const sent: string[] = [];
    const wireFetch = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      sent.push(typeof init?.body === 'string' ? init.body : '');
      return Promise.resolve(
        answer({ prompt_tokens: 4_000, completion_tokens: 12, total_tokens: 4_012, cost: 0.002 })
      );
    }) as typeof fetch;

    const driver = providerDriver({
      model: 'openrouter/z-ai/glm-5.3-flash',
      env: ENV,
      fetch: wireFetch,
      bounds: { maxCalls: 4, maxSpendUsd: 1 }
    });
    open = driver;
    driver.attach();

    const outcome = await runFixture({
      id: 'provider-seam',
      shape: 'answer',
      request: 'Say hello and stop.',
      why: 'Proves evals/bench/provider.ts drives the real loop through the real gateway.',
      model: driver.script,
      maxSteps: 3,
      runner: { files: {} },
      expect: {}
    });

    // Every provider call the harness counted is a call this driver made and metered. A gap either
    // way would mean a request reached the stub without passing through the driver, or the reverse.
    expect(driver.totals().calls).toBe(outcome.modelCalls);
    expect(outcome.modelCalls).toBeGreaterThan(0);
    // A throw out of the loop would satisfy the count assertions above at one call and prove
    // nothing, so the run has to have been a run.
    expect(outcome.error).toBeNull();
    expect(driver.totals().inputTokens).toBe(4_000 * outcome.modelCalls);
    expect(driver.totals().costUsd).toBeCloseTo(0.002 * outcome.modelCalls, 10);

    const first = JSON.parse(sent[0] ?? '{}') as {
      model?: string;
      tools?: { function?: { name?: string } }[];
      messages?: { role?: string }[];
    };
    // The release prefix is stripped and the benchmark's model is what the route is asked for,
    // rather than the fixture's fictional release.
    expect(first.model).toBe('z-ai/glm-5.3-flash');
    expect(first.tools?.map((tool) => tool.function?.name)).toContain('shell');
    // Roles too, which `ScriptContext` also drops: a window with no system preamble is a different
    // prompt from the one garden priced.
    expect(first.messages?.map((message) => message.role)).toContain('system');
    expect(first.messages?.map((message) => message.role)).toContain('user');
  });
});
