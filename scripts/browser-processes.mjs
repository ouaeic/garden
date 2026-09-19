import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export function processFixture(workspaceId, taskId) {
  const fixture = { rows: [], failRead: false, failStop: false, reads: 0, actions: [] };
  fixture.handle = async (route, pathname) => {
    if (/\/workflows\/[^/]+\/resume$/.test(pathname)) {
      const row = fixture.rows.find(
        (item) => item.workflow && pathname.includes('/' + item.workflow.workflowId + '/')
      );
      assert(row, 'Workflow resume belongs to a displayed run');
      assert(pathname.startsWith(`/v1/workspaces/${row.workspaceId}/workflows/`));
      const body = route.request().postDataJSON();
      assert.equal(body.attempt, row.workflow.attempt);
      fixture.actions.push({ path: pathname, body });
      row.status = 'running';
      row.workflow = {
        ...row.workflow,
        attempt: row.workflow.attempt + 1,
        state: 'running',
        canResume: false
      };
      row.job.state = 'running';
      await route.fulfill({ json: row.workflow });
      return true;
    }
    if (!/\/processes(?:\/[^/]+(?:\/resume)?)?$/.test(pathname)) return false;
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (pathname.endsWith('/processes')) {
      fixture.reads++;
      await json(
        fixture.failRead
          ? {
              error: {
                code: 'runner_unavailable',
                message: 'Process service is temporarily unavailable.'
              }
            }
          : {
              processes: fixture.rows,
              observedAt: new Date().toISOString(),
              refreshAfterMs: 120_000,
              resourcesAvailable: true,
              host: {
                logicalCpus: 16,
                memoryBytes: 32 * 1024 ** 3,
                commandMemoryLimitBytes: 22 * 1024 ** 3
              }
            },
        fixture.failRead ? 503 : 200
      );
      return true;
    }
    const body = route.request().postDataJSON();
    const row = fixture.rows.find((item) => pathname.includes('/' + item.sessionId));
    assert(row, 'A process action must refer to a listed managed process');
    assert(
      pathname.startsWith(`/v1/workspaces/${row.workspaceId}/processes/`),
      'A branch process must use its own execution root'
    );
    fixture.actions.push({ path: pathname, body });
    if (body.action === 'log') await json({ stdout: 'contig-42 complete\n', stderr: '' });
    else if (body.action === 'kill' && fixture.failStop)
      await json(
        { error: { code: 'stop_failed', message: 'The process could not be stopped.' } },
        500
      );
    else {
      row.status = pathname.endsWith('/resume') ? 'running' : 'stopped';
      if (row.job) row.job.state = row.status;
      if (row.workflow && row.status === 'stopped')
        row.workflow = { ...row.workflow, state: 'cancelled', canResume: true };
      await json(row);
    }
    return true;
  };
  fixture.seed = () => {
    const now = Date.now(),
      startedAt = new Date(now - (3 * 86400_000 + 5 * 3600_000)).toISOString();
    const row = {
      sessionId: 'job_genome',
      ownerTaskId: taskId,
      workspaceId: '10000000-0000-4000-8000-000000000088',
      status: 'running',
      lifetime: 'job',
      startedAt,
      ranForMs: 3 * 86400_000 + 5 * 3600_000,
      outputBytes: 8192,
      terminal: { columns: 120, rows: 36, streams: 'combined' },
      command: [
        'python3',
        'analyses/whole_genome_analysis.py',
        '--input',
        'patient cohort with a long descriptive filename '.repeat(6) + '.fastq.gz'
      ],
      job: {
        jobId: 'job_genome',
        name: 'Whole-genome analysis',
        state: 'running',
        createdAt: startedAt,
        startedAt,
        restarts: 0,
        checkpointResumable: true
      },
      workflow: {
        workflowId: '40000000-0000-4000-8000-000000000004',
        workspaceId: '10000000-0000-4000-8000-000000000088',
        ownerTaskId: taskId,
        name: 'Whole-genome analysis',
        engine: 'nextflow',
        engineVersion: '26.04.6',
        script: 'workspace/analysis/main.nf',
        directory: 'workspace/.garden/workflows/40000000-0000-4000-8000-000000000004',
        state: 'running',
        attempt: 2,
        canResume: false,
        sessionId: 'job_genome',
        createdAt: startedAt,
        startedAt,
        finishedAt: null,
        tracePath:
          'workspace/.garden/workflows/40000000-0000-4000-8000-000000000004/attempt-2/trace.tsv',
        reportPath:
          'workspace/.garden/workflows/40000000-0000-4000-8000-000000000004/attempt-2/report.html',
        timelinePath: 'timeline.html',
        progress: {
          recordedTasks: 34,
          completed: 2,
          cached: 31,
          failed: 1,
          aborted: 0,
          catchingUp: false,
          pendingRecord: false,
          observedAt: new Date(now).toISOString(),
          recent: [
            {
              taskId: '32',
              name: 'ALIGN (' + 'long-sample-identifier'.repeat(8) + ')',
              hash: 'fa/123abc',
              status: 'cached',
              exitCode: 0,
              durationMs: 130000,
              peakMemoryBytes: 1024 ** 3
            },
            {
              taskId: '34',
              name: 'REPORT',
              hash: 'ca/456def',
              status: 'failed',
              exitCode: 11,
              durationMs: 300,
              peakMemoryBytes: null
            }
          ]
        }
      },
      resources: {
        sampledAt: new Date(now - 30_000).toISOString(),
        intervalMs: 120_000,
        cpuPercent: 825,
        residentBytes: 18 * 1024 ** 3,
        processCount: 2,
        threadCount: 17,
        children: [
          {
            pid: 812,
            name: 'python3',
            state: 'S',
            residentBytes: 2 * 1024 ** 3,
            threads: 1,
            ranForMs: 3 * 86400_000
          },
          {
            pid: 813,
            name: 'aligner',
            state: 'R',
            residentBytes: 16 * 1024 ** 3,
            threads: 16,
            ranForMs: 2 * 86400_000
          }
        ]
      }
    };
    fixture.rows = [
      row,
      {
        ...row,
        sessionId: 'job_finished',
        workflow: undefined,
        status: 'completed',
        workspaceId,
        job: {
          ...row.job,
          jobId: 'job_finished',
          name: 'Completed quality control',
          state: 'completed'
        },
        resources: undefined
      },
      {
        ...row,
        sessionId: 'job_interrupted',
        workflow: undefined,
        status: 'interrupted',
        workspaceId,
        job: {
          ...row.job,
          jobId: 'job_interrupted',
          name: 'Checkpointed assembly',
          state: 'interrupted'
        },
        resources: undefined
      }
    ];
  };
  return fixture;
}

