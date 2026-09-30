import { execFileSync } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { releasePathMappings } from './release-build-env.mjs';

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

/** Swift package build scripts compile outside rustc, so their source paths need their own maps. */
export async function withReleaseSwiftTools(
  environment = process.env,
  swiftExecutable,
  nativeCompilers
) {
  const executable =
    swiftExecutable ??
    execFileSync('/usr/bin/xcrun', ['--find', 'swift'], {
      encoding: 'utf8',
      env: environment
    }).trim();
  if (!isAbsolute(executable))
    throw new Error('The release Swift compiler must be an absolute path');
  await access(executable, constants.X_OK);
  const flags = releasePathMappings(environment).flatMap(({ source, destination }) => {
    const mapping = `${source}=${destination}`;
    return [
      '-Xswiftc',
      '-file-prefix-map',
      '-Xswiftc',
      mapping,
      '-Xswiftc',
      '-debug-prefix-map',
      '-Xswiftc',
      mapping,
      '-Xcc',
      `-ffile-prefix-map=${mapping}`,
      '-Xcc',
      `-fdebug-prefix-map=${mapping}`,
      '-Xcxx',
      `-ffile-prefix-map=${mapping}`,
      '-Xcxx',
      `-fdebug-prefix-map=${mapping}`
    ];
  });
  // Binary Swift modules otherwise retain header-search and compiler paths despite source maps.
  flags.push('-Xswiftc', '-Xfrontend', '-Xswiftc', '-no-serialize-debugging-options');
  const compilers =
    nativeCompilers ??
    (process.platform === 'darwin'
      ? Object.fromEntries(
          ['clang', 'clang++'].map((name) => [
            name,
            execFileSync('/usr/bin/xcrun', ['--find', name], {
              encoding: 'utf8',
              env: environment
            }).trim()
          ])
        )
      : {});
  const nativeFlags = releasePathMappings(environment).flatMap(({ source, destination }) => [
    `-ffile-prefix-map=${source}=${destination}`,
    `-fdebug-prefix-map=${source}=${destination}`
  ]);
  const directory = await mkdtemp(join(tmpdir(), 'garden-release-swift-'));
  try {
    await writeFile(
      join(directory, 'swift'),
      `#!/bin/sh\nset -eu\nif [ "\${1:-}" = build ]; then\n  exec ${quote(executable)} "$@" ${flags.map(quote).join(' ')}\nfi\nexec ${quote(executable)} "$@"\n`,
      { mode: 0o700 }
    );
    // Tauri forwards PATH to Xcode but replaces target CFLAGS with its SDK settings.
    // Compiler wrappers retain those settings while applying maps to C archive debug records.
    for (const [name, compiler] of Object.entries(compilers)) {
      if (!isAbsolute(compiler)) throw new Error('The release C compiler must be an absolute path');
      await access(compiler, constants.X_OK);
      for (const alias of [name, name === 'clang' ? 'cc' : 'c++']) {
        await writeFile(
          join(directory, alias),
          `#!/bin/sh\nset -eu\nexec ${quote(compiler)} "$@" ${nativeFlags.map(quote).join(' ')}\n`,
          { mode: 0o700 }
        );
      }
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    environment: { ...environment, PATH: `${directory}${delimiter}${environment.PATH ?? ''}` },
    dispose: () => rm(directory, { recursive: true, force: true })
  };
}
