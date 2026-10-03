import { describe, expect, it } from 'vitest';
import { TaskPresentation, type TaskEvent, type WorkspacePreview } from '@garden/contracts';
import {
  buildTaskPresentation,
  deliveryFilePath,
  taskDeliveryFiles,
  taskSourceFiles,
  type PresentationInput
} from './task-presentation.js';

const taskId = '00000000-0000-4000-8000-000000000001';
const workspaceId = '00000000-0000-4000-8000-000000000002';
const now = '2026-09-06T12:00:00.000Z';
const event = (
  sequence: number,
  kind: TaskEvent['kind'],
  payload: unknown,
  summary = 'Observed'
): TaskEvent => ({
  id: `event-${sequence}`,
  taskId,
  sequence,
  kind,
  payload,
  summary,
  createdAt: now
});
const preview: WorkspacePreview = {
  id: 'preview-1',
  workspaceId,
  label: 'Maze game',
  port: 8080,
  visibility: 'private',
  status: 'active',
  url: 'https://garden.test/__garden/preview/real/',
  expiresAt: null,
  lastAccessedAt: null,
  createdAt: now,
  updatedAt: now
};
const input = (over: Partial<PresentationInput> = {}): PresentationInput => ({
  taskId,
  workspaceId,
  taskStatus: 'completed',
  events: [],
  plan: null,
  artifacts: [],
  previews: [],
  previewAvailability: new Map(),
  files: new Map(),
  ...over
});

