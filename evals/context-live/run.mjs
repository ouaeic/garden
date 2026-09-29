import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFixture } from '../harness.ts';
import { arms, transform, usageOf, responseOf } from './candidate.mjs';
import { tasks, grade } from './tasks.mjs';
import { fixtureFiles } from './workspace.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const output = resolve(flag('--output', '/tmp/garden-context-ab'));
const repetitions = Number(flag('--repetitions', '3'));
const selected = flag('--task', 'all');
const chosen = tasks.filter((task) => selected === 'all' || selected.split(',').includes(task.id));
const selectedArms = flag('--arms', arms.join(',')).split(',');
if (
  !chosen.length ||
  !selectedArms.length ||
  selectedArms.some((arm) => !arms.includes(arm)) ||
  !Number.isInteger(repetitions) ||
  repetitions < 1 ||
  repetitions > 5
)
  throw new Error('Invalid task, arms or repetitions');
if (!args.includes('--live'))
  throw new Error('Explicit --live required; this spends Ollama Cloud quota');
if (!process.env.AI_API_KEY) throw new Error('AI_API_KEY required');
const baseUrl = process.env.AI_BASE_URL ?? 'https://ollama.com/v1';
if (baseUrl !== 'https://ollama.com/v1')
  throw new Error('This experiment is restricted to Ollama Cloud');
