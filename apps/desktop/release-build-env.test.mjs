import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  access,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { checkNativeBinaries } from './check-native-binary.mjs';
import { releasePathMappings, withReleaseRustFlags } from './release-build-env.mjs';
import { withReleaseSwiftTools } from './release-swift-env.mjs';

test('release Rust flags remap the user, Cargo, and workspace paths', () => {
  const environment = {
    HOME: '/Users/builder',
    CARGO_HOME: '/Users/builder/custom-cargo',
    GITHUB_WORKSPACE: '/Users/builder/work/garden'
  };
  const mappings = releasePathMappings(environment);
  assert.deepEqual(mappings, [
    { source: '/Users/builder', destination: '/build-user' },
    { source: '/Users/builder/custom-cargo', destination: '/cargo' },
    { source: '/Users/builder/work/garden', destination: '/workspace' }
  ]);
  const configured = withReleaseRustFlags(environment);
  assert.match(configured.CARGO_ENCODED_RUSTFLAGS, /--remap-path-prefix/);
  assert.match(configured.CARGO_ENCODED_RUSTFLAGS, /\/Users\/builder=\/build-user/);
  assert.equal(environment.CARGO_ENCODED_RUSTFLAGS, undefined);
});

test('release Rust flags never silently discard caller flags', () => {
  assert.throws(
    () => withReleaseRustFlags({ HOME: '/home/builder', RUSTFLAGS: '-C target-cpu=native' }),
    /Move those arguments/
  );
  const configured = withReleaseRustFlags({
    HOME: '/home/builder',
    CARGO_ENCODED_RUSTFLAGS: '-C\u001ftarget-cpu=native'
  });
  assert.ok(configured.CARGO_ENCODED_RUSTFLAGS.startsWith('-C\u001ftarget-cpu=native\u001f'));
});

test('Windows C dependencies receive the same path maps without dropping caller flags', () => {
  const environment = { HOME: '/Users/build owner', CFLAGS: '/O2', CXXFLAGS: '/W3' };
  const configured = withReleaseRustFlags(environment, undefined, 'win32');
  assert.equal(configured.CC, 'clang-cl');
  assert.equal(configured.AWS_LC_SYS_CMAKE_BUILDER, '0');
  assert.ok(configured.CFLAGS.startsWith('/O2 '));
  assert.ok(configured.CXXFLAGS.startsWith('/W3 '));
  assert.ok(
    configured.CFLAGS.includes('"/clang:-ffile-prefix-map=/Users/build owner=/build-user"')
  );
  assert.equal(environment.CFLAGS, '/O2');
  assert.equal(withReleaseRustFlags(environment, undefined, 'darwin').CC, undefined);
});

test('Android release flags preserve caller flags and align LOAD and RELRO without affecting Apple builds', () => {
  const environment = { HOME: '/home/builder', CARGO_ENCODED_RUSTFLAGS: '-C\u001flto=thin' };
  const args = withReleaseRustFlags(environment, 'android').CARGO_ENCODED_RUSTFLAGS.split('\u001f');
  assert.deepEqual(args.slice(0, 2), ['-C', 'lto=thin']);
  assert.ok(args.includes('--remap-path-prefix'));
  assert.deepEqual(args.slice(-4), [
    '-C',
    'link-arg=-Wl,-z,max-page-size=16384',
    '-C',
    'link-arg=-Wl,-z,common-page-size=16384'
  ]);
  for (const platform of ['ios', undefined]) {
    assert.ok(
      !withReleaseRustFlags(environment, platform).CARGO_ENCODED_RUSTFLAGS.includes('page-size')
    );
  }
  assert.equal(environment.CARGO_ENCODED_RUSTFLAGS, '-C\u001flto=thin');
});