describe('task results are concrete owner-accessible outputs', () => {
  it('refreshes an existing app once completed source edits land, preserving it through polling and explanations', () => {
    const published = event(1, 'preview', { previewId: preview.id });
    const edited = [
      event(2, 'user_message', { markdown: 'Change the default.' }),
      event(3, 'tool_started', { tool: 'file_patch', toolCallId: 'edit', arguments: {} }),
      event(4, 'tool_result', {
        toolCallId: 'edit',
        result: { filesChanged: [{ path: 'src/ui.js', sha256: 'updated' }], patchCount: 1 }
      })
    ];
    const project = (events: TaskEvent[], over: Partial<PresentationInput> = {}) =>
      buildTaskPresentation(input({ events, previews: [preview], ...over })).results[0]!;
    expect(project([published, ...edited]).previewRevision).toBeUndefined();
    const complete = [...edited, event(5, 'completed', { answer: 'Changed and tested.' })];
    const updated = project([published, ...complete]);
    expect(updated.previewRevision).toBe('event-5');
    expect(updated.evidenceEventIds).toEqual(['event-1', 'event-5']);
    expect(project([published, ...complete])).toEqual(updated);
    expect(
      project([
        ...complete.slice(0, -1),
        event(5, 'preview', { previewId: preview.id }),
        event(6, 'completed', {})
      ]).previewRevision
    ).toBeUndefined();
    const explanation = [
      event(6, 'user_message', { markdown: 'Explain the result.' }),
      event(7, 'completed', { answer: 'The default is updated.' })
    ];
    expect(project([published, ...complete, ...explanation])).toEqual(updated);
    const noOp = [
      event(8, 'tool_started', { tool: 'file_write', toolCallId: 'same', arguments: {} }),
      event(9, 'tool_result', {
        toolCallId: 'same',
        result: { path: 'src/ui.js', sha256: 'updated' }
      }),
      event(10, 'completed', {})
    ];
    expect(project([published, ...complete, ...explanation, ...noOp])).toEqual(updated);
    expect(
      project([published, ...complete], {
        workspaceId: 'fork',
        sourceWorkspaceId: workspaceId
      }).previewRevision
    ).toBeUndefined();
  });

  it('does not reload an app for refused writes, reads, artifacts or another task’s edits', () => {
    const events = [
      event(1, 'preview', { previewId: preview.id }),
      event(2, 'tool_started', { tool: 'file_write', toolCallId: 'denied', arguments: {} }),
      event(3, 'tool_result', {
        toolCallId: 'denied',
        result: { skipped: true, path: 'app.js' }
      }),
      event(4, 'tool_started', { tool: 'file_patch', toolCallId: 'failed', arguments: {} }),
      event(5, 'tool_result', {
        toolCallId: 'failed',
        result: { filesChanged: [], failures: [{ path: 'app.js', reason: 'No read' }] }
      }),
      event(6, 'tool_started', { tool: 'file_read', toolCallId: 'read', arguments: {} }),
      event(7, 'tool_result', { toolCallId: 'read', result: { path: 'app.js' } }),
      event(8, 'artifact', { artifactId: 'unrelated', name: 'report.pdf' }),
      {
        ...event(9, 'tool_started', { tool: 'file_write', toolCallId: 'foreign' }),
        taskId: 'other'
      },
      {
        ...event(10, 'tool_result', { toolCallId: 'foreign', result: { path: 'app.js' } }),
        taskId: 'other'
      },
      event(11, 'completed', { answer: 'Explanation.' })
    ];
    const built = buildTaskPresentation(input({ events, previews: [preview] }));
    expect(built.results).toHaveLength(1);
    expect(built.results[0]?.previewRevision).toBeUndefined();
    expect(built.results[0]?.evidenceEventIds).toEqual(['event-1']);
  });

  it('keeps published artifact names out of file cards and bundles while retaining real source paths', () => {
    const events = [
      event(1, 'tool_started', {
        tool: 'file_write',
        toolCallId: 'write',
        arguments: { path: 'application/cv.typ' }
      }),
      event(2, 'tool_result', { toolCallId: 'write', result: { path: 'application/cv.typ' } }),
      event(3, 'artifact', { artifactId: 'cv', name: 'Alex Morgan CV.pdf' }),
      event(4, 'completed', {
        deliverables: ['Alex Morgan CV.pdf', 'workspace/application/cv.pdf', 'missing.txt']
      })
    ];
    expect([...taskDeliveryFiles(events).keys()]).toEqual([
      'workspace/application/cv.pdf',
      'workspace/missing.txt'
    ]);
    expect([...taskSourceFiles(events).keys()]).toEqual([
      'workspace/application/cv.pdf',
      'workspace/missing.txt',
      'workspace/application/cv.typ'
    ]);
    const result = buildTaskPresentation(input({ events }));
    expect(result.results.map((result) => result.title)).toEqual(['cv.pdf', 'missing.txt']);
    expect([
      ...taskDeliveryFiles([event(5, 'completed', { deliverables: ['Unpublished CV.pdf'] })]).keys()
    ]).toEqual(['workspace/Unpublished CV.pdf']);
  });
  it('includes recorded supporting files in a source bundle even when completion names only its entry page', () => {
    const events = [
      event(1, 'tool_started', {
        tool: 'file_write',
        toolCallId: 'style',
        arguments: { path: 'app/styles.css' }
      }),
      event(2, 'tool_result', { toolCallId: 'style', result: { path: 'app/styles.css' } }),
      event(3, 'completed', { deliverables: ['app/index.html'] })
    ];
    expect([...taskSourceFiles(events).keys()]).toEqual([
      'workspace/app/index.html',
      'workspace/app/styles.css'
    ]);
    expect([
      ...taskSourceFiles([event(4, 'completed', { summary: 'A short answer' })]).keys()
    ]).toEqual([]);
  });

  it('treats time-expired active previews as unavailable even when a cached port observation passed', () => {
    const result = buildTaskPresentation(
      input({
        events: [event(1, 'preview', { previewId: preview.id })],
        previews: [{ ...preview, expiresAt: '2000-01-01T00:00:00.000Z' }],
        previewAvailability: new Map([[preview.id, 'ready']])
      })
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ status: 'unavailable', url: null, accessPath: null });
  });
  it('restores a historical app preview and source download without replaying the agent', () => {
    const events = [
      event(129, 'preview', { previewId: preview.id, url: 'https://untrusted.test/not-used' }),
      event(158, 'completed', {
        deliverables: ['pacman-clone/index.html', 'https://untrusted.test/fake']
      })
    ];
    const result = buildTaskPresentation(
      input({
        events,
        previews: [preview],
        previewAvailability: new Map([[preview.id, 'ready']]),
        files: new Map([
          ['workspace/pacman-clone/index.html', { status: 'ready', sizeBytes: 21_000 }]
        ])
      })
    );
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      kind: 'preview',
      url: preview.url,
      accessPath: '/v1/previews/preview-1/access',
      evidenceEventIds: ['event-129']
    });
    expect(result.results[1]).toMatchObject({
      kind: 'file',
      path: 'workspace/pacman-clone/index.html',
      downloadUrl: `/v1/workspaces/${workspaceId}/download?path=workspace%2Fpacman-clone%2Findex.html`,
      sizeBytes: 21_000
    });
    expect(JSON.stringify(result)).not.toContain('untrusted.test');
    expect(TaskPresentation.safeParse(result).success).toBe(true);
  });

  it('does not borrow another task preview, file event or artifact', () => {
    const result = buildTaskPresentation(
      input({
        events: [
          { ...event(1, 'preview', { previewId: preview.id }), taskId: 'other' },
          { ...event(2, 'completed', { deliverables: ['other.txt'] }), taskId: 'other' }
        ],
        previews: [preview],
        previewAvailability: new Map([[preview.id, 'ready']]),
        artifacts: [
          {
            id: 'other',
            workspaceId,
            taskId: 'other',
            name: 'Other task',
            mimeType: 'text/plain',
            sizeBytes: 1,
            version: 1,
            sha256: 'abc',
            createdAt: now
          }
        ]
      })
    );
    expect(result.results).toEqual([]);
  });

  it.each(['revoked', 'expired'] as const)(
    'never offers an Open action for a %s preview',
    (status) => {
      const result = buildTaskPresentation(
        input({
          events: [event(1, 'preview', { previewId: preview.id })],
          previews: [{ ...preview, status }],
          previewAvailability: new Map([[preview.id, 'ready']])
        })
      );
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({
        status: 'unavailable',
        url: null,
        accessPath: null
      });
    }
  );

  it('distinguishes missing files from unchecked files that remain privately downloadable', () => {
    const result = buildTaskPresentation(
      input({
        events: [
          event(1, 'preview', { previewId: preview.id }),
          event(2, 'completed', { deliverables: ['missing.csv', 'unknown.csv'] })
        ],
        previews: [preview],
        previewAvailability: new Map([[preview.id, 'unavailable']]),
        files: new Map([['workspace/missing.csv', { status: 'unavailable' }]])
      })
    );
    expect(result.results).toHaveLength(3);
    expect(result.results.map((r) => [r.status, r.url, r.downloadUrl])).toEqual([
      ['unavailable', null, null],
      ['unavailable', null, null],
      ['unknown', null, `/v1/workspaces/${workspaceId}/download?path=workspace%2Funknown.csv`]
    ]);
  });
  it('shows planned files as pending during work and unavailable when a finished task failed to produce them', () => {
    const pending = input({
      taskStatus: 'running',
      plan: {
        taskId,
        steps: [],
        outputs: [{ kind: 'document', title: 'Analysis', files: ['results.json'] }]
      } as never,
      files: new Map([['workspace/results.json', { status: 'unavailable' }]])
    });
    expect(buildTaskPresentation(pending).results).toMatchObject([
      {
        status: 'unknown',
        downloadUrl: null,
        detail: 'This planned output is not available yet.'
      }
    ]);
    expect(buildTaskPresentation({ ...pending, taskStatus: 'completed' }).results).toMatchObject([
      {
        status: 'unavailable',
        downloadUrl: null,
        detail: 'This file is no longer available.'
      }
    ]);
  });

  it.each([
    '/etc/passwd',
    '../private.key',
    'workspace/../private.key',
    'workspace//file',
    'https://evil.test/file',
    'javascript:alert(1)',
    'workspace/a\\b',
    'workspace/a?b',
    'workspace/a\u0000b',
    ''
  ])('rejects unsafe delivery path %j', (value) => {
    expect(deliveryFilePath(value)).toBeNull();
  });
});