export async function checkProjectProcesses({ context, origin, taskId, fixture, report, errors }) {
  fixture.seed();
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: new Date() });
  try {
    await page.goto(`${origin}/?task=${taskId}`);
    const panel = page.getByRole('region', { name: 'Project processes', exact: true });
    const card = panel.getByRole('article', { name: 'Whole-genome analysis', exact: true });
    await card.waitFor();
    assert((await card.innerText()).includes('3d 5h'));
    assert((await card.innerText()).includes('825%'));
    assert((await card.innerText()).includes('18.0 GiB'));
    assert((await card.innerText()).includes('No time limit'));
    assert((await card.innerText()).includes('2 completed · 31 cached'));
    await card.getByText('Workflow stages & files', { exact: true }).click();
    assert((await card.innerText()).includes('failed · exit 11'));
    assert((await card.innerText()).includes('Peak RAM not captured'));
    assert.equal(
      await card.getByRole('progressbar').count(),
      0,
      'An unknown task graph must not imply a completion percentage'
    );

    assert.equal(await panel.getByRole('article').count(), 2);
    const interrupted = panel.getByRole('article', { name: 'Checkpointed assembly' });
    assert(await interrupted.isVisible(), 'Interrupted work stays visible without opening history');
    const before = fixture.reads;
    await page.clock.runFor(119_000);
    assert.equal(fixture.reads, before, 'No fast polling while a long job runs');
    const next = page.waitForResponse((response) =>
      response.url().endsWith(`/tasks/${taskId}/processes`)
    );
    await page.clock.runFor(2_000);
    await next;
    assert.equal(fixture.reads, before + 1, 'Refresh process status on the relaxed interval');
    await card.getByText('Command & details', { exact: true }).click();
    await card.getByText('Interactive terminal · 120 × 36.', { exact: false }).waitFor();
    assert((await card.innerText()).includes('aligner · R · 2d'));
    await card.getByRole('button', { name: 'Read output', exact: true }).click();
    const output = card.getByRole('textbox', { name: 'Output from Whole-genome analysis' });
    await output.waitFor();
    const outputRead = page.waitForResponse(
      (response) =>
        response.url().endsWith('/job_genome') && response.request().postDataJSON().action === 'log'
    );
    await card.getByRole('button', { name: 'Read output', exact: true }).click();
    await outputRead;
    assert.equal(
      (await output.inputValue()).trim(),
      'contig-42 complete',
      'Repeated log reads must not duplicate captured output'
    );
    for (const width of [1440, 768, 320]) {
      if (width === 768) await card.getByText('Command & details', { exact: true }).click();
      await page.setViewportSize({ width, height: 1000 });
      await panel.scrollIntoViewIfNeeded();
      assert(
        await card.evaluate((element) => element.scrollWidth <= element.clientWidth),
        `The process card must fit at ${width}px`
      );
      const bounds = await card.boundingBox();
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      const buttons = await card.locator('.process-actions button').evaluateAll((elements) =>
        elements.map((element) => {
          const r = element.getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
        })
      );
      assert(buttons.length > 0);
      for (let i = 0; i < buttons.length; i++)
        for (let j = i + 1; j < buttons.length; j++) {
          const a = buttons[i],
            b = buttons[j];
          assert(
            a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y,
            'Process actions must not overlap'
          );
        }
      await panel.screenshot({ path: resolve(report, `project-processes-${width}.png`) });
    }
    await panel.getByRole('button', { name: 'Show finished processes (1)', exact: true }).click();
    const finished = panel.getByRole('article', { name: 'Completed quality control' });
    assert.equal(await finished.getByRole('button', { name: 'Stop', exact: true }).count(), 0);
    await interrupted.getByRole('button', { name: 'Resume checkpoint', exact: true }).click();
    assert(fixture.actions.some((action) => action.path.endsWith('/job_interrupted/resume')));
    fixture.failRead = true;
    await panel.getByRole('button', { name: 'Refresh processes' }).click();
    await page.clock.runFor(5_000);
    await panel
      .getByText('Showing the last received status; the computer may have changed.')
      .waitFor();
    assert(await card.isVisible(), 'A failed refresh retains the known process list');
    fixture.failRead = false;
    await panel.getByRole('button', { name: 'Try again', exact: true }).click();
    await panel
      .getByText('Showing the last received status; the computer may have changed.')
      .waitFor({ state: 'detached' });
    fixture.failStop = true;
    await card.getByRole('button', { name: 'Stop', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Stop Whole-genome analysis?' });
    await dialog.getByRole('button', { name: 'Stop process', exact: true }).click();
    await dialog.getByText('The process could not be stopped.', { exact: true }).waitFor();
    assert.equal(fixture.rows[0].status, 'running');
    await dialog.getByRole('button', { name: 'Keep running', exact: true }).click();
    fixture.failStop = false;
    await card.getByRole('button', { name: 'Stop', exact: true }).click();
    await dialog.getByRole('button', { name: 'Stop process', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(fixture.rows[0].status, 'stopped');
    assert.equal(await card.getByRole('button', { name: 'Stop', exact: true }).count(), 0);
    await card.getByRole('button', { name: 'Resume workflow', exact: true }).click();
    assert(
      fixture.actions.some(
        (action) => action.path.includes('/workflows/') && action.body.attempt === 2
      )
    );
    assert.equal(fixture.rows[0].workflow.attempt, 3);
    await card
      .getByRole('button', { name: 'Resume workflow', exact: true })
      .waitFor({ state: 'detached' });

    const completed = fixture.rows.find((row) => row.sessionId === 'job_finished');
    assert(completed);
    fixture.rows = Array.from({ length: 45 }, (_, i) => ({
      ...completed,
      sessionId: `history-${i}`,
      startedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      status: i === 44 ? 'failed' : 'completed',
      command: ['python3', `analysis-${i}.py`],
      job: {
        ...completed.job,
        jobId: `history-${i}`,
        name: 'Command',
        state: i === 44 ? 'failed' : 'completed'
      }
    }));
    await page.reload();
    const history = panel.getByRole('button', {
      name: 'Show finished processes (45 · 1 failed)',
      exact: true
    });
    await history.waitFor();
    assert.equal(
      await panel.getByRole('article').count(),
      0,
      'A finished project starts with compact history'
    );
    await history.click();
    assert.equal(await panel.getByRole('article').count(), 10);
    assert.equal(
      await panel.getByRole('article').first().getAttribute('aria-label'),
      'python3 analysis-44.py'
    );
    for (const remaining of [35, 25, 15, 5])
      await panel
        .getByRole('button', {
          name: `Show earlier processes (${remaining} remaining)`,
          exact: true
        })
        .click();
    assert.equal(
      await panel.getByRole('article').count(),
      45,
      'Every finished process remains accessible'
    );
    await panel
      .getByRole('article', { name: 'python3 analysis-0.py', exact: true })
      .getByRole('button', { name: 'Read output', exact: true })
      .click();
    await panel.getByRole('textbox', { name: 'Output from python3 analysis-0.py' }).waitFor();
    await panel.getByRole('button', { name: 'Hide finished processes', exact: true }).click();
    assert.equal(await panel.getByRole('article').count(), 0);
    await history.click();
    assert.equal(
      await panel.getByRole('article').count(),
      10,
      'Reopening history starts from the latest page'
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await panel.screenshot({ path: resolve(report, 'project-process-history.png') });
    await panel.getByRole('button', { name: 'Hide finished processes', exact: true }).click();
    await page.setViewportSize({ width: 360, height: 900 });
    await panel.scrollIntoViewIfNeeded();
    await panel.screenshot({ path: resolve(report, 'project-process-history-collapsed.png') });

    console.log(
      'Project process browser checks passed: multi-day clocks, child resources, relaxed polling, responsive controls, checkpoint resume, log replacement, stale/error status and exact-root stop.'
    );
  } finally {
    await page.close();
    fixture.rows = [];
    fixture.failRead = false;
    fixture.failStop = false;
  }
}
