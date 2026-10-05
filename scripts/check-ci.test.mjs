import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const verify = readFileSync(join(root, '.github/workflows/verify.yml'), 'utf8');
const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    ...options
  });
}

function output(result) {
  return [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n');
}

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'garden-ci-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function workflowStep(source, name) {
  const marker = `      - name: ${name}\n`;
  const steps = source.split(marker);
  assert.equal(steps.length, 2, `expected one workflow step: ${name}`);
  const body = steps[1].split(/\n {0,6}\S/, 1)[0];
  const run = body.match(/^        run: \|\n((?:          .*(?:\n|$)|\n)+)/m);
  assert.ok(run?.[1], `expected a literal shell block for ${name}`);
  return run[1].replace(/^          /gm, '');
}

test('release check distinguishes branch refs from explicit and triggered release tags', () => {
  const environment = { ...process.env };
  for (const key of ['GITHUB_REF_TYPE', 'GITHUB_REF_NAME', 'GITHUB_OUTPUT', 'GARDEN_RELEASE_TAG']) {
    delete environment[key];
  }
  const cases = [
    [{}, true],
    [{ GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' }, true],
    [{ GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: '123/merge' }, true],
    [{ GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'v999.0.0' }, true],
    [{ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: `v${version}` }, true],
    [{ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v999.0.0' }, false],
    [{ GITHUB_REF_TYPE: 'tag' }, false],
    [
      { GARDEN_RELEASE_TAG: `v${version}`, GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' },
      true
    ],
    [{ GARDEN_RELEASE_TAG: 'v999.0.0', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' }, false],
    [{ GARDEN_RELEASE_TAG: '' }, false]
  ];
  assert.ok(cases.length > 0);
  for (const [overrides, accepted] of cases) {
    const result = run(process.execPath, ['scripts/check-release.mjs'], {
      env: { ...environment, ...overrides }
    });
    assert.equal(result.status === 0, accepted, `${JSON.stringify(overrides)}: ${output(result)}`);
    if (!accepted) assert.match(output(result), /Release tag .* does not match/);
  }
});

test('the runner unit shell accepts its real unit and rejects every deliberate invariant violation', (t) => {
  const directory = temporary(t);
  mkdirSync(join(directory, 'infra/native'), { recursive: true });
  const path = join(directory, 'infra/native/garden-runner.service');
  const original = readFileSync(join(root, 'infra/native/garden-runner.service'), 'utf8');
  assert.ok(original.length > 0);
  const shell = workflowStep(verify, "The runner unit's deliberate omissions are still omissions");
  const cases = [
    [original, null],
    ...['NoNewPrivileges', 'RestrictNamespaces', 'ProtectSystem'].map((key) => [
      `${original}\n${key}=true\n`,
      `sets ${key}`
    ]),
    ...[
      'SystemCallArchitectures',
      'LockPersonality',
      'ProtectHostname',
      'ProtectClock',
      'RestrictRealtime',
      'RestrictSUIDSGID',
      'ProtectProc',
      'ProtectHome'
    ].map((key) => [original.replace(new RegExp(`^${key}=.*\\n`, 'm'), ''), `lost ${key}`]),
    [
      original.replaceAll('What this unit deliberately does NOT carry', 'removed'),
      'lost the block'
    ],
    [
      original.replace(/^CapabilityBoundingSet=.*$/m, 'CapabilityBoundingSet=CAP_CHOWN'),
      'by exclusion'
    ],
    [original.replace(/^ProtectHome=tmpfs$/m, 'ProtectHome=true'), 'must hide /home with tmpfs'],
    [original.replace(/^BindPaths=.*$/m, ''), 'without binding the workspace root'],
    [`${original}\nReadWritePaths=/home/garden\n`, 'reopens /home']
  ];
  assert.ok(cases.length > 0);
  for (const [fixture, diagnostic] of cases) {
    if (diagnostic) assert.notEqual(fixture, original, diagnostic);
    writeFileSync(path, fixture);
    const result = run('/bin/bash', ['-e', '-c', shell], { cwd: directory });
    assert.equal(result.status, diagnostic ? 1 : 0, `${diagnostic}: ${output(result)}`);
    if (diagnostic) assert.ok(output(result).includes(diagnostic), output(result));
  }
});

test('Android provisioning uses the installed SDK executable with the exact SDK root and package pins', (t) => {
  const directory = temporary(t);
  const sdk = join(directory, 'installed SDK');
  const sdkBin = join(sdk, 'cmdline-tools/latest/bin');
  mkdirSync(sdkBin, { recursive: true });
  const receipt = join(directory, 'sdk-args');
  const manager = join(sdkBin, 'sdkmanager');
  for (const source of [verify, release]) {
    writeFileSync(manager, '#!/bin/sh\nprintf "%s\\n" "$@" > "$SDK_RECEIPT"\n', { mode: 0o700 });
    const shell = workflowStep(source, 'Install pinned Android SDK components');
    const env = { ...process.env, ANDROID_HOME: sdk, SDK_RECEIPT: receipt, PATH: '/usr/bin:/bin' };
    const result = run('/bin/bash', ['-e', '-c', shell], { env });
    assert.equal(result.status, 0, output(result));
    assert.ok(existsSync(receipt), 'the guarded script must reach the manager check');
    assert.deepEqual(readFileSync(receipt, 'utf8').trimEnd().split('\n'), [
      `--sdk_root=${sdk}`,
      'platforms;android-36',
      'build-tools;36.0.0',
      'ndk;29.0.14206865'
    ]);
    rmSync(manager);
    assert.notEqual(run('/bin/bash', ['-e', '-c', shell], { env }).status, 0);
    delete env.ANDROID_HOME;
    assert.notEqual(run('/bin/bash', ['-e', '-c', shell], { env }).status, 0);
  }
});

test('certificate confinement refusal reaches the remaining checks under dash and still rejects writable system paths', (t) => {
  const directory = temporary(t);
  const step = workflowStep(verify, 'Drill the certificate renewal under ProtectSystem=strict');
  const matches = [...step.matchAll(/<<'CERTIFICATE'\n([\s\S]*?)\nCERTIFICATE\n/g)];
  assert.equal(matches.length, 1, 'expected the actual certificate drill script');
  let script = matches[0][1];
  for (const [index, original] of [
    '/etc/garden',
    '/etc/nginx/snippets',
    '/var/lib/garden',
    '/usr/local/lib/garden'
  ].entries()) {
    assert.equal(script.split(original).length, 2, `expected one writable tree: ${original}`);
    const writable = join(directory, `writable-${index}`);
    mkdirSync(writable);
    script = script.replace(original, `"${writable}"`);
  }
  assert.equal(script.split('/etc/shadow.drill').length, 2);
  script = script.replace('/etc/shadow.drill', '"$DENIED_PATH"');
  const receipt = join(directory, 'systemctl-receipt');
  const manager = join(directory, 'systemctl');
  writeFileSync(
    manager,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$SYSTEMCTL_RECEIPT"\nprintf "%s" "$SYSTEMCTL_REPLY"\n',
    { mode: 0o700 }
  );
  // nginx stands in for the test every renewal ends on; NGINX_STATUS decides whether it can run.
  writeFileSync(join(directory, 'nginx'), '#!/bin/sh\nexit "${NGINX_STATUS:-0}"\n', {
    mode: 0o700
  });
  const denied = join(directory, 'denied-directory');
  mkdirSync(denied);
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    SYSTEMCTL_RECEIPT: receipt,
    SYSTEMCTL_REPLY: '256',
    DENIED_PATH: denied
  };
  const positive = run('dash', ['-c', script], { env });
  assert.equal(positive.status, 0, output(positive));
  assert.match(positive.stdout, /the reload path is open/);
  assert.ok(existsSync(receipt), 'the guarded script must reach the manager check');
  assert.deepEqual(readFileSync(receipt, 'utf8').trimEnd().split('\n'), [
    'show',
    '--property=Version',
    '--value'
  ]);

  rmSync(receipt);
  const writable = run('dash', ['-c', script], {
    env: { ...env, DENIED_PATH: join(directory, 'would-be-system-file') }
  });
  assert.equal(writable.status, 1, output(writable));
  assert.match(writable.stderr, /strict is not in force/);
  assert.throws(() => readFileSync(receipt), { code: 'ENOENT' });

  const disconnected = run('dash', ['-c', script], { env: { ...env, SYSTEMCTL_REPLY: '' } });
  assert.equal(disconnected.status, 1, output(disconnected));
  assert.match(disconnected.stderr, /systemctl can no longer reach the manager/);

  const untestable = run('dash', ['-c', script], { env: { ...env, NGINX_STATUS: '1' } });
  assert.equal(untestable.status, 1, output(untestable));
  assert.match(untestable.stderr, /nginx cannot test its configuration from here/);
});

test('pnpm native build commands deliver the exact bundle, simulator and APK flags to Tauri', (t) => {
  const directory = temporary(t);
  const receipt = join(directory, 'native-args.json');
  const hook = join(directory, 'record-native-spawn.mjs');
  writeFileSync(
    hook,
    `
import childProcess from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
if (/(?:^|[/\\\\])build-(?:native|mobile)\\.mjs$/.test(process.argv[1] ?? '')) {
  const execFileSync = childProcess.execFileSync;
  childProcess.execFileSync = (command, args, ...rest) => {
    if (command === '/usr/bin/xcrun' && JSON.stringify(args) === '["--find","swift"]') return process.execPath + '\\n';
    return execFileSync(command, args, ...rest);
  };
  childProcess.spawn = (command, args, options) => {
    const swiftWrapper = args[1] === 'ios' ? join(options.env.PATH.split(delimiter)[0], 'swift') : null;
    writeFileSync(process.env.NATIVE_RECEIPT, JSON.stringify({ command, args, swiftWrapper, swiftPrepared: swiftWrapper ? existsSync(swiftWrapper) : false }));
    const child = new EventEmitter();
    process.nextTick(() => child.emit('exit', 79, null));
    return child;
  };
  syncBuiltinESMExports();
}
`
  );
  const cases = [
    [verify, 'native:build', ['build', '--bundles', 'app']],
    [verify, 'ios:build', ['ios', 'build', '--target', 'aarch64-sim', '--no-sign', '--ci']],
    [verify, 'android:build', ['android', 'build', '--apk', '--target', 'aarch64', '--ci']],
    [release, 'android:build', ['android', 'build', '--apk', '--aab', '--ci']],
    [
      release,
      'ios:build',
      ['ios', 'build', '--target', 'aarch64', '--ci', '--export-method', 'app-store-connect']
    ]
  ];
  assert.ok(cases.length > 0);
  for (const [source, script, expected] of cases) {
    const commands = [
      ...source
        .replace(
          /run: >-\n((?:          [^\n]*(?:\n|$))+)/g,
          (_, body) =>
            `run: ${body
              .trim()
              .split('\n')
              .map((line) => line.trim())
              .join(' ')}\n`
        )
        .matchAll(
          new RegExp(`^\\s*(?:- )?run: (pnpm --filter @garden/desktop ${script}[^\\n]*)$`, 'gm')
        )
    ];
    assert.equal(commands.length, 1, `expected one CI ${script} command`);
    rmSync(receipt, { force: true });
    const result = run(
      '/bin/bash',
      ['-e', '-c', commands[0][1].replace(/^pnpm /, 'pnpm --config.verify-deps-before-run=false ')],
      {
        env: {
          ...process.env,
          CI: 'true',
          npm_config_verify_deps_before_run: 'false',
          NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`,
          NATIVE_RECEIPT: receipt
        }
      }
    );
    assert.notEqual(result.status, 0, 'the recorder must stop before an actual native build');
    assert.ok(readFileSync(receipt, 'utf8'), output(result));
    const recorded = JSON.parse(readFileSync(receipt, 'utf8'));
    if (recorded.swiftWrapper)
      t.after(() => rmSync(dirname(recorded.swiftWrapper), { recursive: true, force: true }));
    assert.equal(resolve(recorded.command), resolve(process.execPath));
    assert.match(recorded.args[0], /@tauri-apps[/\\]cli[/\\]tauri\.js$/);
    assert.deepEqual(recorded.args.slice(1), expected, output(result));
    if (script === 'ios:build') {
      assert.equal(
        recorded.swiftPrepared,
        true,
        'The iOS build must receive native compiler path maps'
      );
      assert.equal(
        existsSync(recorded.swiftWrapper),
        false,
        'The temporary compiler must be removed after a failed build'
      );
    } else assert.equal(recorded.swiftWrapper, null);
  }
});