describe('task progress is a deterministic reading of actual work', () => {
  it('preserves observed steps on reconnect and never equates elapsed work with percent complete', () => {
    const events = [
      event(1, 'tool_started', {
        toolCallId: 'write',
        tool: 'file_write',
        arguments: { path: 'app.js' }
      }),
      event(2, 'tool_result', { toolCallId: 'write', result: { path: 'app.js' } }),
      event(3, 'tool_started', {
        toolCallId: 'test',
        tool: 'shell',
        arguments: { executable: 'node', args: ['--test'] }
      }),
      event(4, 'tool_result', {
        toolCallId: 'test',
        result: { exitCode: 1, stderr: 'assertion failed' }
      }),
      event(5, 'tool_started', {
        toolCallId: 'read',
        tool: 'file_read',
        arguments: { path: 'app.js' }
      })
    ];
    const expected = buildTaskPresentation(input({ events, taskStatus: 'running' }));
    const replay = buildTaskPresentation(
      input({ events: [...[...events].reverse(), events[1]!], taskStatus: 'running' })
    );
    expect(replay).toEqual(expected);
    expect(expected.progress.current).toMatchObject({ eventId: 'event-5' });
    expect(expected.progress.metrics).toEqual([
      { key: 'files', label: 'Files changed', value: 1 },
      { key: 'commands', label: 'Commands run', value: 1 }
    ]);
    expect(expected.progress.milestones).toHaveLength(2);
    expect(expected.progress.milestones[1]).toMatchObject({
      kind: 'check',
      status: 'failed',
      detail: 'node --test'
    });
    expect(JSON.stringify(expected)).not.toMatch(/percent|100%/);
  });

  it('does not count rejected or skipped tool operations as work', () => {
    const events = [
      event(1, 'tool_started', {
        toolCallId: 'write',
        tool: 'file_write',
        arguments: { path: 'app.js' }
      }),
      event(2, 'tool_result', { toolCallId: 'write', result: { skipped: true, reason: 'Denied' } })
    ];
    const result = buildTaskPresentation(input({ events }));
    expect(result.progress.metrics).toEqual([]);
    expect(result.progress.milestones).toEqual([]);
    expect(result.progress.current).toBeNull();
  });

  it('counts source addresses in returned evidence rather than a requested limit', () => {
    const events = [
      event(1, 'tool_started', {
        toolCallId: 'search',
        tool: 'web_search',
        arguments: { limit: 100 }
      }),
      event(2, 'tool_result', {
        toolCallId: 'search',
        result: {
          results: [
            { url: 'https://source.test/a' },
            { url: 'https://source.test/a' },
            { url: 'javascript:bad' }
          ]
        }
      })
    ];
    const result = buildTaskPresentation(input({ events }));
    expect(result.progress.kind).toBe('research');
    expect(result.progress.metrics).toEqual([{ key: 'sources', label: 'Sources found', value: 1 }]);
  });
});

