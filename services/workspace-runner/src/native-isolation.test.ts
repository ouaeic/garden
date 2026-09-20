import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ensureWorkspace } from './files.js';
import { ExecRequest, prepareInvocation, type InvocationPolicy } from './execution.js';
import {
  agentSandbox,
  probeNativeIsolation,
  sandboxedInvocation,
  sandboxSpecDirectory
} from './sandbox.js';
import { discardMissionInvocation } from './mission-processes.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'garden-isolation-')));
  roots.push(parent);
  const root = path.join(parent, randomUUID());
  await ensureWorkspace(root);
  const specDirectory = sandboxSpecDirectory(parent);
  await mkdir(specDirectory, { recursive: true });
  const sandbox = {
    ...agentSandbox('/fixture/helper', true, specDirectory),
    processIsolation: true,
    networkIsolation: true
  };
  const policy: InvocationPolicy = {
    isolateNetwork: false,
    sandbox,
    systemPackages: { mode: 'approved', allowed: true, helper: '/fixture/packages' }
  };
  const mark = () =>
    writeFile(
      path.join(root, '.athanor/coding-parent.json'),
      JSON.stringify({ parent: randomUUID(), id: randomUUID() })
    );
  return { parent, root, sandbox, policy, mark };
}
const request = () => ExecRequest.parse({ executable: '/bin/true' });

it('preserves ordinary parent networking while forcing a curated network-disabled invocation under global false', async () => {
  const { root, policy } = await fixture();
  const ordinary = await prepareInvocation(root, request(), policy);
  expect(ordinary.args.slice(2, 5)).toEqual(['run', 'network', 'confine']);
  expect(ordinary.processTreeLease).toBeUndefined();
  const curated = await prepareInvocation(
    root,
    { ...request(), requireNetworkIsolation: true },
    policy
  );
  expect(curated.args.slice(2, 5)).toEqual(['run', 'isolated', 'confine']);
  expect(curated.processTreeLease).toBeUndefined();
  const debug = await prepareInvocation(
    root,
    { ...request(), requireNetworkIsolation: true, superviseProcessTree: true },
    policy
  );
  try {
    expect(debug.args.slice(2, 5)).toEqual(['run', 'isolated', 'mission']);
    expect(debug.processTreeLease).toMatch(/\.lease$/);
  } finally {
    await discardMissionInvocation(debug);
  }
});

it('forces isolation from the private mission marker through both invocation layers under global false', async () => {
  const { root, sandbox, policy, mark } = await fixture();
  await mark();
  const throughExecution = await prepareInvocation(root, request(), policy);
  try {
    expect(throughExecution.args.slice(2, 5)).toEqual(['run', 'isolated', 'mission']);
    expect(throughExecution.processTreeLease).toMatch(/\.lease$/);
  } finally {
    await discardMissionInvocation(throughExecution);
  }
  const throughSandbox = await sandboxedInvocation(
    { executable: '/bin/true', args: [] },
    {},
    sandbox,
    false,
    root,
    path.join(root, 'workspace')
  );
  try {
    expect(throughSandbox.args.slice(2, 5)).toEqual(['run', 'isolated', 'mission']);
    expect(throughSandbox.processTreeLease).toMatch(/\.lease$/);
  } finally {
    await discardMissionInvocation(throughSandbox);
  }
});

it.each(['mission', 'curated'] as const)(
  'refuses %s network escalation and approved package-helper escapes before creating a launch',
  async (kind) => {
    const { root, sandbox, policy, mark } = await fixture();
    if (kind === 'mission') await mark();
    const invocation = {
      ...request(),
      ...(kind === 'curated' ? { requireNetworkIsolation: true } : {})
    };
    await expect(prepareInvocation(root, { ...invocation, network: true }, policy)).rejects.toThrow(
      'cannot enable network'
    );
    await expect(
      prepareInvocation(
        root,
        { ...invocation, executable: 'apt-get', args: ['install', 'curl'] },
        policy
      )
    ).rejects.toThrow('system-package operations');
    await expect(
      prepareInvocation(
        root,
        { ...invocation, executable: '/fixture/packages', args: ['install', 'curl'] },
        policy
      )
    ).rejects.toThrow('system-package operations');
    expect(await readdir(sandbox.specDirectory)).toEqual([]);
  }
);

it.each([false, true])(
  'fails closed without measured support even when global isolation is %s',
  async (isolateNetwork) => {
    const { root, policy, sandbox, mark } = await fixture();
    const unavailable = {
      ...policy,
      isolateNetwork,
      sandbox: { ...sandbox, networkIsolation: false }
    };
    await expect(
      prepareInvocation(root, { ...request(), requireNetworkIsolation: true }, unavailable)
    ).rejects.toThrow('measured filesystem and network');
    await mark();
    await expect(prepareInvocation(root, request(), unavailable)).rejects.toThrow(
      'measured filesystem and network'
    );
    await expect(
      sandboxedInvocation(
        { executable: '/bin/true', args: [] },
        {},
        unavailable.sandbox,
        false,
        root,
        path.join(root, 'workspace')
      )
    ).rejects.toThrow('measured native network');
    expect(await readdir(sandbox.specDirectory)).toEqual([]);
  }
);

it('does not expose trusted lifecycle or network overrides in command requests', () => {
  const parsed = ExecRequest.parse({
    executable: '/bin/true',
    requireNetworkIsolation: true,
    superviseProcessTree: true
  });
  expect(parsed.executable).toBe('/bin/true');
  expect(parsed).not.toHaveProperty('requireNetworkIsolation');
  expect(parsed).not.toHaveProperty('superviseProcessTree');
  expect(
    ExecRequest.parse({ executable: '/bin/true', retainProcessTree: true })
  ).not.toHaveProperty('retainProcessTree');
});

it.each([
  {
    output: 'process-isolation=yes\nnetwork-isolation=yes\nretained-process-trees=yes\n',
    exit: 0,
    process: true,
    network: true,
    retained: true
  },
  {
    output: 'process-isolation=no\nnetwork-isolation=yes\nretained-process-trees=yes\n',
    exit: 0,
    process: false,
    network: true,
    retained: false
  },
  {
    output: 'process-isolation=yes\nnetwork-isolation=yes\n',
    exit: 0,
    process: true,
    network: true
  },
  {
    output: 'process-isolation=yes\nnetwork-isolation=no\n',
    exit: 0,
    process: true,
    network: false
  },
  {
    output: 'process-isolation=no\nnetwork-isolation=yes\n',
    exit: 0,
    process: false,
    network: true
  },
  {
    output: 'prefix-process-isolation=yes\nnetwork-isolation=yes-extra\n',
    exit: 0,
    process: false,
    network: false
  },
  {
    output: 'process-isolation=yes\nnetwork-isolation=yes\n',
    exit: 1,
    process: false,
    network: false
  }
])('measures exact successful helper capabilities: $output exit $exit', async (value) => {
  const { parent, sandbox } = await fixture();
  const helper = path.join(parent, 'probe');
  await writeFile(
    helper,
    `#!/bin/sh\n[ "$1" = '-n' ] && [ "$2" = '/fixture/helper' ] && [ "$3" = 'check' ] || exit 3\ncat <<'RESULT'\n${value.output}RESULT\nexit ${value.exit}\n`
  );
  await chmod(helper, 0o755);
  expect(await probeNativeIsolation({ ...sandbox, elevate: helper })).toEqual({
    processIsolation: value.process,
    networkIsolation: value.network,
    retainedProcessTrees: 'retained' in value && value.retained
  });
});
