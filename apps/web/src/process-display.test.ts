import { describe, expect, it } from 'vitest';
import type { ManagedProcess } from '@garden/contracts';
import { processActive, processDuration, processElapsed, processMemory } from './process-display';
const process: ManagedProcess = {
  sessionId: 'job-1',
  status: 'running',
  command: ['python3', 'analysis.py'],
  startedAt: '2026-01-01T00:00:00Z',
  ranForMs: 3 * 86400_000,
  outputBytes: 0
};
describe('long analysis process presentation', () => {
  it('displays days without wrapping the clock and advances only live records', () => {
    const observed = '2026-01-04T00:00:00Z';
    const now = Date.parse(observed) + 90_000;
    expect(processDuration(processElapsed(process, observed, now))).toBe('3d 0h 1m');
    expect(processElapsed({ ...process, status: 'completed' }, observed, now)).toBe(3 * 86400_000);
    expect(processElapsed(process, 'bad date', now)).toBe(3 * 86400_000);
  });
  it('distinguishes restart backoff from a stopped finite job and uses useful RAM units', () => {
    expect(processActive({ ...process, status: 'failed', service: { state: 'restarting' } })).toBe(
      true
    );
    expect(processActive({ ...process, status: 'stopped' })).toBe(false);
    expect(
      processElapsed(
        { ...process, status: 'failed', service: { state: 'restarting' } },
        '2026-01-04T00:00:00Z',
        Date.parse('2026-01-04T01:00:00Z')
      )
    ).toBe(process.ranForMs);
    expect(processMemory(22 * 1024 ** 3)).toBe('22.0 GiB');
    expect(processMemory(220)).toBe('220 B');
  });
});