describe('observed source fallback and active progress', () => {
  it('offers a successfully written file when a completion declares no output', () => {
    const result = buildTaskPresentation(
      input({
        events: [
          event(1, 'tool_started', {
            toolCallId: 'write',
            tool: 'file_write',
            arguments: { path: 'report.csv' }
          }),
          event(2, 'tool_result', {
            toolCallId: 'write',
            result: { path: 'report.csv', bytes: 20 }
          }),
          event(3, 'completed', { deliverables: [] })
        ],
        files: new Map([['workspace/report.csv', { status: 'ready' }]])
      })
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      path: 'workspace/report.csv',
      evidenceEventIds: ['event-2'],
      status: 'ready'
    });
  });
  it('does not pretend a failed tool is still working', () => {
    const result = buildTaskPresentation(
      input({
        taskStatus: 'running',
        events: [
          event(1, 'tool_started', {
            toolCallId: 'write',
            tool: 'file_write',
            arguments: { path: 'report.csv' }
          }),
          event(2, 'error', { toolCallId: 'write' }, 'Write failed')
        ]
      })
    );
    expect(result.progress.current).toBeNull();
    expect(result.progress.milestones).toHaveLength(1);
    expect(result.progress.milestones[0]).toMatchObject({ status: 'failed' });
  });
});

/**
 * The clock and the counter beside a milestone.
 *
 * The owner reads plan steps to know how far in the work is, and a bare tick answers neither "how
 * long did that take" nor "how much of it is done". The step rows carry no clock, so timing is
 * recovered by walking the plan's own versions: each `plan` event is a whole snapshot, so the first
 * version in which a step is running is when it started and the first in which it closes is when it
 * ended. Nothing new is written to get this - it is read out of history that was already there,
 * which is why it also works for a run that finished before any of it existed.
 */
