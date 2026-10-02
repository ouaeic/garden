import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskPresentation } from '@garden/contracts';
import { TaskOutputs, TaskProgress } from './TaskCanvas';
import WorkTrace from './WorkTrace';

const presentation: TaskPresentation = {
  version: 1,
  taskId: 'recorded-task',
  eventCursor: 4,
  results: [
    {
      id: 'preview-1',
      kind: 'preview',
      title: 'Maze game',
      status: 'ready',
      url: null,
      downloadUrl: null,
      accessPath: '/v1/previews/owned/access',
      evidenceEventIds: ['published']
    },
    {
      id: 'file-1',
      kind: 'file',
      title: 'index.html',
      status: 'ready',
      url: null,
      downloadUrl: '/v1/workspaces/owned/file?path=workspace%2Fmaze%2Findex.html',
      accessPath: null,
      evidenceEventIds: ['written']
    }
  ],
  progress: {
    kind: 'build',
    phases: [
      { id: 'build', title: 'Build the game', status: 'completed' },
      { id: 'check', title: 'Verify play', status: 'in_progress' }
    ],
    history: [],
    current: {
      title: 'Checking keyboard input',
      eventId: 'check',
      startedAt: '2026-09-06T00:00:00Z'
    },
    metrics: [{ key: 'files', label: 'Files changed', value: 1 }],
    milestones: [],
    updatedAt: null
  }
};

