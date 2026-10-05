import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DecisionCard } from './DecisionQueue';
import type { Decision } from './model';

const script = "python3 - <<'PY'\n" + 'print("fixture")\n'.repeat(200) + 'PY';
const decision: Decision = {
  id: 'approval',
  taskId: 'task',
  status: 'pending',
  action: 'Allow this command to unpkg.com',
  origin: 'workspace file pocket-watch/shot-exploded.png',
  sideEffect: 'external_reversible',
  createdAt: '2026-09-14T00:00:00Z',
  expiresAt: '2036-09-14T00:00:00Z',
  preview: {
    tool: 'shell',
    securityMode: 'autonomous',
    addresses: ['unpkg.com'],
    preview: 'This turn has read untrusted content.\n\nRun ' + script,
    arguments: { executable: 'bash', args: ['-lc', script] }
  }
};

describe('approval cards separate the decision from inspection detail', () => {
  it('offers both scopes with the exact type visible and leaves older or private-input cards once-only', () => {
    const preview = {
      ...(decision.preview as Record<string, unknown>),
      taskGrant: { description: 'Network commands · using python3 · referencing https://unpkg.com' }
    };
    const html = renderToStaticMarkup(
      <DecisionCard decision={{ ...decision, preview }} onResolved={() => {}} />
    );
    expect(html).toContain('Allow in this conversation');
    expect(html).toContain('Approve once');
    expect(html).toContain('using python3');
    expect(html).toContain('Work options');
    const privateHtml = renderToStaticMarkup(
      <DecisionCard
        decision={{
          ...decision,
          preview: { ...preview, tool: 'browser_action', arguments: { action: 'type_secure' } }
        }}
        onResolved={() => {}}
      />
    );
    expect(privateHtml).not.toContain('Allow in this conversation');
    expect(
      renderToStaticMarkup(<DecisionCard decision={decision} onResolved={() => {}} />)
    ).not.toContain('Allow in this conversation');
  });
  it('keeps the complete command inspectable without showing a script or provenance as the destination', () => {
    const html = renderToStaticMarkup(<DecisionCard decision={decision} onResolved={() => {}} />);
    const introduction = html.split('<details')[0]!;
    expect(introduction).toContain('Autonomous · needs approval');
    expect(introduction).toContain('unpkg.com');
    expect(introduction).not.toContain('shot-exploded.png');
    expect(introduction).not.toContain('This turn has');
    expect(introduction).not.toContain('python3');
    expect(html).toContain('Content read before this action:');
    expect(html).toContain('shot-exploded.png');
    expect(html).toContain('python3');
    expect(html.match(/fixture/g)).toHaveLength(400);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain('Approve once');
    expect(html).toContain('Deny');
  });
  it('handles a pending card created by an older server without inventing destination metadata', () => {
    const html = renderToStaticMarkup(
      <DecisionCard
        decision={{ ...decision, preview: { tool: 'shell', preview: 'Run ' + script } }}
        onResolved={() => {}}
      />
    );
    expect(html.split('<details')[0]).not.toContain('shot-exploded.png');
    expect(html).not.toContain('<dt>Destination</dt>');
    expect(html).not.toContain('decision-addresses');
    expect(html).toContain('python3');
  });
});
