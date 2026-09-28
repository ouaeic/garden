import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CodingMissionReview } from '@garden/contracts';
import { MissionReviewChanges } from './CodingMissions';

const review: CodingMissionReview = {
  mission: {
    id: 'mission',
    parentTaskId: 'parent',
    taskId: 'child',
    workspaceId: 'isolated-child',
    name: 'Keyboard controls',
    state: 'conflicted',
    sourceRoot: 'workspace/maze',
    outputPaths: ['workspace/maze/controls.ts'],
    allocatedCredits: 1,
    usedCredits: 0.1,
    reservedCredits: 0,
    pendingApprovals: 0,
    changedFiles: 1,
    conflicts: 1,
    generation: 2,
    createdAt: '2026-09-06T00:00:00Z',
    updatedAt: '2026-09-06T00:00:00Z',
    detail: null
  },
  digest: 'review-content-hash',
  canIntegrate: false,
  detail: 'The parent file changed during this work.',
  changes: [
    {
      path: 'workspace/maze/controls.ts',
      kind: 'modified',
      bytes: 40,
      baseHash: 'before',
      resultHash: 'after',
      conflict: true,
      permitted: false,
      binary: false,
      diffOmitted: false,
      diff: '@@ -1 +1 @@\n-oldControl()\n+newControl()'
    }
  ]
};

describe('reviewing specialist changes', () => {
  it('shows the exact proposed diff, conflicts and allowed-path failures with a child-scoped download', () => {
    const html = renderToStaticMarkup(<MissionReviewChanges review={review} />);
    expect(html).toContain('+newControl()');
    expect(html).toContain('-oldControl()');
    expect(html).toContain('· conflict');
    expect(html).toContain('· outside allowed paths');
    expect(html).toContain(
      '/v1/workspaces/isolated-child/download?path=workspace%2Fmaze%2Fcontrols.ts'
    );
  });
  it('does not advertise a download for a deleted file and identifies omitted binary changes', () => {
    const html = renderToStaticMarkup(
      <MissionReviewChanges
        review={{
          ...review,
          changes: [
            { ...review.changes[0]!, kind: 'deleted', diff: null, binary: true, diffOmitted: true }
          ]
        }}
      />
    );
    expect(html).not.toContain('download=');
    expect(html).toContain('binary file');
    expect(html).toContain('full diff exceeds the preview limit');
  });
});