describe('usable task delivery and recorded progress', () => {
  it('shows the preview, the answer and the files together, with no tabs between them', () => {
    const html = renderToStaticMarkup(
      <TaskOutputs
        presentation={presentation}
        afterPreview={<p>The latest explanation</p>}
        onArtifact={() => undefined}
      />
    );
    expect(html).toContain('Maze game');
    expect(html).toContain('The latest explanation');
    expect(html).toContain('index.html');
    expect(html).not.toContain('aria-pressed');
    expect(html).not.toContain('at a glance');
  });
  it('downloads the declared project bundle beside a preview rather than an unrelated latest file', () => {
    const withoutBundle = renderToStaticMarkup(
      <TaskOutputs presentation={presentation} onArtifact={() => undefined} />
    );
    expect(withoutBundle).not.toContain('garden-primary-download');
    const html = renderToStaticMarkup(
      <TaskOutputs
        presentation={{
          ...presentation,
          sourceBundle: {
            downloadUrl: '/v1/tasks/recorded-task/bundle',
            scope: 'recorded_files',
            directories: [],
            fileCount: 2
          }
        }}
        onArtifact={() => undefined}
      />
    );
    expect(html).toContain(
      'class="button garden-primary-download" href="/v1/tasks/recorded-task/bundle"'
    );
    expect(html).toContain('Download project files');
  });
  it('does not show a cached completion while another direction is paused or waiting', () => {
    const outcome = {
      summary: 'An earlier direction finished.',
      at: '2026-09-06T00:00:00Z',
      verification: 'verified' as const,
      evidence: 1,
      remainingRisks: [],
      openSteps: 0
    };
    const render = (taskStatus: NonNullable<TaskPresentation['taskStatus']>) =>
      renderToStaticMarkup(
        <TaskProgress
          presentation={{ ...presentation, taskStatus, outcome }}
          onPlan={() => undefined}
          onEvidence={() => undefined}
        />
      );
    expect(render('completed')).toContain('How it finished');
    for (const status of [
      'paused',
      'running',
      'awaiting_user',
      'awaiting_resource',
      'failed',
      'cancelled'
    ] as const) {
      const html = render(status);
      expect(html, status).not.toContain('How it finished');
      expect(html, status).not.toContain(outcome.summary);
    }
  });
  it('serves the scoped archive address and distinguishes a manifest that has not been counted', () => {
    const html = renderToStaticMarkup(
      <TaskOutputs
        presentation={{
          ...presentation,
          sourceBundle: {
            downloadUrl: '/v1/tasks/recorded-task/bundle',
            scope: 'declared_directories',
            directories: ['workspace/maze'],
            fileCount: null
          }
        }}
        onArtifact={() => undefined}
      />
    );
    expect(html).toContain('href="/v1/tasks/recorded-task/bundle"');
    expect(html).toContain('Project files');
    expect(html).not.toContain('0 recorded output files');
  });
  it('makes the latest recorded action legible in the work trace without inventing work', () => {
    const milestones = ['Edited maze.ts', 'Checked keyboard controls'].map((title, index) => ({
      id: `event-${index}`,
      sequence: index + 1,
      kind: index ? ('check' as const) : ('change' as const),
      title,
      status: 'passed' as const,
      createdAt: '2026-09-06T00:00:00Z'
    }));
    const html = renderToStaticMarkup(
      <WorkTrace progress={{ ...presentation.progress, milestones }} onEvidence={() => undefined} />
    );
    expect(html).toContain('Checked keyboard controls</strong>');
    expect(html).toContain('latest 2 actions');
    expect(html).toContain('Inspect');
    expect(
      renderToStaticMarkup(
        <WorkTrace progress={presentation.progress} onEvidence={() => undefined} />
      )
    ).toBe('');
  });
  it('puts browser and source actions on the result, while the private iframe awaits its owner grant', () => {
    const html = renderToStaticMarkup(
      <TaskOutputs presentation={presentation} onArtifact={() => undefined} />
    );
    expect(html).toContain('Open app');
    expect(html).toContain('download="index.html"');
    expect(html).toContain('workspace%2Fmaze%2Findex.html');
    expect(html).not.toContain('garden-result-map');
    expect(html).toContain('Opening the live app');
  });
  it('does not offer opening an unavailable preview or downloading an unavailable file', () => {
    const html = renderToStaticMarkup(
      <TaskOutputs
        presentation={{
          ...presentation,
          results: presentation.results.map((item) => ({ ...item, status: 'unavailable' }))
        }}
        onArtifact={() => undefined}
      />
    );
    expect(html).not.toContain('Open app');
    expect(html).not.toContain('download=');
  });
  it('keeps a source download accessible when its availability probe is pending', () => {
    const html = renderToStaticMarkup(
      <TaskOutputs
        presentation={{
          ...presentation,
          results: presentation.results.map((item) => ({ ...item, status: 'unknown' }))
        }}
        onArtifact={() => undefined}
      />
    );
    expect(html).toContain('download="index.html"');
    expect(html).not.toContain('Open app');
  });
  it('exposes all previews rather than silently dropping later outputs', () => {
    const second = { ...presentation.results[0]!, id: 'preview-2', title: 'Second deliverable' };
    const html = renderToStaticMarkup(
      <TaskOutputs
        presentation={{ ...presentation, results: [...presentation.results, second] }}
        onArtifact={() => undefined}
      />
    );
    expect(html).toContain('Task previews');
    expect(html).toContain('Second deliverable');
  });
  it('labels the plan denominator and current tool observation, without inventing objective completion', () => {
    const html = renderToStaticMarkup(
      <TaskProgress
        presentation={presentation}
        onEvidence={() => undefined}
        onPlan={() => undefined}
      />
    );
    expect(html).toContain('Plan: 1 of 2 steps completed');
    expect(html).toContain('Checking keyboard input');
    expect(html).not.toContain('garden-metrics');
    expect(html).not.toContain('50% complete');
  });
});

/**
 * What the progress panel actually puts on screen.
 *
 * Every one of these was a thing the owner said was missing: how long a step took, how far into its
 * parts a milestone is, what the project did before the direction it is on now, and whether a run
 * that says it finished actually finished what it listed.
 */
