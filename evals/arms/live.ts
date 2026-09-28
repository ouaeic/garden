/**
 * The judged half: a real model, holding one arm's wire, doing the sample's work against a
 * deterministic computer.
 *
 * ── The key ────────────────────────────────────────────────────────────────────────────────────
 *
 * `OPENROUTER_API_KEY`, from the environment and nowhere else, and the three arms
 * `scripts/live-drill.mjs` established and `evals/agentdojo/judged.ts` followed: not asked for,
 * asked for and present, asked for and absent. The third splits on `GITHUB_ACTIONS` exactly as
 * `scripts/check-repository.mjs:116` does with its missing analyser - on a developer's machine it
 * explains and continues, on a runner it fails, because a workflow that asked for the live half
 * and did not get it has not done what it says it does. An optional check that skips silently is a
 * check that has stopped running and nobody has noticed.
 *
 * ── Why the numbers are the provider's and not this file's ─────────────────────────────────────
 *
 * `tokensIn` and `tokensOut` are read from the response's own `usage` block or they are not read
 * at all. A row the provider did not meter is marked `unmetered` and excluded from the token means
 * rather than being filled in with characters-divided-by-four, because the entire argument this rig
 * exists to settle is an argument about tokens, and an estimate that is wrong by a constant factor
 * in every arm is fine while an estimate that is wrong by a different factor per arm - which is
 * what happens when arms differ in how much of the prompt is tool schema - is a fabricated finding.
 *
 * ── Ghost runs ─────────────────────────────────────────────────────────────────────────────────
 *
 * No content, no tool call, and no output tokens. A provider returned nothing. Counted, printed,
 * and excluded from every primary metric: a bad ten minutes on somebody's inference fleet is not
 * evidence about a tool catalogue, and the arm that happened to run during it would take the
 * blame.
 */
import { DEFAULT_MODEL } from '../agentdojo/judged.js';
import { settingsFor } from './arms.js';
import { WORLD_ORACLE, type Oracle } from './world.js';
import { contractFor, knowledgeFor, toolsFor, type ContractCut } from './wire.js';
import type { ArmTask } from './tasks.js';

export interface KeyState {
  readonly apiKey: string | null;
  /** Printed whether or not the live half runs, so a silent skip is impossible. */
  readonly note: string;
  /** True when the caller asked for the live half and CI must not let it pass unrun. */
  readonly fatal: boolean;
}

/**
 * `variables` is which environment variables may answer, in order of preference. The general half
 * posts to one provider with a bare fetch and reads the one variable that route takes; the edit
 * axis sends through the worker's own gateway, which reads the worker's two variables in the
 * worker's order (`evals/bench/provider.ts`), and the gate that decides whether the run starts
 * has to read the same ones or a box configured the worker's way is told it has no key.
 */
export const resolveKey = (
  requested: boolean,
  environment: NodeJS.ProcessEnv = process.env,
  variables: readonly string[] = ['OPENROUTER_API_KEY']
): KeyState => {
  const answered = variables.find((name) => (environment[name] ?? '').trim() !== '');
  const apiKey = answered === undefined ? '' : (environment[answered] as string);
  if (!requested)
    return {
      apiKey: null,
      note: 'live run: not requested. The offline half prices what each arm carries on every request, exactly; it cannot say whether an arm finishes the work, and a tie in its table means the instrument is blind there rather than that the candidate is free.',
      fatal: false
    };
  if (apiKey) return { apiKey, note: `live run: ${answered} found.`, fatal: false };
  return {
    apiKey: null,
    note: `live run: --live was asked for and ${variables.join(' or ')} is not set. This repository holds no provider credential by design; export the key the way scripts/live-drill.mjs takes it.`,
    fatal: !!environment.GITHUB_ACTIONS
  };
};

/**
 * The weak tier, imported rather than repeated.
 *
 * It is the same checkpoint the injection rig already spends against, and the reason to keep the
 * two the same is that a weak model is where a harness's ergonomics are visible at all: the strong
 * one absorbs a missing tool by paying more turns for it and still finishing, which reads as a tie
 * on the column most people look at. The strong tier has no default here on purpose - the shipped
 * default is whatever an installation sets `AI_DEFAULT_MODEL` to, and inventing one would put a
 * model nobody runs into a table titled "shipped".
 */
export const WEAK_TIER = DEFAULT_MODEL;

export const MAX_STEPS = 12;
export const MAX_OUTPUT_TOKENS = 1_200;

export interface RunRow {
  readonly armId: string;
  readonly taskId: string;
  readonly shape: string;
  readonly tier: string;
  readonly seed: number;
  /** Reached `finish`. */
  readonly completed: boolean;
  /** Provider round trips. Where a missing tool is paid for. */
  readonly modelCalls: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** True when the provider metered every call of this row. Only these enter the token means. */
  readonly metered: boolean;
  readonly toolsCalled: readonly string[];
  /** Nothing came back at all. Diagnostic; never a primary metric. */
  readonly ghost: boolean;
  /** The step ceiling stopped it. Distinct from "the model chose not to finish". */
  readonly ranOut: boolean;
  readonly error?: string;
}

export interface Usage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
}
export interface Choice {
  readonly message?: {
    readonly content?: string | null;
    readonly tool_calls?: Array<{
      readonly id?: string;
      readonly function?: { readonly name?: string; readonly arguments?: string };
    }>;
  };
}

