import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const unitSeparator = '\u001f';
const desktopDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(desktopDirectory, '..', '..');

function pathVariants(value) {
  if (!value) return [];
  const resolved = resolve(value);
  const variants = new Set([resolved]);
  if (sep === '\\') variants.add(resolved.replaceAll('\\', '/'));
  return [...variants];
}

export function releasePathMappings(environment = process.env) {
  const userHome = environment.HOME ?? environment.USERPROFILE ?? homedir();
  const cargoHome = environment.CARGO_HOME ?? resolve(userHome, '.cargo');
  const workspace = environment.GITHUB_WORKSPACE ?? workspaceDirectory;
  const mappings = new Map();

  for (const source of pathVariants(userHome)) mappings.set(source, '/build-user');
  for (const source of pathVariants(cargoHome)) mappings.set(source, '/cargo');
  for (const source of pathVariants(workspace)) mappings.set(source, '/workspace');

  return [...mappings].map(([source, destination]) => ({ source, destination }));
}

export function withReleaseRustFlags(environment = process.env, platform, host = process.platform) {
  if (environment.RUSTFLAGS && !environment.CARGO_ENCODED_RUSTFLAGS) {
    throw new Error(
      'RUSTFLAGS is set. Move those arguments to CARGO_ENCODED_RUSTFLAGS so garden can append reproducible-build path remapping safely.'
    );
  }

  const remapArguments = releasePathMappings(environment).flatMap(({ source, destination }) => [
    '--remap-path-prefix',
    `${source}=${destination}`
  ]);
  const existing = environment.CARGO_ENCODED_RUSTFLAGS
    ? environment.CARGO_ENCODED_RUSTFLAGS.split(unitSeparator).filter(Boolean)
    : [];

  // NDK r27 needs both settings for LOAD and RELRO alignment on 16 KB devices.
  const pageArguments =
    platform === 'android'
      ? [
          '-C',
          'link-arg=-Wl,-z,max-page-size=16384',
          '-C',
          'link-arg=-Wl,-z,common-page-size=16384'
        ]
      : [];
  const nativeCompiler = {};
  if (host === 'win32') {
    // Clang rewrites C __FILE__ paths; Rust's maps cannot reach native dependency objects.
    const flags = releasePathMappings(environment).map(({ source, destination }) =>
      JSON.stringify(`/clang:-ffile-prefix-map=${source}=${destination}`)
    );
    Object.assign(nativeCompiler, {
      CC: environment.CC ?? 'clang-cl',
      CXX: environment.CXX ?? 'clang-cl',
      CC_SHELL_ESCAPED_FLAGS: '1',
      AWS_LC_SYS_CMAKE_BUILDER: environment.AWS_LC_SYS_CMAKE_BUILDER ?? '0',
      CFLAGS: [environment.CFLAGS, ...flags].filter(Boolean).join(' '),
      CXXFLAGS: [environment.CXXFLAGS, ...flags].filter(Boolean).join(' ')
    });
  }
  return {
    ...environment,
    ...nativeCompiler,
    CARGO_ENCODED_RUSTFLAGS: [...existing, ...remapArguments, ...pageArguments].join(unitSeparator)
  };
}

function appendGitHubEnvironment(environment) {
  const githubEnvironment = environment.GITHUB_ENV;
  if (!githubEnvironment) {
    throw new Error('GITHUB_ENV is not set; this mode is only for GitHub Actions');
  }
  const configured = withReleaseRustFlags(environment);
  const delimiter = `GARDEN_RUSTFLAGS_${process.pid}`;
  appendFileSync(
    githubEnvironment,
    `CARGO_ENCODED_RUSTFLAGS<<${delimiter}\n${configured.CARGO_ENCODED_RUSTFLAGS}\n${delimiter}\n`,
    'utf8'
  );
  if (process.platform === 'win32') {
    for (const key of [
      'CC',
      'CXX',
      'CC_SHELL_ESCAPED_FLAGS',
      'AWS_LC_SYS_CMAKE_BUILDER',
      'CFLAGS',
      'CXXFLAGS'
    ])
      appendFileSync(
        githubEnvironment,
        `${key}<<${delimiter}\n${configured[key]}\n${delimiter}\n`,
        'utf8'
      );
  }
  console.log('Configured stable Rust source-path remapping for the release build');
}

if (process.argv.includes('--github-env')) appendGitHubEnvironment(process.env);
