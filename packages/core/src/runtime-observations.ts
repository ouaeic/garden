import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** External observations of a turn, separate from credentials and executable tool handlers. */
export interface RuntimeObservations {
  readonly mode: 'record' | 'replay';
  value<T>(name: string, read: () => T): T;
  call<T>(name: string, args: unknown[], work: (...args: unknown[]) => Promise<T>): Promise<T>;
  timer(callback: () => void, milliseconds: number, repeat: boolean): NodeJS.Timeout;
  clear(timer: NodeJS.Timeout): void;
}

const scope = new AsyncLocalStorage<RuntimeObservations | undefined>();
export const runtimeObservations = () => scope.getStore();
export const withRuntimeObservations = <T>(
  runtime: RuntimeObservations | undefined,
  work: () => T
): T => scope.run(runtime, work);
export const runtimeValue = <T>(name: string, read: () => T): T => {
  const runtime = scope.getStore();
  return runtime ? runtime.value(name, read) : read();
};
export const runtimeNow = () => runtimeValue('clock', () => Date.now());
export const runtimeDate = () => new Date(runtimeNow());
export const runtimeUUID = () => runtimeValue('uuid', () => randomUUID());
export const runtimeRandom = () => runtimeValue('random', () => Math.random());
export const runtimeCall = <T>(
  name: string,
  args: unknown[],
  work: (...args: unknown[]) => Promise<T>
): Promise<T> => scope.getStore()?.call(name, args, work) ?? work(...args);
export const runtimeSetTimeout = (callback: () => void, milliseconds: number): NodeJS.Timeout =>
  scope.getStore()?.timer(callback, milliseconds, false) ?? setTimeout(callback, milliseconds);
export const runtimeSetInterval = (callback: () => void, milliseconds: number): NodeJS.Timeout =>
  scope.getStore()?.timer(callback, milliseconds, true) ?? setInterval(callback, milliseconds);
export const runtimeClearTimer = (timer: NodeJS.Timeout | undefined | null): void => {
  if (!timer) return;
  const runtime = scope.getStore();
  if (runtime) runtime.clear(timer);
  else clearTimeout(timer);
};
export const runtimeSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => runtimeSetTimeout(resolve, milliseconds));

/** Only the replay tape supplies a result in replay mode; the live implementation is never called. */
export function observedObject<T extends object>(target: T | undefined, prefix: string): T {
  const cache = new Map<PropertyKey, unknown>();
  const proxy = new Proxy(() => undefined, {
    get(_unused, field) {
      if (field === 'then') return undefined;
      if (typeof field !== 'string') return target ? Reflect.get(target, field) : undefined;
      if (cache.has(field)) return cache.get(field);
      const value = target ? Reflect.get(target, field) : undefined;
      const next = `${prefix}.${field}`;
      if (!target || (value !== null && typeof value === 'object')) {
        const child = observedObject(value as object | undefined, next);
        cache.set(field, child);
        return child;
      }
      if (typeof value !== 'function') return value;
      const call = (...args: unknown[]) =>
        runtimeCall(
          next,
          args,
          (...supplied) => Reflect.apply(value, target, supplied) as Promise<unknown>
        );
      cache.set(field, call);
      return call;
    },
    apply(_unused, _receiver, args) {
      return runtimeCall(prefix, args, () => {
        throw new Error('A replay observation has no live implementation');
      });
    }
  });
  return proxy as T;
}
