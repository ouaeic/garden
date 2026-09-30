import { afterEach, expect, it, vi } from 'vitest';
import { observeVisiblePoll } from './visible-poll';

afterEach(() => vi.useRealTimers());

function page(initial: DocumentVisibilityState) {
  return Object.assign(new EventTarget(), { visibilityState: initial });
}

it('bounds slow reads to one request, aborts on hide, and ignores late settlement after resuming', async () => {
  vi.useFakeTimers();
  const visibility = page('visible');
  const signals: AbortSignal[] = [],
    finishes: Array<() => void> = [];
  const read = vi.fn((signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<void>((done) => finishes.push(done));
  });
  const failed = vi.fn();
  const stop = observeVisiblePoll(read, 1000, failed, visibility);
  expect(read).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(10_000);
  visibility.dispatchEvent(new Event('visibilitychange'));
  expect(read).toHaveBeenCalledOnce();
  visibility.visibilityState = 'hidden';
  visibility.dispatchEvent(new Event('visibilitychange'));
  expect(signals[0]?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).toHaveBeenCalledOnce();
  visibility.visibilityState = 'visible';
  visibility.dispatchEvent(new Event('visibilitychange'));
  expect(read).toHaveBeenCalledTimes(2);
  finishes[0]?.();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(read).toHaveBeenCalledTimes(2);
  finishes[1]?.();
  await vi.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(3);
  stop();
  expect(signals[2]?.aborted).toBe(true);
  finishes[2]?.();
  await vi.advanceTimersByTimeAsync(10_000);
  visibility.dispatchEvent(new Event('visibilitychange'));
  expect(read).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
  expect(failed).not.toHaveBeenCalled();
});

it('starts only when visible and recovers from a failed read without overlapping or losing the next read', async () => {
  vi.useFakeTimers();
  const visibility = page('hidden');
  const failure = new Error('offline');
  const read = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
  const failed = vi.fn();
  const stop = observeVisiblePoll(read, 1000, failed, visibility);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).not.toHaveBeenCalled();
  visibility.visibilityState = 'visible';
  visibility.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(0);
  expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
  await vi.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(2);
  visibility.visibilityState = 'hidden';
  visibility.dispatchEvent(new Event('visibilitychange'));
  expect(vi.getTimerCount()).toBe(0);
  stop();
});