const model = 'deepseek-v4.1-flash';
const root = fileURLToPath(new URL('../../', import.meta.url));
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const nativeFetch = globalThis.fetch;
await mkdir(output, { recursive: true, mode: 0o700 });
const plan = {
  revision,
  startedAt: new Date().toISOString(),
  model,
  baseUrl,
  repetitions,
  tasks: chosen.map(({ id, request, runner, allowed, required }) => ({
    id,
    request,
    runner,
    allowed,
    required
  })),
  arms: selectedArms,
  design:
    'Sequential paired runs; cyclic arm order by task and repetition. No cache flushing is available; record all usage and warm-up order.',
  decision:
    'No production promotion from this exploratory sample alone. A candidate merits confirmation only with no correctness/authority regression, no extra tool failures, at least 10% lower total provider input, and no more than 10% extra model calls.',
  boundaries:
    'Real AgentWorker and model gateway; synthetic workspace files and fixed web responses. No actual commands, browsers, external writes or real owner documents. Output and task success scored independently. Runtime permissions are unchanged.',
  limits: {
    modelCallsPerTask: 12,
    maxOutputTokens: 2048,
    totalCalls: 400,
    maxInputTokens: 4000000,
    timeoutPerRequestMs: 90000
  },
  files: {}
};
for (const name of ['run.mjs', 'candidate.mjs', 'tasks.mjs', 'workspace.mjs', '../harness.ts']) {
  const { readFile } = await import('node:fs/promises');
  plan.files[name] = createHash('sha256')
    .update(await readFile(new URL(name, import.meta.url)))
    .digest('hex');
}
await writeFile(resolve(output, 'plan.json'), JSON.stringify(plan, null, 2));
let totalCalls = 0;
let totalInput = 0;
const results = [];
for (let repetition = 0; repetition < repetitions; repetition += 1) {
  for (let index = 0; index < chosen.length; index += 1) {
    const task = chosen[index];
    const rotation = (repetition + index) % selectedArms.length;
    const order = [...selectedArms.slice(rotation), ...selectedArms.slice(0, rotation)];
    for (const arm of order) {
      const id = `${task.id}-${repetition + 1}-${arm}`;
      const calls = [];
      const reads = [];
      const started = Date.now();
      globalThis.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (!url.startsWith(`${baseUrl}/`))
          throw new Error('Experiment refused non-Ollama network traffic');
        if (
          totalCalls >= plan.limits.totalCalls ||
          totalInput >= plan.limits.maxInputTokens ||
          calls.length >= plan.limits.modelCallsPerTask
        )
          throw new Error('Experiment usage ceiling reached');
        const original = JSON.parse(init.body);
        const body = transform(original, arm);
        body.max_tokens = Math.min(body.max_tokens ?? 2048, 2048);
        const call = {
          index: calls.length + 1,
          toolNames: (body.tools ?? []).map((tool) => tool.function.name),
          originalBytes: JSON.stringify(original).length,
          sentBytes: JSON.stringify(body).length,
          catalogueBytes: JSON.stringify(body.tools ?? []).length,
          messages: body.messages,
          usage: null,
          status: null,
          latencyMs: null
        };
        calls.push(call);
        totalCalls += 1;
        const sent = Date.now();
        try {
          const response = await nativeFetch(input, {
            ...init,
            body: JSON.stringify(body),
            signal: AbortSignal.any([
              ...(init.signal ? [init.signal] : []),
              AbortSignal.timeout(plan.limits.timeoutPerRequestMs)
            ])
          });
          call.status = response.status;
          reads.push(
            response
              .clone()
              .text()
              .then((text) => {
                call.latencyMs = Date.now() - sent;
                call.usage = usageOf(text);
                call.response = responseOf(text);
                totalInput += call.usage?.input ?? 0;
              })
              .catch(() => {
                call.streamIncomplete = true;
              })
          );
          return response;
        } catch (error) {
          call.error = error.name;
          throw error;
        }
      };
      let outcome;
      let error;
      try {
        outcome = await runFixture({
          id,
          shape: 'conversation',
          request: task.request,
          why: 'Measure the same owner task under alternative context payloads.',
          model: () => {
            throw new Error('Live experiment cannot use a scripted model');
          },
          live: {
            baseUrl,
            apiKey: process.env.AI_API_KEY,
            provider: 'openai-compatible',
            providerModelId: model,
            contextTokens: 131072
          },
          securityMode: 'autonomous',
          maxSteps: 12,
          runner: { ...task.runner, files: fixtureFiles(task.runner?.files) },
          expect: {}
        });
      } catch (caught) {
        error = caught.name;
      } finally {
        globalThis.fetch = nativeFetch;
      }
      await Promise.all(reads);
      if (outcome)
        outcome = {
          ...outcome,
          proposed: calls.flatMap((call) =>
            (call.response?.toolCalls ?? []).map((tool) => tool.name)
          )
        };
      const completed = outcome?.events.findLast((event) => event.kind === 'completed');
      const answer = completed?.payload?.answer ?? completed?.summary ?? '';
      const result = {
        id,
        task: task.id,
        arm,
        repetition: repetition + 1,
        order: order.indexOf(arm),
        durationMs: Date.now() - started,
        answer,
        grade: outcome ? grade(task, outcome, answer) : { success: false, efficientSuccess: false },
        error: error ?? outcome?.error ?? undefined,
        calls,
        outcome: outcome
          ? {
              status: outcome.status,
              proposed: outcome.proposed,
              tools: outcome.tools,
              failedTools: outcome.failedTools,
              toolFailures: outcome.toolFailures,
              holds: outcome.holds,
              events: outcome.events
            }
          : null
      };
      results.push(result);
      await writeFile(resolve(output, `${id}.json`), JSON.stringify(result, null, 2));
      await writeFile(resolve(output, 'results.json'), JSON.stringify({ plan, results }, null, 2));
      console.log(
        JSON.stringify({
          id,
          pass: result.grade.success,
          efficient: result.grade.efficientSuccess,
          calls: calls.length,
          input: calls.reduce((n, call) => n + (call.usage?.input ?? 0), 0),
          ms: result.durationMs,
          tools: outcome?.proposed,
          failures: outcome?.failedTools
        })
      );
      if (totalCalls >= plan.limits.totalCalls || totalInput >= plan.limits.maxInputTokens)
        throw new Error('Experiment total usage ceiling reached');
    }
  }
}
console.log(JSON.stringify({ completed: results.length, totalCalls, totalInput, output }));