describe('milestone timing and sub-milestone counts', () => {
  const at = (sequence: number, kind: TaskEvent['kind'], payload: unknown, when: string) => ({
    ...event(sequence, kind, payload),
    createdAt: when
  });
  const planWith = (steps: unknown[]) => ({
    id: 'plan-1',
    taskId,
    version: 3,
    parentVersion: null,
    branchName: 'Main',
    steps,
    createdBy: 'agent',
    createdAt: '2026-09-06T11:00:00.000Z'
  });

  it('dates a step from the plan version that started it and the one that closed it', () => {
    const events = [
      at(
        1,
        'plan',
        { steps: [{ id: 'a', title: 'First', status: 'in_progress' }] },
        '2026-09-06T11:10:00.000Z'
      ),
      at(
        2,
        'plan',
        { steps: [{ id: 'a', title: 'First', status: 'completed' }] },
        '2026-09-06T11:25:00.000Z'
      )
    ];
    const built = buildTaskPresentation(
      input({
        events,
        plan: planWith([{ id: 'a', title: 'First', status: 'completed' }]) as never
      })
    );
    expect(built.progress.phases[0]).toMatchObject({
      id: 'a',
      startedAt: '2026-09-06T11:10:00.000Z',
      completedAt: '2026-09-06T11:25:00.000Z'
    });
    expect(TaskPresentation.parse(built)).toBeTruthy();
  });

  it('prefers a stamp the step carries over one inferred from the versions', () => {
    const events = [
      at(
        1,
        'plan',
        { steps: [{ id: 'a', title: 'First', status: 'in_progress' }] },
        '2026-09-06T11:10:00.000Z'
      )
    ];
    const built = buildTaskPresentation(
      input({
        events,
        plan: planWith([
          { id: 'a', title: 'First', status: 'in_progress', startedAt: '2026-09-06T09:00:00.000Z' }
        ]) as never
      })
    );
    expect(built.progress.phases[0]?.startedAt).toBe('2026-09-06T09:00:00.000Z');
  });

  it('counts a milestone by the parts that have closed, skipped included', () => {
    const built = buildTaskPresentation(
      input({
        plan: planWith([
          {
            id: 'a',
            title: 'Ship it',
            status: 'in_progress',
            substeps: [
              { id: 'a1', title: 'Write it', status: 'completed' },
              { id: 'a2', title: 'Drop the extra', status: 'skipped' },
              { id: 'a3', title: 'Test it', status: 'in_progress' }
            ]
          }
        ]) as never
      })
    );
    expect(built.progress.phases[0]).toMatchObject({ countDone: 2, countTotal: 3 });
    expect(built.progress.phases[0]?.substeps).toHaveLength(3);
  });

  it('leaves a milestone with no parts uncounted rather than reporting nought of nought', () => {
    const built = buildTaskPresentation(
      input({ plan: planWith([{ id: 'a', title: 'Alone', status: 'pending' }]) as never })
    );
    expect(built.progress.phases[0]?.countTotal).toBeUndefined();
  });

  it('carries the task status through, so a partial finish can be labelled as one', () => {
    const built = buildTaskPresentation(input({ taskStatus: 'completed' }));
    expect(built.taskStatus).toBe('completed');
  });
});

/**
 * Failures the owner can see the shape of.
 *
 * A failed tool call writes one line into the trace, and the trace shows the last two dozen lines of
 * the current direction. Measured on one real run: thirty-seven failures over five hours, of which
 * the owner could have seen a handful. The count is what makes "the model kept fighting a tool"
 * visible as the thing it is.
 */
describe('failed tool calls are counted, not only listed', () => {
  const failures = (built: ReturnType<typeof buildTaskPresentation>) =>
    built.progress.metrics.find((metric) => metric.key === 'toolFailures')?.value;

  it('records a detected human challenge as an intervention while preserving real failures', () => {
    const built = buildTaskPresentation(
      input({
        taskStatus: 'awaiting_user',
        events: [
          event(1, 'tool_started', { toolCallId: 'wall', tool: 'browser_action', arguments: {} }),
          event(
            2,
            'error',
            {
              toolCallId: 'wall',
              code: 'browser_bot_wall',
              botWall: { tabId: 'tab-2' }
            },
            'browser_action failed'
          ),
          event(3, 'error', { toolCallId: 'network', code: 'network_error' }, 'Connection failed')
        ]
      })
    );
    expect(failures(built)).toBe(1);
    expect(built.progress.milestones).toContainEqual(
      expect.objectContaining({
        kind: 'checkpoint',
        title: 'Browser verification requested',
        status: 'observed'
      })
    );
    expect(built.progress.milestones.some((entry) => entry.title === 'browser_action failed')).toBe(
      false
    );
  });

  it('counts every failure, including ones whose start scrolled out of the window', () => {
    const built = buildTaskPresentation(
      input({
        events: [
          event(1, 'tool_started', { toolCallId: 'a', tool: 'shell', arguments: {} }),
          event(2, 'error', { toolCallId: 'a', tool: 'shell' }, 'shell failed'),
          // No `tool_started` for this one - the read window began after it.
          event(3, 'error', { toolCallId: 'b', tool: 'shell' }, 'shell failed')
        ]
      })
    );
    expect(failures(built)).toBe(2);
  });

  it('says nothing at all about a run in which nothing failed', () => {
    expect(failures(buildTaskPresentation(input({ events: [] })))).toBeUndefined();
  });
});

