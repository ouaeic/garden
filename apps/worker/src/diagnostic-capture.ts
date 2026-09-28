import { randomUUID } from 'node:crypto';
import {
  diagnosticRecordAad,
  encryptBytes,
  unwrapDataKey,
  withPrivateDiagnostics,
  withRuntimeObservations,
  type PrivateDiagnosticKind,
  type PrivateDiagnosticSink
} from '@garden/core';
import { DIAGNOSTIC_RECORD_BYTES } from '@garden/contracts';
import type { DataStore, TaskRecord } from '@garden/data';
import { buildIdentity } from './build-identity.js';
import { RuntimeCodec, replayConfig } from './runtime-codec.js';
import { RuntimeRecorder } from './runtime-tape.js';

const MAX_PENDING_BYTES = 2 * DIAGNOSTIC_RECORD_BYTES;
const WRITE_DEADLINE_MS = 2500;

const bounded = async <T>(work: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Diagnostic storage timeout')),
          WRITE_DEADLINE_MS
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** One explicitly enabled capture, bound to a worker segment and its original workspace key. */
export class TaskDiagnosticCapture implements PrivateDiagnosticSink {
  readonly segmentId = randomUUID();
  #tail = Promise.resolve();
  #pendingBytes = 0;
  #accepting = true;

  private constructor(
    private readonly store: DataStore,
    private readonly task: TaskRecord,
    private readonly workerId: string,
    private readonly id: string,
    private readonly epoch: string,
    private readonly key: Buffer
  ) {}

  static async open(store: DataStore, task: TaskRecord, workerId: string, masterKey: Uint8Array) {
    try {
      const capture = await bounded(store.diagnostics.get(task.userId, task.id));
      if (capture?.status.state !== 'recording' || capture.workspaceId !== task.workspaceId)
        return null;
      const workspace = await bounded(store.getWorkspace(task.userId, task.workspaceId));
      if (!workspace?.wrappedKey) return null;
      const recorder = new TaskDiagnosticCapture(
        store,
        task,
        workerId,
        capture.status.id,
        capture.epoch,
        unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id)
      );
      await recorder.record('segment_start', {
        build: buildIdentity(),
        taskId: task.id,
        workspaceId: task.workspaceId,
        attempt: task.attempt,
        securityMode: task.securityMode,
        coverage: [
          'model_projections',
          'provider_attempts',
          'approval_decisions',
          'request_derivation',
          'harness_observations'
        ]
      });
      if (!recorder.#accepting) {
        recorder.key.fill(0);
        return null;
      }
      return recorder;
    } catch {
      return null;
    }
  }

  get active() {
    return this.#accepting;
  }

  async fail(reason: 'record_too_large' | 'write_failed' | 'unsupported_record') {
    if (!this.#accepting) return;
    this.#accepting = false;
    await withRuntimeObservations(undefined, () =>
      bounded(
        this.store.diagnostics.fail(
          this.id,
          this.task.id,
          this.workerId,
          this.segmentId,
          reason,
          this.epoch
        )
      )
    ).catch(() => undefined);
  }

  record(kind: PrivateDiagnosticKind, data: unknown): Promise<void> {
    if (!this.#accepting) return Promise.resolve();
    let serialized: string;
    try {
      serialized = JSON.stringify({
        version: 1,
        kind,
        at: new Date().toISOString(),
        data: { segmentId: this.segmentId, value: data }
      });
    } catch {
      return this.fail('unsupported_record');
    }
    const bytes = Buffer.byteLength(serialized);
    if (bytes > DIAGNOSTIC_RECORD_BYTES || this.#pendingBytes + bytes > MAX_PENDING_BYTES)
      return this.fail('record_too_large');
    this.#pendingBytes += bytes;
    const pending = withRuntimeObservations(undefined, () =>
      this.#tail
        .then(async () => {
          if (!this.#accepting) return;
          const accepted = await bounded(
            this.store.diagnostics.append({
              epoch: this.epoch,
              id: this.id,
              taskId: this.task.id,
              workerId: this.workerId,
              segmentId: this.segmentId,
              ...(kind === 'segment_start' ? { begin: true } : {}),
              ...(kind === 'segment_end' ? { final: true } : {}),
              seal: (sequence, previous) => {
                if (!this.#accepting) throw new Error('Diagnostic recording stopped');
                return encryptBytes(
                  Buffer.from(serialized),
                  this.key,
                  diagnosticRecordAad(this.id, sequence, previous)
                );
              }
            })
          );
          if (!accepted) this.#accepting = false;
        })
        .catch(() => this.fail('write_failed'))
        .finally(() => {
          this.#pendingBytes -= bytes;
        })
    );
    this.#tail = pending;
    return pending;
  }

  async run<T>(
    work: () => Promise<T>,
    runtime?: {
      config: Record<string, unknown>;
      caches: unknown;
      masterKey: Buffer;
      entry?: 'run' | 'fail';
      error?: unknown;
      durationMs?: number | undefined;
    }
  ): Promise<T> {
    try {
      if (!runtime) return await withPrivateDiagnostics(this, work);
      const codec = new RuntimeCodec(
        this.task.workspaceId,
        this.key,
        runtime.masterKey,
        this.task.userId
      );
      const config = replayConfig(runtime.config, codec);
      try {
        await this.record('runtime_start', {
          version: 1,
          workspaceId: this.task.workspaceId,
          input: codec.encode({
            task: this.task,
            config,
            caches: runtime.caches,
            entry: runtime.entry ?? 'run',
            error: runtime.error,
            durationMs: runtime.durationMs
          })
        });
      } catch {
        await this.fail('unsupported_record');
        return withPrivateDiagnostics(this, work);
      }
      const recorder = new RuntimeRecorder(codec, this);
      return await withPrivateDiagnostics(this, () =>
        withRuntimeObservations(recorder, async () => {
          try {
            const result = await work();
            await this.record('runtime_end', { error: false });
            return result;
          } catch (error) {
            try {
              await this.record('runtime_end', { error: true, value: codec.encode(error) });
            } catch {
              await this.fail('unsupported_record');
            }
            throw error;
          }
        })
      );
    } finally {
      await this.record('segment_end', { ended: true });
      await this.#tail;
      this.#accepting = false;
      this.key.fill(0);
    }
  }
}
