import { isDeepStrictEqual } from 'node:util';
import { observedObject, withPrivateDiagnostics, withRuntimeObservations } from '@athanor/core';
import type { DataStore, TaskRecord } from '@athanor/data';
import { AgentWorker } from './agent.js';
import type { AgentWorkerConfig } from './agent-state.js';
import { silentLogger } from './log.js';
import { REPLAY_MASTER_KEY, RuntimeCodec } from './runtime-codec.js';
import { RuntimePlayback, type RuntimeEvent } from './runtime-tape.js';

export interface RuntimeSegment {
  start: { version: 1; workspaceId: string; input: unknown };
  events: RuntimeEvent[];
  end: { error: boolean; value?: unknown };
}

/** Executes the real turn controller against observations, without a store or tool executor. */
export async function replayRuntime(segment: RuntimeSegment) {
  const codec = new RuntimeCodec(segment.start.workspaceId);
  const input = codec.decode(segment.start.input) as {
    task: TaskRecord;
    config: AgentWorkerConfig;
    entry: 'run' | 'fail';
    error?: unknown;
    durationMs?: number;
    caches: ReturnType<AgentWorker['replayCaches']>;
  };
  if (segment.start.version !== 1 || input.task.workspaceId !== segment.start.workspaceId)
    throw new Error('Invalid runtime start');
  codec.ownerId = input.task.userId;
  const runtime = new RuntimePlayback(codec, segment.events);
  const worker = new AgentWorker(
    observedObject<DataStore>(undefined, 'store'),
    input.config,
    REPLAY_MASTER_KEY,
    'offline-replay-secret'.repeat(3),
    silentLogger
  );
  const sink = { active: true, record: async () => undefined };
  let timer: NodeJS.Timeout | undefined;
  let outcome: { error: boolean; value?: unknown };
  try {
    outcome = await Promise.race([
      withPrivateDiagnostics(sink, () =>
        withRuntimeObservations(runtime, async () => {
          worker.restoreReplayCaches(input.task.workspaceId, input.caches);
          try {
            if (input.entry === 'fail')
              await worker.fail(input.task, input.error, input.durationMs);
            else if (input.entry === 'run') await worker.run(input.task);
            else throw new Error('Unknown runtime entry');
            return { error: false };
          } catch (error) {
            return { error: true, value: codec.encode(error) };
          }
        })
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            runtime.abort('stalled runtime');
          } catch (error) {
            reject(error instanceof Error ? error : new Error('Runtime replay stopped'));
          }
        }, 30_000);
      })
    ]);
    if (!isDeepStrictEqual(outcome, segment.end)) runtime.abort('turn outcome');
    runtime.assertComplete();
    return runtime.result();
  } finally {
    clearTimeout(timer);
  }
}

import { z } from 'zod';
import { PrivateDiagnosticReader } from '@athanor/core';
const observation = z
  .object({
    type: z.enum(['value', 'call', 'return', 'callback', 'timer', 'fire', 'clear']),
    id: z.number().int().positive(),
    name: z.string().optional(),
    value: z.unknown().optional(),
    args: z.unknown().optional(),
    error: z.boolean().optional(),
    callback: z.string().optional(),
    milliseconds: z.number().finite().nonnegative().optional(),
    repeat: z.boolean().optional()
  })
  .strict();
const start = z
  .object({ version: z.literal(1), workspaceId: z.uuid(), input: z.unknown() })
  .strict();
const end = z.object({ error: z.boolean(), value: z.unknown().optional() }).strict();
const envelope = z.object({ segmentId: z.uuid(), value: z.unknown() }).strict();

export class CapturedRuntimeReplay {
  readonly reader = new PrivateDiagnosticReader();
  #segments = new Map<string, Partial<RuntimeSegment>>();
  #open = new Set<string>();
  #unsupported = false;
  accept(input: unknown) {
    const body = this.reader.accept(input);
    if (!body) return;
    const { segmentId, value } = envelope.parse(body.data);
    if (body.kind === 'segment_start') {
      if (this.#segments.has(segmentId)) throw new Error('Duplicate runtime segment');
      this.#segments.set(segmentId, { events: [] });
      this.#open.add(segmentId);
      return;
    }
    const segment = this.#segments.get(segmentId);
    if (!segment || !this.#open.has(segmentId)) throw new Error('Runtime record outside segment');
    if (body.kind === 'runtime_start') {
      if (segment.start) throw new Error('Duplicate runtime start');
      segment.start = start.parse(value);
      if (segment.start.workspaceId !== this.reader.header?.workspaceId)
        throw new Error('Wrong runtime workspace');
      const input = new RuntimeCodec(segment.start.workspaceId).decode(segment.start.input) as {
        task?: { id?: string };
      };
      if (input.task?.id !== this.reader.header?.taskId) throw new Error('Wrong runtime task');
    } else if (body.kind === 'runtime_event') {
      if (!segment.start || segment.end) throw new Error('Runtime observation outside turn');
      segment.events!.push(observation.parse(value));
    } else if (body.kind === 'runtime_end') {
      if (!segment.start || segment.end) throw new Error('Invalid runtime end');
      segment.end = end.parse(value);
    } else if (body.kind === 'segment_end') {
      if (!segment.start) this.#unsupported = true;
      this.#open.delete(segmentId);
    }
  }
  async replay() {
    if (!this.reader.result().complete || this.#open.size)
      throw new Error('Incomplete private capture');
    if (!this.#segments.size || this.#unsupported)
      return { available: false, complete: false, segments: 0, observations: 0 };
    let observations = 0;
    for (const segment of this.#segments.values()) {
      if (!segment.start || !segment.end || !segment.events?.length)
        throw new Error('Incomplete runtime observations');
      observations += (await replayRuntime(segment as RuntimeSegment)).observations;
    }
    return { available: true, complete: true, segments: this.#segments.size, observations };
  }
}