describe('the progress panel answers how far in the work is', () => {
  const withProgress = (over: Partial<TaskPresentation['progress']>) =>
    renderToStaticMarkup(
      <TaskProgress
        presentation={{ ...presentation, progress: { ...presentation.progress, ...over } }}
        onPlan={() => undefined}
        onEvidence={() => undefined}
      />
    );

  it('puts a duration beside a finished step and a start time beside a running one', () => {
    const html = withProgress({
      phases: [
        {
          id: 'build',
          title: 'Build the game',
          status: 'completed',
          startedAt: '2026-09-06T10:00:00.000Z',
          completedAt: '2026-09-06T10:12:30.000Z'
        },
        {
          id: 'check',
          title: 'Verify play',
          status: 'in_progress',
          startedAt: '2026-09-06T10:12:30.000Z'
        }
      ]
    });
    expect(html).toContain('12m 30s');
    expect(html).toContain('since');
  });

  it('counts a milestone`s parts on the closed row and lists them underneath', () => {
    const html = withProgress({
      phases: [
        {
          id: 'build',
          title: 'Build the game',
          status: 'in_progress',
          countDone: 2,
          countTotal: 3,
          substeps: [
            { id: 's1', title: 'Draw the map', status: 'completed' },
            { id: 's2', title: 'Drop the extra', status: 'skipped' },
            { id: 's3', title: 'Wire the keys', status: 'in_progress' }
          ]
        }
      ]
    });
    expect(html).toContain('2/3');
    expect(html).toContain('Draw the map');
    expect(html).toContain('Wire the keys');
  });

  it('keeps the earlier directions on screen instead of showing an empty panel', () => {
    const html = withProgress({
      phases: [],
      history: [
        {
          directionEventId: 'event-1',
          startedAt: '2026-09-06T09:00:00.000Z',
          phases: [{ id: 'a', title: 'Draw the map', status: 'completed' }]
        }
      ]
    });
    expect(html).toContain('Earlier in this project');
    expect(html).toContain('Draw the map');
  });

  it('does not call a run complete while its own list still has steps open', () => {
    const html = renderToStaticMarkup(
      <TaskProgress
        presentation={{
          ...presentation,
          taskStatus: 'completed',
          progress: {
            ...presentation.progress,
            phases: [
              { id: 'a', title: 'Done thing', status: 'completed' },
              { id: 'b', title: 'Open thing', status: 'pending' }
            ]
          }
        }}
        onPlan={() => undefined}
        onEvidence={() => undefined}
      />
    );
    expect(html).toContain('1 step open');
    expect(html).toContain('1 of 2 done');
  });
});

/**
 * The hover, which is where the account of a finished step lives.
 *
 * Nothing writes these lines: they are counted off the activity the step recorded. The panel has to
 * put them somewhere reachable without adding a row to a list whose whole job is to stay short.
 */
describe('what a milestone says when you hover it', () => {
  it('carries its own account and its duration on the row', () => {
    const html = renderToStaticMarkup(
      <TaskProgress
        presentation={{
          ...presentation,
          progress: {
            ...presentation.progress,
            phases: [
              {
                id: 'build',
                title: 'Build the game',
                status: 'completed',
                startedAt: '2026-09-06T10:00:00.000Z',
                completedAt: '2026-09-06T10:12:30.000Z',
                detail: '4 files changed · app/index.html'
              }
            ]
          }
        }}
        onPlan={() => undefined}
        onEvidence={() => undefined}
      />
    );
    expect(html).toContain('4 files changed');
    expect(html).toContain('took 12m 30s');
  });

  it('carries a part`s account on the part', () => {
    const html = renderToStaticMarkup(
      <TaskProgress
        presentation={{
          ...presentation,
          progress: {
            ...presentation.progress,
            phases: [
              {
                id: 'build',
                title: 'Build',
                status: 'in_progress',
                countDone: 1,
                countTotal: 2,
                substeps: [
                  {
                    id: 's1',
                    title: 'Draw the map',
                    status: 'completed',
                    detail: '2 files changed'
                  },
                  { id: 's2', title: 'Wire the keys', status: 'pending' }
                ]
              }
            ]
          }
        }}
        onPlan={() => undefined}
        onEvidence={() => undefined}
      />
    );
    expect(html).toContain('Draw the map — 2 files changed');
  });
});
