import { readFile, appendFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), 'utf8'));
}

function cargoVersion(source) {
  const packageSection = source.match(/^\[package\]\s*([\s\S]*?)(?=^\[)/m)?.[1] ?? '';
  return packageSection.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
}

const [
  rootPackage,
  desktopPackage,
  tauriConfig,
  cargoManifest,
  installerSource,
  sshInstallerSource,
  webInstallerSource,
  readmeSource,
  deploymentSource
] = await Promise.all([
  readJson('package.json'),
  readJson('apps/desktop/package.json'),
  readJson('apps/desktop/src-tauri/tauri.conf.json'),
  readFile(new URL('apps/desktop/src-tauri/Cargo.toml', root), 'utf8'),
  readFile(new URL('install.sh', root)),
  readFile(new URL('apps/desktop/src-tauri/src/ssh_install.rs', root), 'utf8'),
  readFile(new URL('apps/web/src/ServerInstall.tsx', root), 'utf8'),
  readFile(new URL('README.md', root), 'utf8'),
  readFile(new URL('docs/DEPLOYMENT.md', root), 'utf8')
]);

const versions = new Map([
  ['package.json', rootPackage.version],
  ['apps/desktop/package.json', desktopPackage.version],
  ['apps/desktop/src-tauri/tauri.conf.json', tauriConfig.version],
  ['apps/desktop/src-tauri/Cargo.toml', cargoVersion(cargoManifest)]
]);
const expectedVersion = rootPackage.version;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

if (typeof expectedVersion !== 'string' || !semver.test(expectedVersion)) {
  throw new Error(`package.json has an invalid release version: ${String(expectedVersion)}`);
}

const mismatches = [...versions].filter(([, version]) => version !== expectedVersion);
if (mismatches.length > 0) {
  throw new Error(
    `Release versions must match ${expectedVersion}: ${mismatches
      .map(([path, version]) => `${path}=${String(version)}`)
      .join(', ')}`
  );
}

const installerHash = createHash('sha256').update(installerSource).digest('hex');
if (!sshInstallerSource.includes(`"${installerHash}"`)) {
  throw new Error(
    'The native SSH installer checksum does not match install.sh; review the bootstrap change and update INSTALL_BOOTSTRAP_SHA256'
  );
}
if (!sshInstallerSource.includes('concat!("v", env!("CARGO_PKG_VERSION"))')) {
  throw new Error('The native SSH installer must pin to the compiled package version');
}
if (
  !sshInstallerSource.includes('env!("GARDEN_SOURCE_COMMIT")') ||
  !sshInstallerSource.includes("GARDEN_EXPECTED_COMMIT='{SOURCE_COMMIT}'") ||
  !installerSource.includes('GARDEN_EXPECTED_COMMIT') ||
  !installerSource.includes('installed_commit')
) {
  throw new Error('The native SSH installer must pin the downloaded source to its compiled commit');
}
if (!webInstallerSource.includes(`v${expectedVersion}`)) {
  throw new Error(
    `apps/web/src/ServerInstall.tsx does not pin the browser installer to v${expectedVersion}`
  );
}
/**
 * Every published install path must point at the same namespace the maintainer controls. A
 * `curl … | sh` command aimed anywhere else hands whoever owns that namespace root on every
 * installation, so a stale or mistyped owner is a release-blocking supply-chain defect.
 */
const PUBLIC_NAMESPACE = 'ouaeic/garden';
const foreignNamespaces = [
  ['install.sh', installerSource],
  ['README.md', readmeSource],
  ['docs/DEPLOYMENT.md', deploymentSource],
  ['apps/web/src/ServerInstall.tsx', webInstallerSource]
].flatMap(([path, source]) =>
  // install.sh is read as a Buffer so it can be hashed above; match against its text form.
  [
    ...String(source).matchAll(
      /github(?:usercontent)?\.com\/([\w.-]+\/[\w.-]+?)(?:\.git|\/|["'\s])/g
    )
  ]
    .map((match) => match[1].replace(/\.git$/, ''))
    .filter((owner) => owner !== PUBLIC_NAMESPACE)
    .map((owner) => `${path} -> ${owner}`)
);
if (foreignNamespaces.length) {
  throw new Error(
    `Install paths must reference ${PUBLIC_NAMESPACE}. Found: ${foreignNamespaces.join(', ')}`
  );
}

// A published install command must be pinned to the release tag, never a branch.
for (const [path, source] of [
  ['README.md', readmeSource],
  ['docs/DEPLOYMENT.md', deploymentSource]
]) {
  if (!source.includes('install.sh |')) continue;
  if (
    !source.includes(`/v${expectedVersion}/install.sh`) ||
    !source.includes(`GARDEN_REF=v${expectedVersion}`)
  ) {
    throw new Error(`${path} does not pin the public installer to v${expectedVersion}`);
  }
}

const releaseTag =
  process.env.GARDEN_RELEASE_TAG ??
  (process.env.GITHUB_REF_TYPE === 'tag' ? (process.env.GITHUB_REF_NAME ?? '') : undefined);
if (releaseTag !== undefined && releaseTag !== `v${expectedVersion}`) {
  throw new Error(`Release tag ${releaseTag} does not match v${expectedVersion}`);
}

/**
 * What a build leaves on the owner's disk.
 *
 * An update is `pnpm install && pnpm -r build` against the checkout at /opt/garden, and the five
 * systemd services then run `node <package>/dist/index.js` from that tree. So whatever `tsc` emits
 * is shipped weight on a box that has one owner and no CI - and for a long time 7,092 kB of the
 * 15,744 kB it emitted was compiled test files, which cannot run there and which the test runner
 * then found beside their own sources. A further 2,716 kB was source maps that nothing reads, since
 * garden-service execs plain `node` with no --enable-source-maps, and 1,700 kB was declarations
 * that nothing reads either, since every package points `exports["."].types` at ./src.
 *
 * Two halves, deliberately. The configuration half runs on every checkout, built or not, which is
 * what stops this from being a gate with nothing behind it: `pnpm check` runs the release check
 * before the build, so on a fresh clone there is no dist to inspect and an output-only check would
 * pass by finding nothing. The output half bites on any tree that has been built.
 *
 * There is no byte ceiling here on purpose, for the same reason: a number checked against output
 * that is often absent when the check runs would read as a bound and hold nothing. The kinds are
 * exact and need no number.
 */
const distFailures = [];

const stripJsonComments = (source) =>
  source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

const readTsconfig = async (path) =>
  JSON.parse(stripJsonComments(await readFile(new URL(path, root), 'utf8')));

const baseTsconfig = await readTsconfig('tsconfig.base.json');
for (const option of ['declaration', 'sourceMap', 'declarationMap', 'inlineSourceMap']) {
  if (baseTsconfig.compilerOptions?.[option]) {
    distFailures.push(
      `tsconfig.base.json turns ${option} on, which every package inherits: that is shipped output nothing on the box reads`
    );
  }
}

const workspacePackages = (
  await Promise.all(
    ['apps', 'packages', 'services'].map(async (group) =>
      (await readdir(new URL(`${group}/`, root), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${group}/${entry.name}`)
    )
  )
).flat();

for (const packageDirectory of workspacePackages.sort()) {
  const manifest = await readJson(`${packageDirectory}/package.json`).catch(() => null);
  const build = manifest?.scripts?.build;
  // Only packages that emit with `tsc`. apps/web builds with its bundler and apps/desktop with
  // Cargo, and a directory left behind with no manifest at all is not a package.
  if (typeof build !== 'string' || !/\btsc\b/.test(build) || build.includes('--noEmit')) continue;

  if (!build.includes('tsconfig.build.json')) {
    distFailures.push(
      `${packageDirectory} builds with ${JSON.stringify(build)}: emitting through tsconfig.json compiles the tests beside the sources`
    );
  }
  // `tsc` never removes an output it has stopped emitting. Without the clean, every box that built
  // once before this rule keeps its compiled tests, maps and declarations for ever, and the next
  // thing to be dropped from the emit stays on disk the same way.
  if (!/\brm -rf dist\b/.test(build)) {
    distFailures.push(
      `${packageDirectory} does not clear dist before building, so output it no longer emits stays on the box`
    );
  }

  const buildTsconfig = await readTsconfig(`${packageDirectory}/tsconfig.build.json`).catch(
    () => null
  );
  if (!buildTsconfig) {
    distFailures.push(`${packageDirectory} has no tsconfig.build.json`);
  } else if (
    // Matched by shape rather than by the exact string, so that widening the pattern - a package
    // that grows a .test.tsx, say - is not read as removing the exclusion. Anchored to src/**
    // because an unanchored `*.test.ts` excludes only the package root and would leave every test
    // in the tree being emitted while looking like this rule was followed.
    !(buildTsconfig.exclude ?? []).some((pattern) => /^src\/\*\*\/\*\.test\./.test(pattern))
  ) {
    distFailures.push(
      `${packageDirectory}/tsconfig.build.json does not exclude src/**/*.test.*, so the build emits the tests`
    );
  }
}

const distFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const found = [];
  for (const entry of entries) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) found.push(...(await distFiles(child)));
    else found.push(child);
  }
  return found;
};

let emittedBytes = 0;
for (const packageDirectory of workspacePackages) {
  // apps/web's dist is its bundler's output - hashed assets, fonts, a service worker - and is
  // governed by the eager-bundle gate rather than by this one.
  if (packageDirectory === 'apps/web') continue;
  for (const file of await distFiles(new URL(`${packageDirectory}/dist/`, root))) {
    const name = file.pathname.split('/').pop() ?? '';
    if (/\.test\.[cm]?js$/.test(name) || /\.spec\.[cm]?js$/.test(name)) {
      distFailures.push(`${packageDirectory}/dist carries a compiled test: ${name}`);
    } else if (name.endsWith('.map')) {
      distFailures.push(`${packageDirectory}/dist carries a source map nothing on the box reads`);
    } else if (name.endsWith('.d.ts')) {
      distFailures.push(`${packageDirectory}/dist carries a declaration nothing resolves through`);
    }
    emittedBytes += (await stat(file)).size;
  }
}

if (distFailures.length > 0) {
  // Deduplicated: a package with forty maps in it is one fault, and forty lines of it buries the
  // package that has a different one.
  throw new Error(
    `Compiled output an install must not carry:\n  ${[...new Set(distFailures)].join('\n  ')}`
  );
}

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `version=${expectedVersion}\n`, {
    encoding: 'utf8'
  });
}

console.log(
  `Verified garden release version v${expectedVersion}; compiled output ${
    emittedBytes > 0 ? `${Math.round(emittedBytes / 1024)} kB` : 'not built here'
  }`
);
