import { afterEach, expect, it, vi } from 'vitest';
import { observeVisibleClock } from './visible-clock';

afterEach(() => vi.useRealTimers());

function page(initial: DocumentVisibilityState) {
  const events = new EventTarget();
  return Object.assign(events, { visibilityState: initial });
}

it('stops hidden-page timers, catches up on return, and releases the listener on disposal', () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const visibility = page('visible'),
    tick = vi.fn();
  const stop = observeVisibleClock(tick, 1000, visibility);
  expect(tick.mock.calls).toEqual([[0]]);
  vi.advanceTimersByTime(2000);
  expect(tick.mock.calls).toEqual([[0], [1000], [2000]]);
  visibility.visibilityState = 'hidden';
  visibility.dispatchEvent(new Event('visibilitychange'));
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(60_000);
  expect(tick).toHaveBeenCalledTimes(3);
  visibility.visibilityState = 'visible';
  visibility.dispatchEvent(new Event('visibilitychange'));
  expect(tick).toHaveBeenLastCalledWith(62_000);
  expect(vi.getTimerCount()).toBe(1);
  visibility.dispatchEvent(new Event('visibilitychange'));
  expect(vi.getTimerCount()).toBe(1);
  stop();
  tick.mockClear();
  visibility.dispatchEvent(new Event('visibilitychange'));
  vi.advanceTimersByTime(10_000);
  expect(vi.getTimerCount()).toBe(0);
  expect(tick).not.toHaveBeenCalled();
});

it('does not start a display timer when the page is initially hidden', () => {
  vi.useFakeTimers();
  const visibility = page('hidden'),
    tick = vi.fn();
  const stop = observeVisibleClock(tick, 30_000, visibility);
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(120_000);
  expect(tick).not.toHaveBeenCalled();
  visibility.visibilityState = 'visible';
  visibility.dispatchEvent(new Event('visibilitychange'));
  expect(tick).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(30_000);
  expect(tick).toHaveBeenCalledTimes(2);
  stop();
  expect(vi.getTimerCount()).toBe(0);
});
