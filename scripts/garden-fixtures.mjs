/**
 * A garden in the middle of a week, served over HTTP without a database, a worker or a model.
 *
 * Every goal state the desk draws is here at once - growing, waiting on a deal, waiting on an
 * approval, paused at its cap, ready and checked, failed - so the layout harness and anyone
 * working on the interface see the same scene. Times are relative to the moment the server starts.
 * Writes change the scene the way the real API would, so a planted deal or an answered question
 * shows up on the next read.
 */
import { randomUUID } from 'node:crypto';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export function createGardenFixtures(now = Date.now()) {
  const at = (offset) => new Date(now + offset).toISOString();
  const workspace = {
    id: '10000000-0000-4000-8000-000000000001',
    name: 'garden',
    status: 'running',
    securityMode: 'balanced',
    region: 'local',
    storageBytes: 41_000_000_000,
    storageLimitBytes: 100_000_000_000,
    createdAt: at(-90 * 24 * HOUR),
    updatedAt: at(-HOUR)
  };
  const id = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const task = (n, fields) => ({
    id: id(n),
    workspaceId: workspace.id,
    scheduleId: null,
    status: 'running',
    modelId: 'fixture/lead',
    privacyRoute: 'provider_zdr',
    securityMode: 'balanced',
    reasoningEffort: 'auto',
    maxComputeCredits: 40,
    actualComputeCredits: 6,
    maxSpendUsd: 14,
    spentUsd: 3.4,
    spendPausedAt: null,
    completedAt: null,
    queuedMessageCount: 0,
    shareCount: 0,
    rewind: null,
    restoredCheckpointId: null,
    pinned: false,
    archivedAt: null,
    createdAt: at(-3 * 24 * HOUR),
    updatedAt: at(-12 * MINUTE),
    ...fields
  });
  const activity = (total, done, currentStep, latest, verification = null) => ({
    currentStep,
    stepsCompleted: done,
    stepsTotal: total,
    latest,
    eventId: null,
    observedAt: at(-10 * MINUTE),
    ...(verification ? { ending: { interrupted: false, verification } } : {})
  });

  const tasks = [
    task(1, {
      title: 'RNA-seq reanalysis for the paper',
      maxSpendUsd: 14,
      spentUsd: 6.2,
      securityMode: 'balanced',
      activity: activity(
        6,
        3,
        'Recomputing clusters',
        'Two samples ran on another platform; re-running them separately, about 3 h more'
      )
    }),
    task(2, {
      title: 'Bioinformatics roles in Berlin',
      status: 'awaiting_user',
      securityMode: 'autonomous',
      maxSpendUsd: 12,
      spentUsd: 4.1,
      activity: activity(5, 3, 'Sending applications', '6 applications sent, 2 replies')
    }),
    task(3, {
      title: '2025 tax return',
      status: 'completed',
      completedAt: at(-2 * HOUR),
      updatedAt: at(-2 * HOUR),
      maxSpendUsd: 8,
      spentUsd: 4.6,
      activity: activity(
        5,
        5,
        null,
        'Checked: validation passed, every figure links to a document',
        'verified'
      )
    }),
    task(4, {
      title: 'Weekly brief from starred mail',
      status: 'awaiting_user',
      maxSpendUsd: null,
      spentUsd: 0.04,
      updatedAt: at(-3 * MINUTE),
      createdAt: at(-4 * MINUTE),
      activity: undefined
    }),
    task(5, {
      title: 'Literature review: tissue-resident T cells',
      status: 'paused',
      spendPausedAt: at(-40 * MINUTE),
      maxSpendUsd: 6,
      spentUsd: 6,
      activity: activity(4, 2, 'Reading 38 papers', 'Read 21 of 38 papers')
    }),
    task(6, {
      title: 'Morning brief',
      status: 'completed',
      scheduleId: '30000000-0000-4000-8000-000000000001',
      completedAt: at(-6 * HOUR),
      updatedAt: at(-6 * HOUR),
      spentUsd: 0.12,
      maxSpendUsd: 1,
      activity: activity(2, 2, null, 'Nothing urgent. Three things to glance at.', 'not_applicable')
    }),
    task(7, {
      title: 'Portfolio site refresh',
      status: 'completed',
      archivedAt: at(-5 * 24 * HOUR),
      completedAt: at(-6 * 24 * HOUR),
      updatedAt: at(-5 * 24 * HOUR),
      activity: activity(4, 4, null, 'Live at the preview link', 'verified')
    })
  ];

  const deal = {
    summary: 'A one-page brief every Monday of what your starred mail still needs from you.',
    goals: [
      {
        title: 'Weekly brief from starred mail',
        outcome: 'A one-page brief on Monday mornings: what still needs you, and by when.',
        doneWhen: 'Every starred thread from the week is either in the brief or marked as done.',
        estimate: 'about 4 min a week',
        rhythm: 'Mondays at 07:30',
        capUsd: 2
      }
    ],
    questions: [
      { question: 'Where should the brief land?', options: ['Telegram', 'Email', 'Just here'] },
      { question: 'Include newsletters you starred?', options: ['Yes', 'No'] }
    ],
    actAsYou: false
  };
  const moves = [
    {
      kind: 'deal',
      taskId: id(4),
      taskTitle: 'Weekly brief from starred mail',
      at: at(-3 * MINUTE),
      questionId: '50000000-0000-4000-8000-000000000001',
      deal
    },
    {
      kind: 'approval',
      taskId: id(2),
      taskTitle: 'Bioinformatics roles in Berlin',
      at: at(-25 * MINUTE),
      approvalId: '60000000-0000-4000-8000-000000000001',
      action: 'Submit an application to Mitte Diagnostics',
      detail:
        'Staff Scientist. The posting asks for German at C1, which is outside your brief. Everything else matches.',
      tool: 'browser_action',
      sideEffect: 'external_consequential',
      expiresAt: at(20 * HOUR)
    },
    {
      kind: 'spend',
      taskId: id(5),
      taskTitle: 'Literature review: tissue-resident T cells',
      at: at(-40 * MINUTE),
      spentUsd: 6,
      maxSpendUsd: 6
    }
  ];
  const schedules = [
    {
      id: '30000000-0000-4000-8000-000000000001',
      workspaceId: workspace.id,
      title: 'Morning brief',
      prompt: 'Read overnight mail and calendar; say what needs me today.',
      modelId: 'fixture/lead',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 2,
      maxSpendUsd: 1,
      spec: { kind: 'daily', timeZone: 'Europe/London', localTime: '07:30' },
      enabled: true,
      nextRunAt: at(17 * HOUR),
      lastRunAt: at(-6 * HOUR),
      lastTaskId: id(6),
      lastErrorCode: null,
      createdAt: at(-30 * 24 * HOUR),
      updatedAt: at(-6 * HOUR)
    },
    {
      id: '30000000-0000-4000-8000-000000000002',
      workspaceId: workspace.id,
      title: 'Replies to my accountant',
      prompt: 'Watch the inbox for my accountant and reply in the thread.',
      modelId: 'fixture/lead',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 2,
      maxSpendUsd: 1,
      spec: { kind: 'interval', everyMinutes: 60 },
      enabled: true,
      nextRunAt: at(34 * MINUTE),
      lastRunAt: at(-26 * MINUTE),
      lastTaskId: null,
      lastErrorCode: null,
      createdAt: at(-12 * 24 * HOUR),
      updatedAt: at(-26 * MINUTE)
    },
    {
      id: '30000000-0000-4000-8000-000000000003',
      workspaceId: workspace.id,
      title: 'Server health',
      prompt: 'Check backups and disk; tell me only if something is wrong.',
      modelId: 'fixture/lead',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      maxSpendUsd: 0.5,
      spec: { kind: 'daily', timeZone: 'Europe/London', localTime: '02:00' },
      enabled: false,
      nextRunAt: null,
      lastRunAt: at(-3 * 24 * HOUR),
      lastTaskId: null,
      lastErrorCode: null,
      createdAt: at(-60 * 24 * HOUR),
      updatedAt: at(-3 * 24 * HOUR)
    }
  ];

  const state = {
    workspace,
    tasks,
    moves,
    schedules,
    preferences: { lastLookAt: at(-26 * HOUR) },
    drafts: new Map(),
    serverUpdate: 'current',
    created: [],
    record: [
      {
        id: randomUUID(),
        at: at(-25 * MINUTE),
        taskId: id(2),
        taskTitle: 'Bioinformatics roles in Berlin',
        action: 'Submit an application to Mitte Diagnostics',
        detail: 'Outside the brief: German at C1.',
        tool: 'browser_action',
        source: 'card',
        verdict: 'waiting',
        sideEffect: 'external_consequential'
      },
      {
        id: randomUUID(),
        at: at(-5 * HOUR),
        taskId: id(2),
        taskTitle: 'Bioinformatics roles in Berlin',
        action: 'Send 6 applications to roles that match your brief',
        detail: 'Spreeline Bio, Nordlicht Genomics, Kestrel Omics and 3 more.',
        tool: 'browser_action',
        source: 'key',
        verdict: 'approved',
        sideEffect: 'external_consequential'
      },
      {
        id: randomUUID(),
        at: at(-9 * HOUR),
        taskId: id(3),
        taskTitle: '2025 tax return',
        action: 'File the 2025 return',
        detail: 'Filing is yours: it was prepared for your signature instead.',
        tool: 'browser_action',
        source: 'card',
        verdict: 'denied',
        sideEffect: 'external_consequential'
      },
      {
        id: randomUUID(),
        at: at(-27 * HOUR),
        taskId: id(1),
        taskTitle: 'RNA-seq reanalysis for the paper',
        action: 'Buy one journal article for $18',
        detail: 'Single-use card, locked to the publisher and the amount.',
        tool: 'browser_action',
        source: 'card',
        verdict: 'approved',
        sideEffect: 'external_consequential'
      },
      {
        id: randomUUID(),
        at: at(-30 * HOUR),
        taskId: null,
        taskTitle: null,
        action: 'mail:message.send',
        detail: 'The service answered 200.',
        tool: 'connector_action',
        source: 'connector',
        verdict: 'succeeded'
      }
    ]
  };

  const bootstrap = () => ({
    user: {
      id: '40000000-0000-4000-8000-000000000004',
      username: 'dan',
      displayName: 'Dan',
      preferences: state.preferences
    },
    workspaces: [state.workspace],
    tasks: state.tasks,
    tasksCursor: null,
    scheduleRunCounts: {},
    schedules: state.schedules,
    drafts: [...state.drafts.values()],
    projects: [],
    projectsCursor: null,
    models: [
      {
        id: 'fixture/lead',
        providerModelId: 'lead',
        displayName: 'Fixture lead model',
        provider: 'fixture',
        availability: 'available',
        privacyRoute: 'provider_zdr',
        reasoning: { supportedEfforts: ['low', 'medium', 'high'], mandatory: false }
      }
    ],
    instance: {
      mode: 'native',
      providerConfigured: true,
      enforceZeroDataRetention: true,
      webSearch: {}
    },
    computer: {
      cpuPercent: 38,
      memoryUsedBytes: 27_000_000_000,
      memoryTotalBytes: 64_000_000_000,
      gpu: {
        sampledAt: at(0),
        devices: [
          {
            id: 'GPU-0',
            name: 'Fixture GPU',
            utilizationPercent: 64,
            memoryUsedBytes: 9e9,
            memoryTotalBytes: 24e9,
            temperatureC: 61
          }
        ]
      }
    },
    usage: {
      providerSpend: {
        windows: {
          daily: { used: 3.1, resetsAt: at(8 * HOUR) },
          weekly: { used: 19.4, resetsAt: at(4 * 24 * HOUR) },
          monthly: { used: 61.2, resetsAt: at(20 * 24 * HOUR) }
        }
      },
      consumedCredits: 120,
      reservedCredits: 12,
      storageBytes: state.workspace.storageBytes,
      storageLimitBytes: state.workspace.storageLimitBytes,
      plan: null
    }
  });

  const processes = () => ({
    processes: [
      {
        sessionId: 'p1',
        ownerTaskId: id(1),
        status: 'running',
        command: ['python', 'cluster.py', '--resolution', '0.8'],
        startedAt: at(-40 * MINUTE),
        ranForMs: 40 * MINUTE,
        outputBytes: 2048,
        resources: {
          sampledAt: at(0),
          intervalMs: 2000,
          cpuPercent: 690,
          residentBytes: 12e9,
          processCount: 9,
          threadCount: 40,
          children: []
        }
      },
      {
        sessionId: 'p2',
        ownerTaskId: id(2),
        status: 'running',
        command: 'chromium',
        service: { name: 'Browser · forms' },
        startedAt: at(-2 * HOUR),
        ranForMs: 2 * HOUR,
        outputBytes: 0,
        resources: {
          sampledAt: at(0),
          intervalMs: 2000,
          cpuPercent: 80,
          residentBytes: 1e9,
          processCount: 4,
          threadCount: 30,
          children: []
        }
      }
    ],
    host: { logicalCpus: 16, memoryBytes: 64e9, commandMemoryLimitBytes: 44e9 },
    observedAt: at(0)
  });

  const json = (response, body, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const body = (request) =>
    new Promise((resolve) => {
      let text = '';
      request.on('data', (chunk) => (text += chunk));
      request.on('end', () => {
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch {
          resolve({});
        }
      });
    });
  const findTask = (taskId) => state.tasks.find((item) => item.id === taskId);

  /** What one goal recorded: its events, plan, results and the files behind them. */
  const figure = (() => {
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const gauss = () => Math.sqrt(-2 * Math.log(random() || 1e-9)) * Math.cos(6.283 * random());
    const clusters = [
      [-0.6, 0.42, 150, '#4f7fb0'],
      [0.06, 0.5, 230, '#2f8f5a'],
      [0.38, -0.04, 170, '#7aa53a'],
      [0.66, -0.46, 100, '#8a64b0'],
      [-0.5, -0.48, 190, '#c9913a'],
      [0.78, 0.4, 95, '#d2563c']
    ];
    const dots = clusters
      .flatMap(([x, y, n, color]) =>
        Array.from({ length: n }, () => {
          const px = 360 + (x + gauss() * 0.12) * 300;
          const py = 230 - (y + gauss() * 0.11) * 190;
          return `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.6" fill="${color}" fill-opacity=".8"/>`;
        })
      )
      .join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 460"><rect width="720" height="460" fill="#fbfcfa"/>${dots}<text x="560" y="72" font-family="sans-serif" font-size="13" fill="#d2563c">new · 412 cells</text></svg>`;
  })();
  const artifacts = [
    {
      id: '70000000-0000-4000-8000-000000000001',
      workspaceId: workspace.id,
      taskId: id(1),
      name: 'figure_3.svg',
      mimeType: 'image/svg+xml',
      sizeBytes: Buffer.byteLength(figure),
      version: 2,
      sha256: 'a'.repeat(64),
      createdAt: at(-50 * MINUTE)
    }
  ];
  let sequence = 0;
  const event = (taskId, offset, kind, summary, payload) => ({
    id: randomUUID(),
    taskId,
    kind,
    sequence: ++sequence,
    summary,
    payload,
    createdAt: at(offset)
  });
  const agreed = (goal, doneWhen) =>
    `Deal agreed.\nGoal: ${goal}\nDone when: ${doneWhen}\nKeys: do not send, submit or book as me; ask first. Spend up to $14.00 on this goal.`;
  const scenes = {
    [id(1)]: [
      event(id(1), -26 * HOUR, 'user_message', 'User message', {
        markdown: agreed(
          'RNA-seq reanalysis for the paper. Reanalysed data, regenerated figures and an updated methods section.',
          'The pipeline reruns clean from raw reads and every figure regenerates from code.'
        )
      }),
      event(id(1), -26 * HOUR + MINUTE, 'plan', 'Plan', {
        steps: Array.from({ length: 6 }, (_, i) => ({ id: String(i) }))
      }),
      event(id(1), -26 * HOUR + 2 * MINUTE, 'assistant_message', 'Pulling raw reads', {
        markdown:
          'Pulling the raw reads for all 11 samples and checking their checksums before anything else.'
      }),
      event(id(1), -26 * HOUR + 3 * MINUTE, 'tool_started', 'shell', {
        tool: 'shell',
        arguments: { executable: 'prefetch', args: ['--option-file', 'runs.txt'] }
      }),
      event(id(1), -25 * HOUR, 'tool_result', 'shell finished', { tool: 'shell', exitCode: 0 }),
      event(id(1), -25 * HOUR, 'cost', 'Cost', { costUsd: 0.42 }),
      event(id(1), -20 * HOUR, 'assistant_message', 'Two samples differ', {
        markdown:
          'Samples 3 and 7 were sequenced on a different platform. Processing them separately adds about 3 hours; still inside the deal.'
      }),
      event(id(1), -20 * HOUR, 'tool_started', 'file_patch', {
        tool: 'file_patch',
        arguments: { path: 'pipeline/config.yaml' }
      }),
      event(id(1), -19 * HOUR, 'tool_result', 'file_patch finished', { tool: 'file_patch' }),
      event(id(1), -6 * HOUR, 'assistant_message', 'Converged', {
        markdown:
          'Batch correction converged: platform no longer explains the clustering (kBET 0.91).'
      }),
      event(id(1), -6 * HOUR, 'tool_started', 'shell', {
        tool: 'shell',
        arguments: { executable: 'python', args: ['cluster.py'] }
      }),
      event(id(1), -50 * MINUTE, 'artifact', 'Published figure_3.svg', {
        artifactId: artifacts[0].id,
        name: 'figure_3.svg'
      }),
      event(id(1), -48 * MINUTE, 'assistant_message', 'A second cluster', {
        markdown:
          'The batch effect was hiding a second T-cell cluster (CD103+ CD69+, 412 cells). Figure 3 now shows six clusters, not five.'
      }),
      event(id(1), -45 * MINUTE, 'tool_started', 'shell', {
        tool: 'shell',
        arguments: { executable: 'make', args: ['figures'] }
      }),
      event(id(1), -12 * MINUTE, 'cost', 'Cost', { costUsd: 0.31 })
    ],
    [id(3)]: [
      event(id(3), -30 * HOUR, 'user_message', 'User message', {
        markdown: agreed(
          '2025 tax return. A return ready to file.',
          'It passes validation and every figure links to its source.'
        )
      }),
      event(id(3), -30 * HOUR, 'plan', 'Plan', {
        steps: Array.from({ length: 5 }, (_, i) => ({ id: String(i) }))
      }),
      event(id(3), -12 * HOUR, 'assistant_message', 'Interest', {
        markdown:
          'Interest from your savings account was missing from last year too. Worth $43 of tax; included this time.'
      }),
      event(id(3), -12 * HOUR, 'tool_started', 'document_read', { tool: 'document_read' }),
      event(id(3), -2 * HOUR, 'assistant_message', 'Answer', {
        markdown:
          '## Your 2025 return is ready to file\n\nEvery figure links to the document it came from, and validation passed.\n\n| Line | Amount |\n| --- | ---: |\n| Employment income | $82,400 |\n| Untaxed interest | $214 |\n| Home office, 2 days a week | −$312 |\n| Pension contributions | −$4,800 |\n| **Refund due** | **$1,284** |\n\nFiling is yours: open the return and sign it when you are ready.'
      }),
      event(id(3), -2 * HOUR, 'completed', 'Task completed', {
        summary: 'A return ready to file; refund due $1,284.',
        verification: { status: 'verified' }
      })
    ],
    [id(2)]: [
      event(id(2), -40 * HOUR, 'user_message', 'User message', {
        markdown: agreed('Bioinformatics roles in Berlin.', 'Each application matches the brief.')
      }),
      event(id(2), -5 * HOUR, 'assistant_message', 'Sent', {
        markdown: 'Six applications sent, each tailored. Three more on Monday.'
      }),
      event(id(2), -5 * HOUR, 'tool_started', 'browser_action', { tool: 'browser_action' }),
      event(
        id(2),
        -25 * MINUTE,
        'approval_requested',
        'Submit an application to Mitte Diagnostics',
        {
          preview:
            'Staff Scientist. The posting asks for German at C1, which is outside your brief.'
        }
      )
    ]
  };
  const plans = {
    [id(1)]: [
      ['Raw reads verified', 'completed'],
      ['Aligned and quantified', 'completed'],
      ['Batch effect modelled', 'completed'],
      ['Clusters recomputed', 'in_progress'],
      ['Figures regenerated', 'pending'],
      ['Methods updated', 'pending']
    ],
    [id(3)]: [
      ['Documents gathered', 'completed'],
      ['Income reconciled', 'completed'],
      ['Home office claimed', 'completed'],
      ['Return drafted', 'completed'],
      ['Validation passed', 'completed']
    ]
  };
  const planFor = (taskId) =>
    plans[taskId]
      ? {
          id: randomUUID(),
          taskId,
          version: 2,
          parentVersion: 1,
          branchName: 'main',
          steps: plans[taskId].map(([title, status], index) => ({
            id: `${taskId}-${index}`,
            title,
            status
          })),
          createdBy: 'agent',
          createdAt: at(-HOUR)
        }
      : null;
  const presentationFor = (taskId) => {
    const found = findTask(taskId);
    const results =
      taskId === id(1)
        ? [
            {
              id: 'figure',
              kind: 'artifact',
              title: 'figure_3.svg',
              status: 'ready',
              url: null,
              downloadUrl: `/v1/artifacts/${artifacts[0].id}/content`,
              accessPath: null,
              artifactId: artifacts[0].id,
              mimeType: 'image/svg+xml',
              path: 'workspace/figures/figure_3.svg',
              evidenceEventIds: []
            }
          ]
        : [];
    return {
      version: 1,
      taskId,
      taskStatus: found?.status,
      eventCursor: sequence,
      results,
      progress: {
        kind: 'analysis',
        phases: (plans[taskId] ?? []).map(([title, status], index) => ({
          id: String(index),
          title,
          status
        })),
        current: null,
        history: [],
        metrics: [],
        milestones: [],
        updatedAt: at(0)
      },
      ...(found?.status === 'completed'
        ? {
            outcome: {
              summary: 'A return ready to file; refund due $1,284.',
              at: found.completedAt,
              verification: 'verified',
              evidenceCount: 47,
              remainingRisks: [],
              openSteps: []
            }
          }
        : {})
    };
  };

  /** Answers one request if it is part of the scene; returns false for anything else. */
  async function handle(request, response) {
    const url = new URL(request.url, 'http://fixture.local');
    const path = url.pathname;
    const method = request.method ?? 'GET';
    let match;
    if ((match = /^\/v1\/tasks\/([^/]+)\/events\/stream$/.exec(path))) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      response.write(': open\n\n');
      const beat = setInterval(() => response.write(': beat\n\n'), 15_000);
      request.on('close', () => clearInterval(beat));
      return true;
    }
    if ((match = /^\/v1\/tasks\/([^/]+)\/events$/.exec(path))) {
      const events = scenes[match[1]] ?? [];
      return (
        json(response, {
          events,
          hasMore: false,
          oldestSequence: events[0]?.sequence ?? null,
          nextCursor: events.at(-1)?.sequence ?? 0
        }),
        true
      );
    }
    if ((match = /^\/v1\/tasks\/([^/]+)\/plan$/.exec(path)))
      return (json(response, planFor(match[1])), true);
    if (
      /^\/v1\/(tasks|projects)\/[^/]+\/model-preferences$/.test(path) ||
      path === '/v1/workspace-model-preferences'
    )
      return (
        json(response, { revision: 0, choices: {}, purposes: [], decisionModelsEnabled: false }),
        true
      );
    if ((match = /^\/v1\/tasks\/([^/]+)\/presentation$/.exec(path)))
      return (json(response, presentationFor(match[1])), true);
    if (/^\/v1\/tasks\/[^/]+\/coding-missions$/.test(path))
      return (json(response, { missions: [] }), true);
    if (/^\/v1\/tasks\/[^/]+\/media-(jobs|assets|batches)$/.test(path))
      return (json(response, []), true);
    if ((match = /^\/v1\/tasks\/([^/]+)\/processes$/.exec(path)))
      return (json(response, processes()), true);
    if ((match = /^\/v1\/artifacts\/([^/]+)\/content$/.exec(path))) {
      response.writeHead(200, { 'content-type': 'image/svg+xml' });
      response.end(figure);
      return true;
    }
    if (path === '/v1/models')
      return (
        json(
          response,
          ['Claude Opus 5.5', 'Claude Sonnet 5.5', 'GPT-5.2', 'Gemini 3 Pro', 'Qwen 3.5 Coder'].map(
            (name, index) => ({
              id: `openrouter/fixture/model-${index}`,
              providerModelId: `fixture/model-${index}`,
              displayName: name,
              provider: 'openrouter',
              availability: 'available',
              privacyRoute: 'provider_zdr',
              contextTokens: 200000,
              inputUsdPerMillionTokens: 1 + index,
              outputUsdPerMillionTokens: 5 + index,
              modalities: ['text', 'image'],
              capabilities: ['chat', 'tools', 'reasoning'],
              reasoning: { supportedEfforts: ['low', 'medium', 'high'], mandatory: false }
            })
          )
        ),
        true
      );
    if (path === '/v1/providers') {
      const connections = [
        {
          connectionId: 'openrouter',
          provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          modelId: null,
          hasApiKey: true,
          enforceZeroDataRetention: true,
          configured: true,
          source: 'encrypted_database'
        },
        {
          connectionId: 'ollama-cloud',
          provider: 'ollama-cloud',
          baseUrl: 'https://ollama.com/v1',
          modelId: null,
          hasApiKey: true,
          enforceZeroDataRetention: true,
          configured: true,
          source: 'encrypted_database'
        }
      ];
      return (json(response, { ...connections[0], connections }), true);
    }
    if (path === '/v1/media/models')
      return (json(response, { approvalThresholdUsd: 1, modalities: [] }), true);
    if (path === '/v1/account/preferences' && method === 'GET')
      return (json(response, { preferences: state.preferences }), true);
    if (path === '/v1/approvals') return (json(response, []), true);
    if (path === '/v1/voice-sessions' || path === '/v1/audio/transcriptions/receipts')
      return (json(response, []), true);
    if (path === `/v1/workspaces/${workspace.id}/computation`)
      return (json(response, { sessions: [] }), true);
    if (path === `/v1/workspaces/${workspace.id}/previews`) return (json(response, []), true);
    if (path === `/v1/workspaces/${workspace.id}/snapshots`) return (json(response, []), true);
    if (path === '/v1/bootstrap') return (json(response, bootstrap()), true);
    if (path === '/v1/moves') return (json(response, state.moves), true);
    if (path === '/v1/record')
      return (
        json(
          response,
          state.record.filter(
            (entry) =>
              !url.searchParams.get('taskId') || entry.taskId === url.searchParams.get('taskId')
          )
        ),
        true
      );
    if (path === '/v1/legal') return (json(response, { registrationAvailable: false }), true);
    if (path === '/v1/instance/updates')
      return (
        json(response, {
          checkedAt: at(0),
          server: {
            status: state.serverUpdate,
            revision: state.serverUpdate === 'available' ? 'f00dfeed' : null
          },
          client: null
        }),
        true
      );
    if (path === '/v1/spend-limits')
      return (
        json(response, {
          dailyCapUsd: 10,
          monthlyCapUsd: 150,
          defaultTaskCapUsd: 5,
          warnAtPercent: 80,
          updatedAt: at(-24 * HOUR)
        }),
        true
      );
    if (path === `/v1/workspaces/${workspace.id}/processes`)
      return (json(response, processes()), true);
    if (path === `/v1/workspaces/${workspace.id}/heartbeat`)
      return (json(response, { ok: true }), true);
    if (path === `/v1/workspaces/${workspace.id}/artifacts`)
      return (json(response, artifacts), true);
    if (path === '/v1/account/preferences' && method === 'PUT') {
      Object.assign(state.preferences, await body(request));
      return (json(response, { preferences: state.preferences }), true);
    }
    if (path === '/v1/search') return (json(response, []), true);
    if (path === `/v1/workspaces/${workspace.id}/memories`) return (json(response, []), true);
    if (path === `/v1/workspaces/${workspace.id}/memory-library`)
      return (
        json(response, {
          items: [
            {
              id: randomUUID(),
              workspaceId: workspace.id,
              projectId: null,
              taskId: id(3),
              kind: 'fact',
              status: 'active',
              excerpt: 'Files taxes in the UK; the home office is claimed on actual costs.',
              observedAt: at(-30 * 24 * HOUR),
              validTo: null,
              lastVerified: at(-2 * HOUR)
            }
          ],
          nextCursor: null
        }),
        true
      );
    if (path === '/v1/account/memory-block')
      return (
        json(response, {
          text: 'I am a computational biologist in Berlin. Keep summaries short.',
          bytes: 64,
          limit: 2000,
          version: 3,
          updatedAt: at(-9 * 24 * HOUR)
        }),
        true
      );
    if (path === `/v1/workspaces/${workspace.id}/memory-review`)
      return (json(response, { procedures: [], disputed: [], proposals: [] }), true);
    if (path === `/v1/workspaces/${workspace.id}/skills`) return (json(response, []), true);
    if (path === `/v1/workspaces/${workspace.id}/brief`)
      return (json(response, { markdown: '', path: 'GARDEN.md' }), true);
    if (path === '/v1/notifications/settings')
      return (
        json(response, {
          kinds: {
            approvalRequired: true,
            taskFinished: true,
            spendPaused: true,
            agentMessage: true,
            takeoverNeeded: true
          },
          quietHoursStart: '22:00',
          quietHoursEnd: '07:00',
          quietHoursAllowApprovals: true,
          timeZone: 'Europe/Berlin'
        }),
        true
      );
    if (path === '/v1/notifications/config')
      return (json(response, { enabled: false, publicKey: null }), true);
    if (path === '/v1/notifications/destinations') return (json(response, []), true);
    if (path === '/v1/instance/diagnostics')
      return (
        json(response, {
          certificate: null,
          dynamicDns: null,
          backup: null,
          autoUpdate: null,
          backupTimer: null,
          build: { version: 'fixture' }
        }),
        true
      );
    if (path === '/v1/relay') return (json(response, { enabled: false, state: 'Disabled' }), true);
    if (path === '/v1/spend') {
      const window = (name, spentUsd, capUsd) => ({
        name,
        spentUsd,
        pendingUsd: 0,
        capUsd,
        warnAtUsd: capUsd === null ? null : capUsd * 0.8,
        projectedUsd: spentUsd,
        state: 'ok',
        startsAt: name === 'task' ? null : at(-12 * HOUR),
        endsAt: name === 'task' ? null : at(12 * HOUR)
      });
      return (
        json(response, {
          limits: {
            dailyCapUsd: 10,
            monthlyCapUsd: 150,
            defaultTaskCapUsd: 5,
            warnAtPercent: 80,
            updatedAt: at(-24 * HOUR)
          },
          windows: [window('daily', 0.73, 10), window('monthly', 41.2, 150)],
          byDay: [{ key: at(0).slice(0, 10), costUsd: 0.73, calls: 31 }],
          byModel: [{ key: 'fixture/lead', costUsd: 0.73, calls: 31 }],
          byTask: [{ key: id(1), costUsd: 0.6, calls: 22 }]
        }),
        true
      );
    }
    if (path === '/v1/usage')
      return (
        json(response, {
          period: { start: at(-12 * HOUR), end: at(12 * HOUR) },
          totals: { settled: 0.73 },
          storageBytes: workspace.storageBytes,
          storageLimitBytes: workspace.storageLimitBytes,
          storageThreshold: 'ok',
          history: []
        }),
        true
      );
    if (path === '/v1/drafts/device-key')
      return (
        json(response, {
          userId: '40000000-0000-4000-8000-000000000004',
          sessionId: 'fixture-session',
          key: Buffer.alloc(32, 7).toString('base64url')
        }),
        true
      );
    if (path === '/v1/drafts') {
      const scope = (draft) => `${draft.workspaceId}:${draft.taskId ?? ''}`;
      if (method === 'GET') {
        const key = `${url.searchParams.get('workspaceId')}:${url.searchParams.get('taskId') ?? ''}`;
        return (json(response, state.drafts.get(key) ?? null), true);
      }
      const input = await body(request);
      const current = state.drafts.get(scope(input));
      const revision = (current?.revision ?? 0) + 1;
      const { expectedRevision: _expected, ...draft } = input;
      state.drafts.set(scope(input), { ...draft, revision, updatedAt: at(0) });
      return (json(response, { revision, updatedAt: at(0) }), true);
    }
    if (path === '/v1/tasks' && method === 'POST') {
      const input = await body(request);
      const created = {
        ...tasks[0],
        id: randomUUID(),
        title: String(input.prompt ?? 'New goal').slice(0, 60),
        status: 'queued',
        activity: undefined,
        spentUsd: 0,
        maxSpendUsd: null,
        createdAt: at(0),
        updatedAt: at(0)
      };
      state.tasks.unshift(created);
      state.created.push(input);
      return (json(response, created), true);
    }
    if ((match = /^\/v1\/tasks\/([^/]+)\/deal$/.exec(path)) && method === 'POST') {
      const input = await body(request);
      const planted = findTask(match[1]);
      state.moves = state.moves.filter((move) => move.taskId !== match[1]);
      if (planted)
        Object.assign(planted, {
          status: 'running',
          activity: activity(3, 0, 'Reading starred mail', 'Reading starred mail')
        });
      return (json(response, { taskIds: [match[1]], echo: input }), true);
    }
    if ((match = /^\/v1\/tasks\/([^/]+)\/answer$/.exec(path)) && method === 'POST') {
      state.moves = state.moves.filter((move) => move.taskId !== match[1]);
      const answered = findTask(match[1]);
      if (answered) answered.status = 'running';
      return (json(response, answered), true);
    }
    if ((match = /^\/v1\/approvals\/([^/]+)\/(approve|deny)$/.exec(path)) && method === 'POST') {
      state.moves = state.moves.filter((move) => move.approvalId !== match[1]);
      return (json(response, { ok: true }), true);
    }
    if ((match = /^\/v1\/tasks\/([^/]+)$/.exec(path))) {
      const found = findTask(match[1]);
      if (!found)
        return (json(response, { code: 'task_not_found', message: 'Not found' }, 404), true);
      if (method === 'PATCH') Object.assign(found, await body(request));
      return (json(response, found), true);
    }
    return false;
  }
  return { state, handle, id };
}
