import { isDeepStrictEqual } from 'node:util';
import {
  withRuntimeObservations,
  type RuntimeObservations,
  type PrivateDiagnosticSink
} from '@athanor/core';
import type { RuntimeCodec } from './runtime-codec.js';

export type RuntimeEvent = {
  type: 'value' | 'call' | 'return' | 'callback' | 'timer' | 'fire' | 'clear';
  id: number;
  name?: string | undefined;
  value?: unknown;
  args?: unknown;
  error?: boolean | undefined;
  callback?: string | undefined;
  milliseconds?: number | undefined;
  repeat?: boolean | undefined;
};

function replaceCallbacks(
  value: unknown,
  bind: (fn: (...args: unknown[]) => unknown) => unknown
): unknown {
  if (typeof value === 'function') return bind(value as (...args: unknown[]) => unknown);
  if (Array.isArray(value)) return value.map((entry) => replaceCallbacks(entry, bind));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, replaceCallbacks(entry, bind)])
    );
  return value;
}

export class RuntimeRecorder implements RuntimeObservations {
  readonly mode = 'record';
  #next = 0;
  #timers = new Map<NodeJS.Timeout, number>();
  constructor(
    readonly codec: RuntimeCodec,
    private readonly sink: PrivateDiagnosticSink
  ) {}

  private emit(row: RuntimeEvent) {
    try {
      void this.sink
        .record('runtime_event', row)
        .catch(() => this.sink.fail?.('unsupported_record'));
    } catch {
      void this.sink.fail?.('unsupported_record');
    }
  }

  private encode(value: unknown, callbacks?: Map<string, (...args: unknown[]) => unknown>) {
    if (this.sink.active === false) return undefined;
    try {
      return this.codec.encode(value, callbacks);
    } catch {
      void this.sink.fail?.('unsupported_record');
      return undefined;
    }
  }

  value<T>(name: string, read: () => T): T {
    const id = ++this.#next;
    try {
      const value = read();
      this.emit({ type: 'value', id, name, value: this.encode(value) });
      return value;
    } catch (error) {
      this.emit({ type: 'value', id, name, error: true, value: this.encode(error) });
      throw error;
    }
  }

  async call<T>(
    name: string,
    args: unknown[],
    work: (...args: unknown[]) => Promise<T>
  ): Promise<T> {
    const id = ++this.#next;
    const callbacks = new Map<string, (...args: unknown[]) => unknown>();
    this.emit({ type: 'call', id, name, args: this.encode(args, callbacks) });
    let index = 0;
    const supplied = replaceCallbacks(args, (callback) => {
      const key = String(index++);
      return (...values: unknown[]) => {
        this.emit({ type: 'callback', id, callback: key, args: this.encode(values) });
        return withRuntimeObservations(this, () => callback(...values));
      };
    }) as unknown[];
    try {
      const result = await withRuntimeObservations(undefined, () => work(...supplied));
      this.emit({ type: 'return', id, value: this.encode(result) });
      return result;
    } catch (error) {
      this.emit({ type: 'return', id, error: true, value: this.encode(error) });
      throw error;
    }
  }

  timer(callback: () => void, milliseconds: number, repeat: boolean): NodeJS.Timeout {
    const id = ++this.#next;
    this.emit({ type: 'timer', id, milliseconds, repeat });
    const fire = () => {
      this.emit({ type: 'fire', id });
      withRuntimeObservations(this, callback);
    };
    const timer = repeat ? setInterval(fire, milliseconds) : setTimeout(fire, milliseconds);
    this.#timers.set(timer, id);
    return timer;
  }

  clear(timer: NodeJS.Timeout) {
    const id = this.#timers.get(timer);
    if (id !== undefined) this.emit({ type: 'clear', id });
    else void this.sink.fail?.('unsupported_record');
    clearTimeout(timer);
    this.#timers.delete(timer);
  }
}

export class ReplayDivergence extends Error {
  constructor(
    readonly sequence: number,
    readonly boundary: string
  ) {
    super(
      `Runtime replay diverged at observation ${sequence} (${boundary.split(':')[0]!.slice(0, 120)})`
    );
    this.boundary = boundary.split(':')[0]!.slice(0, 120);
  }
}