test(
  'C dependency source paths pass the artifact audit only with compiler maps',
  {
    skip: process.platform === 'win32'
  },
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'garden-c-source maps-')));
    const release = join(directory, 'release');
    const source = join(directory, 'source.c');
    const executable = join(release, 'garden-desktop');
    const environment = { ...process.env, GITHUB_WORKSPACE: directory, CFLAGS: '-O2' };
    try {
      await mkdir(release);
      await writeFile(source, '#include <stdio.h>\nint main(void) { puts(__FILE__); return 0; }\n');
      execFileSync('cc', [source, '-o', executable]);
      await assert.rejects(
        checkNativeBinaries(directory, environment, 'desktop'),
        /build-machine path/
      );
      const configured = withReleaseRustFlags(environment);
      const flags = configured.CFLAGS.match(/"(?:\\.|[^"\\])*"|\S+/g).map((value) =>
        value.startsWith('"') ? JSON.parse(value) : value
      );
      execFileSync('cc', [...flags, source, '-o', executable]);
      await checkNativeBinaries(directory, environment, 'desktop');
      assert.equal(execFileSync(executable, { encoding: 'utf8' }).trim(), '/workspace/source.c');
      const object = join(directory, 'source.o');
      const archive = join(release, 'libgarden_desktop_lib.a');
      const debug = process.platform === 'darwin' ? '-gfull' : '-g3';
      const archiveBuild = (compilerFlags, env = process.env) => {
        execFileSync('cc', [debug, ...compilerFlags, '-c', source, '-o', object], { env });
        execFileSync('ar', ['rcs', archive, object]);
      };
      archiveBuild([]);
      await assert.rejects(
        checkNativeBinaries(directory, environment, 'ios'),
        /build-machine path/
      );
      archiveBuild(flags);
      await checkNativeBinaries(directory, environment, 'ios');
      if (process.platform === 'darwin') {
        const prepared = await withReleaseSwiftTools({ ...environment, CFLAGS: '', CXXFLAGS: '' });
        try {
          const sdk = execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], {
            encoding: 'utf8'
          }).trim();
          archiveBuild(['-isysroot', sdk], prepared.environment);
          await checkNativeBinaries(directory, environment, 'ios');
        } finally {
          await prepared.dispose();
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test('native artifact audit rejects a build home and accepts remapped output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'garden-native-audit-'));
  const release = join(directory, 'release');
  const executable = join(release, 'garden-desktop');
  const environment = {
    HOME: '/Users/builder',
    CARGO_HOME: '/Users/builder/.cargo',
    GITHUB_WORKSPACE: '/Users/builder/work/garden'
  };
  try {
    await mkdir(release);
    await writeFile(executable, 'safe /cargo/registry dependency path');
    await checkNativeBinaries(directory, environment, 'desktop');
    await writeFile(executable, 'leaked /Users/builder/.cargo/registry source path');
    await assert.rejects(
      () => checkNativeBinaries(directory, environment, 'desktop'),
      /build-machine path/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function archiveEntry(name, content) {
  const header = `${name.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'644'.padEnd(8)}${String(content.length).padEnd(10)}\x60\n`;
  assert.equal(Buffer.byteLength(header), 60);
  return Buffer.concat([
    Buffer.from(header),
    content,
    ...(content.length % 2 ? [Buffer.from('\n')] : [])
  ]);
}

test('native artifact audit attributes leaked paths to BSD and GNU archive objects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'garden-native-members-'));
  const artifact = join(directory, 'release', 'libgarden_desktop_lib.a');
  const name = 'garden-native-compiler.swift.o';
  const payload = Buffer.from(
    '\0DO_NOT_PRINT_OTHER_STRINGS\0DW_AT_comp_dir=/Users/builder/work/project OWNER_PRIVATE_DATA\0'
  );
  const nameBytes = Buffer.from(name);
  const variants = [
    {
      expectedName: name,
      members: [archiveEntry(`#1/${nameBytes.length}`, Buffer.concat([nameBytes, payload]))]
    },
    {
      expectedName: name,
      members: [archiveEntry('//', Buffer.from(`${name}/\n`)), archiveEntry('/0', payload)]
    },
    { expectedName: 'native.o', members: [archiveEntry('native.o/', payload)] }
  ];
  try {
    await mkdir(join(directory, 'release'));
    for (const { expectedName, members } of variants) {
      const archive = Buffer.concat([Buffer.from('!<arch>\n'), ...members]);
      await writeFile(artifact, archive);
      await assert.rejects(
        checkNativeBinaries(directory, { HOME: '/Users/builder' }, 'ios'),
        (error) => {
          assert.match(error.message, /build-machine path/);
          const details = JSON.parse(error.message.split('\nPath diagnostics: ')[1]);
          assert.equal(details.length, 1);
          assert.equal(details[0].archiveMember.name, expectedName);
          assert.equal(details[0].archiveMember.location, 'content');
          assert.equal(details[0].archiveMember.memberOffset, payload.indexOf('/Users/builder'));
          assert.equal(details[0].byteOffset, archive.indexOf('/Users/builder'));
          assert.equal(details[0].pathToken, '/Users/builder/work/project');
          assert.ok(!error.message.includes('DO_NOT_PRINT_OTHER_STRINGS'));
          assert.ok(!error.message.includes('OWNER_PRIVATE_DATA'));
          assert.ok(!error.message.includes('DW_AT_comp_dir'));
          return true;
        }
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('native artifact audit bounds printable diagnostics and still rejects malformed archives', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'garden-native-diagnostic-bound-'));
  const artifact = join(directory, 'release', 'libgarden_desktop_lib.a');
  try {
    await mkdir(join(directory, 'release'));
    const fragment = '/Users/builder/work/' + 'x'.repeat(400);
    await writeFile(
      artifact,
      `!<arch>\nmalformed\0${(fragment + '\0').repeat(8)}\x1bSECRET_TRAILER`
    );
    await assert.rejects(
      checkNativeBinaries(directory, { HOME: '/Users/builder' }, 'ios'),
      (error) => {
        assert.match(error.message, /build-machine path/);
        const details = JSON.parse(error.message.split('\nPath diagnostics: ')[1]);
        assert.equal(details.length, 3);
        for (const item of details) {
          assert.equal(item.archiveMember, null);
          assert.equal(item.truncatedAfter, true);
          assert.ok(item.pathToken.length <= 320);
          assert.match(item.pathToken, /^[\x20-\x7e]+$/);
        }
        assert.ok(error.message.length < 2000);
        assert.ok(!error.message.includes('SECRET_TRAILER'));
        assert.ok(!error.message.includes('\x1b'));
        return true;
      }
    );
    await writeFile(artifact, 'DW_AT_name=/home/another/.cargo/registry/native.c\0');
    await assert.rejects(
      checkNativeBinaries(directory, { HOME: '/Users/builder' }, 'ios'),
      (error) => {
        const details = JSON.parse(error.message.split('\nPath diagnostics: ')[1]);
        assert.equal(details.length, 1);
        assert.equal(details[0].pathToken, '/home/another/.cargo/registry/native.c');
        return true;
      }
    );
    await writeFile(artifact, 'option=/Users/build owner/.cargo/source.c PRIVATE_ARGUMENT\0');
    await assert.rejects(
      checkNativeBinaries(directory, { HOME: '/Users/build owner' }, 'ios'),
      (error) => {
        const details = JSON.parse(error.message.split('\nPath diagnostics: ')[1]);
        assert.equal(details.length, 1);
        assert.equal(details[0].pathToken, '/Users/build owner/.cargo/source.c');
        assert.ok(!error.message.includes('PRIVATE_ARGUMENT'));
        return true;
      }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'Swift package remapping preserves compiler arguments and removes its temporary tools',
  {
    skip: process.platform === 'win32'
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "garden-swift's-tools-"));
    const compiler = join(directory, 'swift');
    const receipt = join(directory, 'arguments.json');
    const capture = join(directory, 'capture.mjs');
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(
      capture,
      "import {writeFileSync} from 'node:fs';writeFileSync(process.env.SWIFT_RECEIPT,JSON.stringify(process.argv.slice(2)));\n"
    );
    await writeFile(
      compiler,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(capture)} "$@"\n`,
      { mode: 0o700 }
    );
    const environment = {
      ...process.env,
      HOME: "/build host/owner's home",
      CARGO_HOME: '/build host/cargo',
      GITHUB_WORKSPACE: '/build host/workspace',
      SWIFT_RECEIPT: receipt
    };
    let prepared;
    try {
      prepared = await withReleaseSwiftTools(environment, compiler, {
        clang: compiler,
        'clang++': compiler
      });
      const wrapper = join(prepared.environment.PATH.split(delimiter)[0], 'swift');
      const original = ['build', '--sdk', '/SDK with spaces', '-Xswiftc', '-existing-option'];
      execFileSync(wrapper, original, { env: prepared.environment });
      const forwarded = JSON.parse(await readFile(receipt, 'utf8'));
      assert.deepEqual(forwarded.slice(0, original.length), original);
      const mappings = releasePathMappings(environment);
      assert.ok(mappings.length > 0);
      for (const { source, destination } of mappings) {
        const map = `${source}=${destination}`;
        assert.ok(forwarded.includes(map));
        assert.ok(forwarded.includes(`-ffile-prefix-map=${map}`));
        assert.ok(forwarded.includes(`-fdebug-prefix-map=${map}`));
      }
      assert.ok(forwarded.includes('-file-prefix-map'));
      assert.ok(forwarded.includes('-debug-prefix-map'));
      assert.deepEqual(forwarded.slice(-4), [
        '-Xswiftc',
        '-Xfrontend',
        '-Xswiftc',
        '-no-serialize-debugging-options'
      ]);
      execFileSync(wrapper, ['-target', 'arm64-apple-ios15.0', '-print-target-info'], {
        env: prepared.environment
      });
      assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), [
        '-target',
        'arm64-apple-ios15.0',
        '-print-target-info'
      ]);
      const nativeArguments = [
        '-target',
        'arm64-apple-ios15.0',
        '-isysroot',
        '/SDK with spaces',
        '-gfull'
      ];
      for (const name of ['clang', 'clang++', 'cc', 'c++']) {
        execFileSync(join(prepared.environment.PATH.split(delimiter)[0], name), nativeArguments, {
          env: prepared.environment
        });
        const captured = JSON.parse(await readFile(receipt, 'utf8'));
        assert.deepEqual(captured.slice(0, nativeArguments.length), nativeArguments);
        for (const { source, destination } of mappings) {
          assert.ok(captured.includes(`-ffile-prefix-map=${source}=${destination}`));
          assert.ok(captured.includes(`-fdebug-prefix-map=${source}=${destination}`));
        }
      }
      await prepared.dispose();
      await prepared.dispose();
      await assert.rejects(access(wrapper), { code: 'ENOENT' });
      assert.equal(environment.PATH, process.env.PATH);
    } finally {
      await prepared?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'real Swift release archives pass the unchanged privacy audit only with native path maps',
  {
    skip: process.platform !== 'darwin',
    timeout: 240_000
  },
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'garden-swift-archive-')));
    const project = join(directory, 'package with spaces');
    await mkdir(join(project, 'Sources'), { recursive: true });
    await writeFile(
      join(project, 'Package.swift'),
      '// swift-tools-version:5.3\nimport PackageDescription\nlet package = Package(name: "PathProbe", products: [.library(name: "PathProbe", type: .static, targets: ["PathProbe"])], targets: [.target(name: "PathProbe", path: "Sources")])\n'
    );
    await writeFile(
      join(project, 'Sources', 'Probe.swift'),
      'public func resultValue() -> String { return "garden release probe" }\n'
    );
    const environment = withReleaseRustFlags({ ...process.env, GITHUB_WORKSPACE: project });
    const prepared = await withReleaseSwiftTools(environment);
    const build = async (name, env) => {
      const scratch = join(directory, name);
      execFileSync(
        'swift',
        ['build', '-c', 'release', '--package-path', project, '--scratch-path', scratch],
        { env, encoding: 'utf8', timeout: 180_000, stdio: 'pipe' }
      );
      const names = (await readdir(scratch, { recursive: true })).filter((path) =>
        path.endsWith('/libPathProbe.a')
      );
      const archives = [
        ...new Set(await Promise.all(names.map((name) => realpath(join(scratch, name)))))
      ];
      assert.equal(archives.length, 1);
      const audited = join(directory, `${name}-audit`, 'release');
      await mkdir(audited, { recursive: true });
      const artifact = join(audited, 'libgarden_desktop_lib.a');
      await copyFile(archives[0], artifact);
      return { root: join(directory, `${name}-audit`), bytes: await readFile(artifact) };
    };
    try {
      const before = await build('before', environment);
      assert.ok(
        before.bytes.includes(Buffer.from(project)),
        'The native fixture must reproduce an actual source path'
      );
      await assert.rejects(
        checkNativeBinaries(before.root, environment, 'ios'),
        /build-machine path/
      );
      const after = await build('after', prepared.environment);
      await assert.doesNotReject(
        checkNativeBinaries(after.root, environment, 'ios'),
        'Native maps must remove compiler source paths from the real archive'
      );
      assert.ok(
        after.bytes.includes(Buffer.from('/workspace')),
        'Mapped archive must retain stable source information'
      );
    } finally {
      await prepared.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
