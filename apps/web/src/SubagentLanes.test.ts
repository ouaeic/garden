import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskEvent } from '@athanor/contracts';
import SubagentLanes from './SubagentLanes';

describe('research evidence status', () => {
  it('shows completion, quotation coverage and adverse claim assessments separately', () => {
    const events = [
      {
        id: 'event',
        kind: 'subagent',
        createdAt: '2026-09-17T00:00:00Z',
        payload: {
          laneId: 'mission',
          lane: 'research',
          name: 'Review sources',
          status: 'completed',
          citations: { checked: 2, matched: 2, cited: 6 },
          claimReview: { checked: 2, supported: 0, contradicted: 1 }
        }
      }
    ] as unknown as TaskEvent[];
    const html = renderToStaticMarkup(createElement(SubagentLanes, { events }));
    expect(html).toContain('Completed');
    expect(html).toContain('2 quotation matches');
    expect(html).toContain('2 of 6 citations checked');
    expect(html).toContain('0 supported');
    expect(html).toContain('1 contradicted');
    expect(html).toContain('1 inconclusive');
    expect(html).not.toContain('Verified');
  });
});
