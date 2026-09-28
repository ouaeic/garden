import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import SavedProcessHistory from './SavedProcessHistory';
import { ComputationCard } from './computer/Computation';
import type { ComputationSession } from '@garden/contracts';

describe('saved process history presentation', () => {
  it('distinguishes saved history from recent runs and explains legacy coverage', () => {
    const html = renderToStaticMarkup(
      <SavedProcessHistory endpoint="/v1/projects/project/processes" />
    );
    expect(html).toContain('Saved process history');
    expect(html).toContain('Runs removed before saved history was enabled may be missing');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Analysis sessions');
    expect(html).not.toContain('End of available saved history');
  });
  it('keeps archived analysis results and file downloads available without process controls', () => {
    const session: ComputationSession = {
      sessionId: 'kernel-00000000-0000-4000-8000-000000000001',
      workspaceId: '00000000-0000-4000-8000-000000000002',
      taskId: 'task',
      name: 'Completed analysis',
      language: 'python',
      cwd: 'workspace',
      state: 'stopped',
      stateRetained: false,
      archived: true,
      createdAt: '2026-09-20T00:00:00Z',
      deadlineAt: '2026-09-21T00:00:00Z',
      variables: [],
      latestCell: {
        cellId: 'result',
        startedAt: '2026-09-20T00:00:00Z',
        state: 'completed',
        stdout: '42 reads',
        stderr: '',
        artifacts: [{ path: 'workspace/result.csv', mimeType: 'text/csv', bytes: 42 }]
      }
    };
    const html = renderToStaticMarkup(
      <ComputationCard
        session={session}
        busy={false}
        onControl={() => {
          throw Error('No controls expected');
        }}
      />
    );
    expect(html).toContain('42 reads');
    expect(html).toContain('result.csv');
    expect(html).toContain('View execution history');
    expect(html).not.toContain('End session');
    expect(html).not.toContain('Interrupt cell');
  });
});
