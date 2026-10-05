import { describe, expect, it } from 'vitest';
import type { ManagedProcess } from '@garden/contracts';
import { runSummary } from './runs';

const run = (over: Partial<ManagedProcess> = {}): ManagedProcess => ({
  sessionId: 'session-1',
  status: 'running',
  command: ['nextflow', 'run', 'main.nf'],
  startedAt: '2026-10-03T00:00:00.000Z',
  ranForMs: 3 * 60 * 60 * 1000 + 2 * 60 * 1000,
  outputBytes: 0,
  ...over
});

describe('a run read at a glance', () => {
  it('says how long, how hard it is working, and how far a pipeline has got', () => {
    const summary = runSummary(
      run({
        resources: {
          sampledAt: '2026-10-03T03:02:00.000Z',
          intervalMs: 60_000,
          cpuPercent: 824.6,
          residentBytes: 18 * 1024 ** 3,
          processCount: 12,
          threadCount: 40,
          children: []
        },
        workflow: {
          progress: { completed: 2, cached: 31, failed: 1, aborted: 0, recent: [] }
        } as unknown as NonNullable<ManagedProcess['workflow']>
      }),
      undefined,
      Date.parse('2026-10-03T03:02:00.000Z')
    );
    expect(summary).toBe('3h 2m · CPU 825% · 18.0 GiB · 33 stages done · 1 failed');
  });

  it('puts a run that stopped on its own first, so it is not mistaken for progress', () => {
    const summary = runSummary(
      run({
        status: 'interrupted',
        job: { state: 'interrupted' } as NonNullable<ManagedProcess['job']>
      }),
      undefined,
      0
    );
    expect(summary.startsWith('Needs a look · ')).toBe(true);
  });
});