/**
 * A follow-up must not delete the list.
 *
 * A direction opens a new plan, and `phases` shows only the plan of the direction being worked - so
 * between the owner sending a follow-up and the model writing its next plan, the panel would show
 * nothing at all, and everything the project had already done would go off the screen with it.
 * It stays in the record either way; these keep it in the view.
 */
describe('the trajectory a project keeps across its directions', () => {
  const plan = (
    sequence: number,
    directionEventId: string,
    steps: { id: string; title: string; status: string }[]
  ) => event(sequence, 'plan', { directionEventId, steps });

  it('keeps the earlier direction`s list when the current one has no plan yet', () => {
    const built = buildTaskPresentation(
      input({
        events: [
          event(1, 'user_message', { markdown: 'Build the game' }),
          plan(2, 'event-1', [{ id: 'a', title: 'Draw the map', status: 'completed' }]),
          event(3, 'user_message', { markdown: 'Now add battles' })
        ]
      })
    );
    // Nothing is being worked to yet, which is exactly the moment the list could vanish.
    expect(built.progress.phases).toEqual([]);
    expect(built.progress.history).toHaveLength(1);
    expect(built.progress.history[0]?.phases.map((phase) => phase.title)).toEqual(['Draw the map']);
  });

  it('does not repeat the direction being worked now in its own history', () => {
    const events = [
      event(1, 'user_message', { markdown: 'Build the game' }),
      plan(2, 'event-1', [{ id: 'a', title: 'Draw the map', status: 'completed' }])
    ];
    const built = buildTaskPresentation(
      input({
        events,
        plan: {
          id: 'plan-1',
          taskId,
          version: 1,
          parentVersion: null,
          branchName: 'Main',
          directionEventId: 'event-1',
          steps: [{ id: 'a', title: 'Draw the map', status: 'completed' }],
          createdBy: 'agent',
          createdAt: now
        } as never
      })
    );
    expect(built.progress.phases.map((phase) => phase.title)).toEqual(['Draw the map']);
    expect(built.progress.history).toEqual([]);
  });

  it('keeps only the last plan each earlier direction reached', () => {
    const built = buildTaskPresentation(
      input({
        events: [
          event(1, 'user_message', { markdown: 'Build the game' }),
          plan(2, 'event-1', [{ id: 'a', title: 'First attempt', status: 'in_progress' }]),
          plan(3, 'event-1', [
            { id: 'a', title: 'First attempt', status: 'completed' },
            { id: 'b', title: 'Second thing', status: 'completed' }
          ]),
          event(4, 'user_message', { markdown: 'Now add battles' })
        ]
      })
    );
    expect(built.progress.history).toHaveLength(1);
    expect(built.progress.history[0]?.phases.map((phase) => phase.title)).toEqual([
      'First attempt',
      'Second thing'
    ]);
  });
});

/**
 * A plan written before any direction existed keys on no direction at all, and so does "there is no
 * current direction". Conflating the two took the only list an older task had out of its own
 * history - the one case where the retained trajectory had something to show and showed nothing.
 */
describe('a plan that predates directions', () => {
  it('is kept in the history rather than mistaken for the current one', () => {
    const built = buildTaskPresentation(
      input({
        events: [
          event(1, 'plan', { steps: [{ id: 'a', title: 'Legacy step', status: 'completed' }] })
        ]
      })
    );
    expect(built.progress.history[0]?.phases.map((phase) => phase.title)).toEqual(['Legacy step']);
  });
});

/**
 * What a milestone says about itself on hover.
 *
 * Written by nobody: the events between a step starting and closing are what that step did, so the
 * line is counted off the activity already recorded. It costs no tokens, cannot be forgotten by a
 * model that was busy, and is there for runs that finished before any of this existed.
 */
