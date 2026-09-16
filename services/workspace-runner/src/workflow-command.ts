import path from 'node:path';

export const workflowRunName = (id: string, attempt: number): string =>
  `garden_${id.replaceAll('-', '')}_${attempt}`;

/** Stable local launch directory retains the engine cache and work files across attempts. */
export const workflowCommand = (input: {
  workflowId: string;
  attempt: number;
  script: string;
  configs: readonly string[];
  network: boolean;
  resumeSession?: string;
}) => {
  const directory = `workspace/.garden/workflows/${input.workflowId}`;
  const attempt = `attempt-${input.attempt}`;
  return {
    directory,
    tracePath: `${directory}/${attempt}/trace.tsv`,
    reportPath: `${directory}/${attempt}/report.html`,
    timelinePath: `${directory}/${attempt}/timeline.html`,
    launch: {
      executable: '/usr/bin/env',
      args: [
        'NXF_DISABLE_CHECK_LATEST=true',
        '/usr/local/bin/nextflow',
        '-log',
        `${attempt}/engine.log`,
        '-C',
        [
          ...input.configs.map((config) => path.posix.relative(directory, config)),
          `${attempt}/garden.config`
        ].join(','),
        'run',
        ...(!input.network ? ['-offline'] : []),
        path.posix.relative(directory, input.script),
        '-name',
        workflowRunName(input.workflowId, input.attempt),
        '-params-file',
        `${attempt}/parameters.json`,
        '-work-dir',
        'work',
        '-ansi-log',
        'false',
        '-with-trace',
        `${attempt}/trace.tsv`,
        '-with-report',
        `${attempt}/report.html`,
        '-with-timeline',
        `${attempt}/timeline.html`,
        ...(input.resumeSession ? ['-resume', input.resumeSession] : [])
      ],
      cwd: directory,
      network: input.network
    }
  };
};

export const WORKFLOW_CONFIG =
  "process.executor = 'local'\nreport.overwrite = true\ntimeline.overwrite = true\ntrace.raw = true\ntrace.fields = 'task_id,hash,name,status,exit,duration,peak_rss'\n";
