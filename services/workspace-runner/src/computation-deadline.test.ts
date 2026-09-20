import { afterEach, describe, expect, it, vi } from 'vitest';
import { computationDeadline, scheduleComputationDeadline } from './computation-deadline.js';

afterEach(() => vi.useRealTimers());
describe('computation deadlines', () => {
  it('waits through multiple native timer ranges without expiring early', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    const expire = vi.fn();
    const days = 60 * 86400;
    const cancel = scheduleComputationDeadline(computationDeadline(Date.now(), days), expire);
    vi.advanceTimersByTime((days - 1) * 1000);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(expire).toHaveBeenCalledTimes(1);
    cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels a rescheduled deadline without leaving another timer', () => {
    vi.useFakeTimers();
    const expire = vi.fn();
    const cancel = scheduleComputationDeadline(Date.now() + 60 * 86400_000, expire);
    vi.advanceTimersByTime(30 * 86400_000);
    cancel();
    vi.advanceTimersByTime(90 * 86400_000);
    expect(expire).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rechecks wall time after a clock adjustment and refuses unrepresentable dates', () => {
    vi.useFakeTimers();
    const start = Date.now();
    const expire = vi.fn();
    const cancel = scheduleComputationDeadline(start + 1000, expire);
    vi.setSystemTime(start - 5000);
    vi.advanceTimersByTime(1000);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(expire).toHaveBeenCalledTimes(1);
    cancel();
    expect(() => computationDeadline(start, Number.MAX_SAFE_INTEGER)).toThrow('calendar range');
    expect(() => computationDeadline(start, 0)).toThrow('calendar range');
    expect(() => scheduleComputationDeadline(Infinity, expire)).toThrow('finite');
  });
});