describe('the account a milestone gives of itself', () => {
  const at = (sequence: number, kind: TaskEvent['kind'], payload: unknown, when: string) => ({
    ...event(sequence, kind, payload),
    createdAt: when
  });
  const planWith = (steps: unknown[]) => ({
    id: 'plan-1',
    taskId,
    version: 2,
    parentVersion: null,
    branchName: 'Main',
    steps,
    createdBy: 'agent',
    createdAt: '2026-09-06T11:00:00.000Z'
  });

  it('counts only what happened inside the step`s own window', () => {
    const events = [
      // Before the step starts: must not be counted against it.
      at(
        1,
        'tool_started',
        { toolCallId: 'x', tool: 'file_write', arguments: { path: 'early.ts' } },
        '2026-09-06T10:00:00.000Z'
      ),
      at(
        2,
        'tool_result',
        { toolCallId: 'x', result: { ok: true, path: 'early.ts' } },
        '2026-09-06T10:00:01.000Z'
      ),
      at(
        3,
        'plan',
        { steps: [{ id: 'a', title: 'Build', status: 'in_progress' }] },
        '2026-09-06T11:00:00.000Z'
      ),
      at(
        4,
        'tool_started',
        { toolCallId: 'y', tool: 'file_write', arguments: { path: 'app/index.html' } },
        '2026-09-06T11:05:00.000Z'
      ),
      at(
        5,
        'tool_result',
        { toolCallId: 'y', result: { ok: true, path: 'app/index.html' } },
        '2026-09-06T11:05:01.000Z'
      ),
      at(
        6,
        'plan',
        { steps: [{ id: 'a', title: 'Build', status: 'completed' }] },
        '2026-09-06T11:10:00.000Z'
      )
    ];
    const built = buildTaskPresentation(
      input({ events, plan: planWith([{ id: 'a', title: 'Build', status: 'completed' }]) as never })
    );
    const phase = built.progress.phases[0];
    expect(phase?.detail).toContain('1 file changed');
    expect(phase?.detail).toContain('app/index.html');
    expect(phase?.detail).not.toContain('early.ts');
  });

  it('gives a part its own window and its own account', () => {
    const events = [
      at(
        1,
        'plan',
        {
          steps: [
            {
              id: 'a',
              title: 'Ship',
              status: 'in_progress',
              substeps: [{ id: 'a1', title: 'Write it', status: 'in_progress' }]
            }
          ]
        },
        '2026-09-06T11:00:00.000Z'
      ),
      at(
        2,
        'tool_started',
        { toolCallId: 'y', tool: 'file_write', arguments: { path: 'app/page.tsx' } },
        '2026-09-06T11:02:00.000Z'
      ),
      at(
        3,
        'tool_result',
        { toolCallId: 'y', result: { ok: true, path: 'app/page.tsx' } },
        '2026-09-06T11:02:01.000Z'
      ),
      at(
        4,
        'plan',
        {
          steps: [
            {
              id: 'a',
              title: 'Ship',
              status: 'in_progress',
              substeps: [{ id: 'a1', title: 'Write it', status: 'completed' }]
            }
          ]
        },
        '2026-09-06T11:03:00.000Z'
      )
    ];
    const built = buildTaskPresentation(
      input({
        events,
        plan: planWith([
          {
            id: 'a',
            title: 'Ship',
            status: 'in_progress',
            substeps: [{ id: 'a1', title: 'Write it', status: 'completed' }]
          }
        ]) as never
      })
    );
    const part = built.progress.phases[0]?.substeps?.[0];
    expect(part?.startedAt).toBe('2026-09-06T11:00:00.000Z');
    expect(part?.completedAt).toBe('2026-09-06T11:03:00.000Z');
    expect(part?.detail).toContain('app/page.tsx');
  });

  it('says nothing about a step nothing was recorded inside', () => {
    const built = buildTaskPresentation(
      input({ plan: planWith([{ id: 'a', title: 'Untouched', status: 'pending' }]) as never })
    );
    expect(built.progress.phases[0]?.detail).toBeUndefined();
  });
});

/**
 * The run's own account of how it ended.
 *
 * `finish` has always declared a summary, its deliverables and its verification, and the
 * `completed` event has always carried all of it. None of it was ever presented as an ending: an
 * owner returning to a finished run got a status line reading Complete and a trace to read
 * backwards. This is that payload, promoted to the panel.
 */