/** A tool as it travels on the wire, which is the one shape every transport below has to accept. */
export interface WireTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

/**
 * The wire, as a function: one request out, one choice and one usage frame back.
 *
 * It is a parameter of `runOne` so the edit axis can carry its calls through garden's own
 * gateway - the worker's client, retry policy and usage parsing - while the general half keeps
 * the bare fetch it has always used. Both answer in the same shape, so the loop that reads the
 * answer does not know which one it is holding. @see `edit-live.ts`.
 */
export type Transport = (
  apiKey: string,
  model: string,
  messages: readonly unknown[],
  tools: readonly WireTool[]
) => Promise<{ readonly choice: Choice; readonly usage: Usage | null }>;

const openAiTools = (armId: string): WireTool[] =>
  toolsFor(settingsFor(armId)).map((tool) => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  }));

/** The bare fetch against the one route the key names, which is what the general half runs. */
export const openRouterTransport: Transport = async (apiKey, model, messages, tools) => {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      tools,
      temperature: 0,
      max_tokens: MAX_OUTPUT_TOKENS
    })
  });
  if (!response.ok)
    throw new Error(
      `${model} refused (${response.status}): ${(await response.text()).slice(0, 400)}`
    );
  const body = (await response.json()) as { choices?: Choice[]; usage?: Usage };
  return { choice: body.choices?.[0] ?? {}, usage: body.usage ?? null };
};

/**
 * One arm, one task, one seed.
 *
 * The loop is bounded by `MAX_STEPS` and the ceiling is recorded when it binds, because "did not
 * finish" and "was not allowed to finish" are different findings and an arm that needs more turns
 * is precisely the arm this rig is looking for. Folding the two would score the slow arm as broken.
 */
export const runOne = async (
  apiKey: string,
  model: string,
  armId: string,
  task: ArmTask,
  seed: number,
  cut: ContractCut = {},
  // The world is a parameter because the edit arm asks the same questions of a different one. It
  // is reset here rather than by the caller: a world the caller has to remember to reset is a world
  // whose first forgotten reset shows up as one arm reading a file the previous arm wrote.
  oracle: Oracle = WORLD_ORACLE,
  transport: Transport = openRouterTransport
): Promise<RunRow> => {
  oracle.reset();
  const settings = settingsFor(armId);
  const tools = openAiTools(armId);
  const messages: unknown[] = [
    { role: 'system', content: contractFor(settings, cut) },
    { role: 'system', content: knowledgeFor(settings) },
    { role: 'user', content: task.request }
  ];
  const called: string[] = [];
  let modelCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let metered = true;
  let completed = false;
  let sawAnything = false;
  try {
    while (modelCalls < MAX_STEPS && !completed) {
      const { choice, usage } = await transport(apiKey, model, messages, tools);
      modelCalls += 1;
      if (usage?.prompt_tokens === undefined || usage?.completion_tokens === undefined)
        metered = false;
      tokensIn += usage?.prompt_tokens ?? 0;
      tokensOut += usage?.completion_tokens ?? 0;
      const calls = choice.message?.tool_calls ?? [];
      if (choice.message?.content || calls.length) sawAnything = true;
      messages.push({
        role: 'assistant',
        content: choice.message?.content ?? null,
        ...(calls.length ? { tool_calls: calls } : {})
      });
      if (!calls.length) break;
      for (const call of calls) {
        const name = call.function?.name ?? '';
        called.push(name);
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function?.arguments ?? '{}') as Record<string, unknown>;
        } catch {
          // A malformed argument bag is still a call the model chose to make, and the name is what
          // the tool-axis question reads. Dropping the row would score a choice as a refusal.
        }
        const result = oracle.answer(name, args);
        if (result.terminal) completed = true;
        messages.push({ role: 'tool', tool_call_id: call.id ?? 'call', content: result.content });
      }
    }
  } catch (error) {
    return {
      armId,
      taskId: task.id,
      shape: task.shape,
      tier: model,
      seed,
      completed: false,
      modelCalls,
      tokensIn,
      tokensOut,
      metered: false,
      toolsCalled: called,
      ghost: false,
      ranOut: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
  return {
    armId,
    taskId: task.id,
    shape: task.shape,
    tier: model,
    seed,
    completed,
    modelCalls,
    tokensIn,
    tokensOut,
    metered,
    toolsCalled: called,
    ghost: !sawAnything && tokensOut === 0,
    ranOut: !completed && modelCalls >= MAX_STEPS
  };
};

export const estimateCalls = (
  armIds: readonly string[],
  tasks: readonly ArmTask[],
  tiers: readonly string[],
  seeds: number
): number => armIds.length * tasks.length * tiers.length * seeds * MAX_STEPS;

export const runLive = async (
  apiKey: string,
  armIds: readonly string[],
  tasks: readonly ArmTask[],
  tiers: readonly string[],
  seeds: number,
  cut: ContractCut = {}
): Promise<readonly RunRow[]> => {
  const rows: RunRow[] = [];
  for (const tier of tiers)
    for (const armId of armIds)
      for (const task of tasks)
        for (let seed = 0; seed < seeds; seed += 1)
          rows.push(await runOne(apiKey, tier, armId, task, seed, cut));
  return rows;
};
