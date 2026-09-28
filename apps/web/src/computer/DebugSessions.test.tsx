import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DebugSession } from '@garden/contracts';
import { DebugSessionCard } from './DebugSessions';
const session: DebugSession = {
  sessionId: 'debug-test',
  workspaceId: 'workspace',
  taskId: 'task',
  language: 'python',
  program: 'workspace/main.py',
  cwd: 'workspace',
  state: 'stopped',
  createdAt: '2026-09-06T10:00:00Z',
  updatedAt: '2026-09-06T10:01:00Z',
  deadlineAt: '2026-09-06T11:00:00Z',
  stopEpoch: 3,
  reason: 'breakpoint',
  frames: [
    { id: 1, name: 'main', path: 'workspace/main.py', line: 2, column: 1, sourceHash: 'hash' }
  ],
  variables: [{ name: 'answer', value: '40', variablesReference: 0 }],
  excludedFrames: 1,
  output: 'ready',
  note: null
};
describe('cached debug sessions', () => {
  it('displays source-linked cached values with an explicit end-session control', () => {
    const html = renderToStaticMarkup(
      <DebugSessionCard session={session} busy={false} onStop={() => undefined} />
    );
    expect(html).toContain('workspace/main.py:2');
    expect(html).toContain('40');
    expect(html).toContain('End debug session');
    expect(html).toContain('Live value inspection and execution require approval');
    expect(html).not.toContain('End session</button>');
  });
  it('retains an owner retry when lost state still has unverified teardown', () => {
    const html = renderToStaticMarkup(
      <DebugSessionCard
        session={{ ...session, state: 'lost', cleanupPending: true, frames: [], variables: [] }}
        busy={false}
        onStop={() => undefined}
      />
    );
    expect(html).toContain('End debug session');
    const stopping = renderToStaticMarkup(
      <DebugSessionCard
        session={{ ...session, state: 'stopping', cleanupPending: true }}
        busy={false}
        onStop={() => undefined}
      />
    );
    expect(stopping).toContain('disabled=""');
  });
  it('does not offer running controls after adapter state is lost', () => {
    const html = renderToStaticMarkup(
      <DebugSessionCard
        session={{
          ...session,
          state: 'lost',
          frames: [],
          variables: [],
          note: 'Runner restarted; no replay.'
        }}
        busy={false}
        onStop={() => undefined}
      />
    );
    expect(html).toContain('Runner restarted; no replay.');
    expect(html).not.toContain('<button');
  });
});