describe('how a finished run says it went', () => {
  const completion = {
    summary: 'Rebuilt the importer and re-ran the March batch against it.',
    deliverables: ['reports/march.csv', 'https://garden.test/__garden/preview/real/'],
    verification: {
      status: 'verified',
      evidence: [
        { claim: 'the batch completes', source: 'tool_result' },
        { claim: 'the totals match', source: 'tool_result' }
      ],
      remainingRisks: ['The 2024 archive is still unmigrated.']
    }
  };

  it('reads the ending off the completed event the run already writes', () => {
    const result = buildTaskPresentation(
      input({ events: [event(1, 'completed', completion, 'Task completed')] })
    );
    expect(result.outcome).toMatchObject({
      summary: 'Rebuilt the importer and re-ran the March batch against it.',
      verification: 'verified',
      evidence: 2,
      remainingRisks: ['The 2024 archive is still unmigrated.']
    });
    expect(TaskPresentation.parse(result).outcome?.at).toBe(now);
  });

  /**
   * A project with several directions has a `completed` event per direction. Showing the first one
   * over work that is running now would announce an ending that has not happened.
   */
  /**
   * A finish declares its own deliverables, and they are the model's unverified strings: a run that
   * has read a hostile page can declare any address it likes. Printing them on the card would be
   * garden vouching for a link it never resolved, so the card names none of them and `results` -
   * which this box resolved itself - is the answer to what can be opened.
   */
  it('never prints an address the model declared for itself', () => {
    const result = buildTaskPresentation(
      input({
        events: [
          event(1, 'completed', {
            ...completion,
            deliverables: ['https://untrusted.test/collect?q=1']
          })
        ]
      })
    );
    expect(JSON.stringify(result)).not.toContain('untrusted.test');
  });

  it.each([
    'running',
    'planning',
    'paused',
    'awaiting_user',
    'awaiting_resource',
    'queued',
    'failed',
    'cancelled'
  ] as const)('does not present an earlier ending over a %s direction', (taskStatus) => {
    const result = buildTaskPresentation(
      input({
        taskStatus,
        events: [event(1, 'completed', completion), event(2, 'user_message', {}, 'Now do April')]
      })
    );
    expect(result.outcome).toBeUndefined();
  });

  it('requires an ending from the current direction even if task status still says completed', () => {
    const result = buildTaskPresentation(
      input({
        events: [event(1, 'completed', completion), event(2, 'user_message', {}, 'Now do April')]
      })
    );
    expect(result.outcome).toBeUndefined();
  });

  it('keeps failed verification distinct from an answer with nothing external to check', () => {
    const result = buildTaskPresentation(
      input({
        events: [
          event(1, 'completed', {
            summary: 'The result needs review.',
            verification: {
              status: 'unverified',
              evidence: [],
              remainingRisks: ['Completion evidence could not be verified.']
            }
          })
        ]
      })
    );
    expect(result.outcome).toMatchObject({
      verification: 'unverified',
      remainingRisks: ['Completion evidence could not be verified.']
    });
  });

  it('shows the newest ending when a project has finished more than once', () => {
    const result = buildTaskPresentation(
      input({
        events: [
          event(1, 'completed', completion),
          event(2, 'user_message', {}, 'Now do April'),
          event(
            3,
            'completed',
            { ...completion, summary: 'April too.', verification: { status: 'not_applicable' } },
            'Task completed'
          )
        ]
      })
    );
    expect(result.outcome).toMatchObject({
      summary: 'April too.',
      verification: 'not_applicable',
      evidence: 0,
      remainingRisks: []
    });
  });

  /**
   * A finish that declared no verification is not the same as one that verified nothing, and the
   * card must not let the first read as the second.
   */
  it('does not call an unverified finish checked', () => {
    const result = buildTaskPresentation(
      input({ events: [event(1, 'completed', { summary: 'Done.' })] })
    );
    expect(result.outcome).toMatchObject({ verification: 'unverified', evidence: 0 });
  });

  it('falls back to the event summary when the payload carries no words of its own', () => {
    const result = buildTaskPresentation(
      input({ events: [event(1, 'completed', {}, 'Task completed')] })
    );
    expect(result.outcome?.summary).toBe('Task completed');
  });

  /**
   * The count and the status line disagreeing is the point: a run may legitimately stop with steps
   * open, and the owner should be told which number is which.
   */
  it('counts the plan steps still open at the finish', () => {
    const steps = [
      { id: 'a', title: 'Read the schema', status: 'completed' },
      { id: 'b', title: 'Write the importer', status: 'completed' },
      { id: 'c', title: 'Migrate the archive', status: 'pending' },
      { id: 'd', title: 'Delete the old path', status: 'skipped' }
    ];
    const result = buildTaskPresentation(
      input({
        events: [event(1, 'plan', { steps }, 'Plan set'), event(2, 'completed', completion)],
        plan: {
          id: 'plan-1',
          taskId,
          version: 1,
          parentVersion: null,
          branchName: 'Main',
          steps,
          createdBy: 'agent',
          createdAt: now
        } as never
      })
    );
    // Skipped is a decision, not an omission, so it does not count as left open.
    expect(result.outcome?.openSteps).toBe(1);
  });
});
