import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ComputationSession } from '@garden/contracts';
import { ComputationCard } from './Computation';

const session: ComputationSession = {
  sessionId: 'analysis-session',
  workspaceId: 'owner-workspace',
  taskId: 'analysis-task',
  name: 'Sequence analysis',
  language: 'python',
  cwd: 'workspace/analysis',
  state: 'busy',
  createdAt: '2026-09-06T00:00:00Z',
  deadlineAt: '2026-09-07T00:00:00Z',
  stateRetained: true,
  variables: [{ name: 'samples', type: 'DataFrame', preview: '20 rows, 4 columns' }],
  latestCell: {
    cellId: 'summary',
    state: 'completed',
    startedAt: '2026-09-06T00:00:00Z',
    stdout: '',
    stderr: '',
    result: 20,
    artifacts: [{ path: 'workspace/analysis/summary plot.png', mimeType: 'image/png', bytes: 1024 }]
  }
};
const render = (value: ComputationSession) =>
  renderToStaticMarkup(
    <ComputationCard session={value} busy={false} onControl={() => undefined} />
  );

describe('owner computation session controls', () => {
  it('exposes retained values, running-cell interruption and scoped artifact downloads', () => {
    const html = render(session);
    expect(html).toContain('Interrupt cell');
    expect(html).toContain('Values are retained for the next cell.');
    expect(html).toContain('20 rows, 4 columns');
    expect(html).toContain(
      '/v1/workspaces/owner-workspace/download?path=workspace%2Fanalysis%2Fsummary%20plot.png'
    );
    expect(html).toContain('download="summary plot.png"');
  });
  it('labels stale R resource readings while retaining the last measured values', () => {
    const html = render({
      ...session,
      language: 'r',
      resourceState: 'unavailable',
      resources: {
        sampledAt: '2026-09-06T00:01:00Z',
        intervalMs: 120000,
        cpuPercent: 210,
        residentBytes: 2 * 1024 ** 3,
        processCount: 1,
        threadCount: 3,
        children: []
      }
    });
    expect(html).toContain('R');
    expect(html).toContain('210%');
    expect(html).toContain('2.0 GiB');
    expect(html).toContain('showing the previous sample');
    expect(html).not.toContain('Waiting for a resource sample');
  });
  it('reports lost state without offering an unsafe automatic replay', () => {
    const html = render({ ...session, state: 'lost', stateRetained: false, variables: [] });
    expect(html).toContain('Runtime state was lost. Earlier cells have not been replayed.');
    expect(html).not.toContain('Values are retained');
    expect(html).not.toContain('Interrupt cell');
    expect(html).not.toContain('End session');
    expect(html).not.toContain('Values in memory');
    expect(html).toContain('summary plot.png');
  });
  it('keeps an idle session available without presenting a cell as running', () => {
    const html = render({ ...session, state: 'idle' });
    expect(html).toContain('End session');
    expect(html).not.toContain('Interrupt cell');
  });
  it('distinguishes ended-session records from live values and resource use', () => {
    const html = render({
      ...session,
      state: 'stopped',
      stateRetained: false,
      resources: {
        sampledAt: '2026-09-06T00:01:00Z',
        intervalMs: 120000,
        cpuPercent: 0,
        residentBytes: 100 * 1024 ** 2,
        processCount: 1,
        threadCount: 1,
        children: []
      }
    });
    expect(html).toContain('Recorded variables');
    expect(html).toContain('20 rows, 4 columns');
    expect(html).toContain('Last sample');
    expect(html).not.toContain('Values in memory');
    expect(html).not.toContain('End session');
    expect(html).toContain('View execution history');
  });
});