/** Tape playback has no executor and cannot fall back to a live observation. */
export class RuntimePlayback implements RuntimeObservations {
  readonly mode = 'replay';
  #cursor = 0;
  #failure: ReplayDivergence | undefined;
  #calls = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      callbacks: Map<string, (...args: unknown[]) => unknown>;
    }
  >();
  #timers = new Map<number, { callback: () => void; timer: NodeJS.Timeout; repeat: boolean }>();
  #timerIds = new Map<NodeJS.Timeout, number>();
  #pumping = false;
  constructor(
    readonly codec: RuntimeCodec,
    private readonly events: RuntimeEvent[]
  ) {}

  private fail(boundary: string): never {
    this.#failure ??= new ReplayDivergence(this.#cursor + 1, boundary);
    for (const call of this.#calls.values()) call.reject(this.#failure);
    this.#calls.clear();
    throw this.#failure;
  }

  abort(boundary: string): never {
    return this.fail(boundary);
  }

  private take(type: RuntimeEvent['type'], boundary: string): RuntimeEvent {
    if (this.#failure) throw this.#failure;
    const row = this.events[this.#cursor];
    if (!row || row.type !== type) return this.fail(boundary);
    this.#cursor++;
    return row;
  }

  value<T>(name: string, _read: () => T): T {
    void _read;
    const row = this.take('value', name);
    if (row.name !== name) return this.fail(name);
    this.pump();
    const value = this.codec.decode(row.value);
    if (row.error) throw value;
    return value as T;
  }

  call<T>(name: string, args: unknown[], _work: (...args: unknown[]) => Promise<T>): Promise<T> {
    void _work;
    const row = this.take('call', name);
    const callbacks = new Map<string, (...args: unknown[]) => unknown>();
    if (row.name !== name) return this.fail(`${name}; expected ${row.name ?? row.type}`);
    if (!isDeepStrictEqual(this.codec.encode(args, callbacks), row.args))
      return this.fail(`${name} arguments`);
    if (this.#calls.has(row.id)) return this.fail('duplicate call');
    const promise = new Promise<T>((resolve, reject) => {
      this.#calls.set(row.id, { resolve: (value) => resolve(value as T), reject, callbacks });
    });
    void promise.catch(() => undefined);
    // A transport may invoke its callback before returning the promise to its caller.
    while (this.events[this.#cursor]?.type === 'callback') this.deliverCallback();
    this.pump();
    return promise;
  }

  timer(callback: () => void, milliseconds: number, repeat: boolean): NodeJS.Timeout {
    const row = this.take('timer', 'timer');
    if (row.milliseconds !== milliseconds || row.repeat !== repeat || this.#timers.has(row.id))
      return this.fail('timer');
    const timer = {
      unref() {
        return this;
      }
    } as unknown as NodeJS.Timeout;
    this.#timers.set(row.id, { callback, timer, repeat });
    this.#timerIds.set(timer, row.id);
    this.pump();
    return timer;
  }

  clear(timer: NodeJS.Timeout) {
    const row = this.take('clear', 'timer clear');
    if (this.#timerIds.get(timer) !== row.id) this.fail('timer identity');
    this.#timers.delete(row.id);
    this.#timerIds.delete(timer);
    this.pump();
  }

  private deliverCallback() {
    const row = this.events[this.#cursor++];
    if (!row || row.type !== 'callback') this.fail('callback ordering');
    const call = this.#calls.get(row.id);
    const callback = call?.callbacks.get(row.callback ?? '');
    if (!callback) this.fail('unknown callback');
    const pending = withRuntimeObservations(this, () =>
      callback(...(this.codec.decode(row.args) as unknown[]))
    );
    if (pending instanceof Promise)
      void pending.catch(() => {
        try {
          this.fail('callback');
        } catch {
          /* result() retains the first divergence. */
        }
      });
  }

  private pump() {
    if (this.#pumping || this.#failure) return;
    this.#pumping = true;
    queueMicrotask(() => {
      this.#pumping = false;
      if (this.#failure) return;
      const row = this.events[this.#cursor];
      if (!row) {
        if (this.#calls.size) {
          try {
            this.fail('missing return');
          } catch {
            /* Pending calls receive the failure. */
          }
        }
        return;
      }
      if (!['return', 'callback', 'fire'].includes(row.type)) return;
      try {
        this.#cursor++;
        if (row.type === 'fire') {
          const timer = this.#timers.get(row.id);
          if (!timer) this.fail('unknown timer');
          withRuntimeObservations(this, timer.callback);
        } else {
          const call = this.#calls.get(row.id);
          if (!call) this.fail('unknown call');
          if (row.type === 'return') {
            this.#calls.delete(row.id);
            const value = this.codec.decode(row.value);
            if (row.error) call.reject(value);
            else call.resolve(value);
          } else {
            this.#cursor--;
            this.deliverCallback();
          }
        }
        this.pump();
      } catch (error) {
        if (!(error instanceof ReplayDivergence)) {
          try {
            this.fail('invalid observation');
          } catch {
            /* result() retains the divergence. */
          }
        }
      }
    });
  }

  result() {
    return {
      observations: this.#cursor,
      total: this.events.length,
      complete: !this.#failure && this.#cursor === this.events.length && !this.#calls.size,
      divergence: this.#failure
        ? { sequence: this.#failure.sequence, boundary: this.#failure.boundary }
        : null
    };
  }

  assertComplete() {
    if (!this.result().complete) this.fail('unfinished runtime');
  }
}
