import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MAX_COMMAND_OUTPUT = 64 * 1024 * 1024;
const SECRET_PATTERNS = [
  ['OpenRouter key', /sk-or-v1-[A-Za-z0-9_-]{20,}/],
  [
    'private key',
    /-----BEGIN ((?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----[\r\n]+[A-Za-z0-9+/=\r\n]{64,}-----END \1-----/
  ],
  ['macOS build path', /\/Users\/[^/\0]+\/(?:\.cargo|\.rustup|Documents)\//],
  ['GitHub runner path', /\/Users\/runner\/work\/|\/home\/runner\/work\//],
  ['Windows build path', /[A-Za-z]:\\Users\\[^\\\0]+\\(?:\.cargo|\.rustup|source|work)\\/i]
];

function invariant(value, message) {
  if (!value) throw new Error(message);
}

async function command(commandPath, argumentsForCommand, { allowFailure = false } = {}) {
  try {
    const result = await execFile(commandPath, argumentsForCommand, {
      encoding: 'utf8',
      maxBuffer: MAX_COMMAND_OUTPUT
    });
    return { ...result, code: 0 };
  } catch (error) {
    if (allowFailure) {
      return {
        code: typeof error.code === 'number' ? error.code : 1,
        stdout: String(error.stdout ?? ''),
        stderr: String(error.stderr ?? '')
      };
    }
    throw new Error(
      `${basename(commandPath)} failed: ${String(error.stderr ?? error.message).trim()}`
    );
  }
}

export function isSafeArchivePath(entry) {
  return (
    entry.length > 0 &&
    !entry.startsWith('/') &&
    !entry.startsWith('\\') &&
    !/^[A-Za-z]:/.test(entry) &&
    !entry.split(/[\\/]/).includes('..')
  );
}

export function assertNoIosSensitiveContent(label, bytes) {
  const text = bytes.toString('latin1');
  for (const [kind, pattern] of SECRET_PATTERNS) {
    invariant(!pattern.test(text), `${label} contains a ${kind} or its build-time location`);
  }
}

export function validateIosInfo(info, expectedVersion) {
  invariant(info.CFBundleIdentifier === 'org.garden.ai', 'iOS bundle identifier changed');
  invariant(info.CFBundleName === 'garden', 'iOS bundle name changed');
  invariant(
    info.CFBundleShortVersionString === expectedVersion,
    'iOS and Tauri versions do not match'
  );
  invariant(
    typeof info.CFBundleVersion === 'string' && info.CFBundleVersion.length > 0,
    'iOS bundle version is missing'
  );
  invariant(
    info.MinimumOSVersion === '15.0',
    'iOS minimum operating-system version must remain 15.0'
  );
  const schemes = (info.CFBundleURLTypes ?? []).flatMap((entry) => entry.CFBundleURLSchemes ?? []);
  invariant(
    schemes.length === 1 && schemes.includes('garden'),
    'iOS pairing deep-link boundary changed'
  );
  const transport = info.NSAppTransportSecurity ?? {};
  const exceptionDomains = transport.NSExceptionDomains ?? {};
  invariant(
    Object.keys(transport).length === 1 &&
      Object.keys(exceptionDomains).length === 1 &&
      exceptionDomains.localhost?.NSExceptionAllowsInsecureHTTPLoads === true &&
      exceptionDomains.localhost?.NSIncludesSubdomains === false,
    'iOS transport policy must permit insecure HTTP only for exact localhost'
  );
  invariant(
    JSON.stringify(info.NSBonjourServices) === JSON.stringify(['_garden._tcp']),
    'iOS Bonjour discovery boundary changed'
  );
  for (const key of [
    'NSCameraUsageDescription',
    'NSLocalNetworkUsageDescription',
    'NSMicrophoneUsageDescription',
    'NSPhotoLibraryUsageDescription'
  ]) {
    invariant(
      typeof info[key] === 'string' && info[key].trim().length >= 20,
      `iOS privacy declaration is missing: ${key}`
    );
  }
}

async function assertContainedSymlinks(root) {
  const canonicalRoot = `${await realpath(root)}${sep}`;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const details = await lstat(path);
      if (details.isSymbolicLink()) {
        const target = await realpath(path);
        invariant(
          target === canonicalRoot.slice(0, -1) || target.startsWith(canonicalRoot),
          `iOS package contains a symlink outside its app bundle: ${path}`
        );
      } else if (details.isDirectory()) {
        await visit(path);
      }
    }
  }
  await visit(root);
}

async function plistJson(path) {
  const { stdout } = await command('plutil', ['-convert', 'json', '-o', '-', path]);
  return JSON.parse(stdout);
}

export async function verifyIosIpa(ipaPath) {
  invariant(process.platform === 'darwin', 'iOS IPA auditing requires macOS platform tools');
  const resolvedIpa = resolve(ipaPath);
  const details = await stat(resolvedIpa);
  invariant(details.isFile(), `iOS artifact is not a file: ${resolvedIpa}`);
  invariant(details.size < 350 * 1024 * 1024, 'iOS artifact is unexpectedly large');

  const { stdout: listing } = await command('unzip', ['-Z1', resolvedIpa]);
  const entries = listing.trim().split(/\r?\n/).filter(Boolean);
  invariant(entries.every(isSafeArchivePath), 'iOS package contains an unsafe archive path');
  const infoEntries = entries.filter((entry) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(entry));
  invariant(infoEntries.length === 1, 'iOS package must contain exactly one application');

  const extractionDirectory = await mkdtemp(join(tmpdir(), 'garden-ios-audit-'));
  try {
    await command('unzip', ['-q', resolvedIpa, '-d', extractionDirectory]);
    await assertContainedSymlinks(extractionDirectory);
    const applicationDirectory = join(extractionDirectory, dirname(infoEntries[0]));
    const infoPath = join(applicationDirectory, 'Info.plist');
    const info = await plistJson(infoPath);
    const sourceConfig = JSON.parse(
      await readFile(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf8')
    );
    validateIosInfo(info, sourceConfig.version);

    const executable = join(applicationDirectory, info.CFBundleExecutable);
    const executableDetails = await stat(executable);
    invariant(
      executableDetails.isFile() && executableDetails.size > 0,
      'iOS application executable is missing'
    );
    const { stdout: architectures } = await command('lipo', ['-archs', executable]);
    invariant(
      architectures.trim() === 'arm64',
      `iOS application architecture changed: ${architectures.trim()}`
    );
    await command('codesign', [
      '--verify',
      '--deep',
      '--strict',
      '--verbose=2',
      applicationDirectory
    ]);
    const entitlementsResult = await command('codesign', [
      '--display',
      '--entitlements',
      ':-',
      applicationDirectory
    ]);
    const entitlementsText = `${entitlementsResult.stdout}\n${entitlementsResult.stderr}`;
    invariant(
      !/<key>get-task-allow<\/key>\s*<true\/>/.test(entitlementsText),
      'iOS release artifact permits debugger attachment'
    );
    invariant(
      entitlementsText.includes('application-identifier') &&
        entitlementsText.includes('.org.garden.ai'),
      'iOS release signing identity does not cover org.garden.ai'
    );

    const provisionPath = join(applicationDirectory, 'embedded.mobileprovision');
    const provisionDetails = await stat(provisionPath);
    invariant(
      provisionDetails.isFile() && provisionDetails.size > 0,
      'iOS provisioning profile is missing'
    );
    const { stdout: provisionXml } = await command('security', ['cms', '-D', '-i', provisionPath]);
    const decodedProvision = join(extractionDirectory, 'provision.plist');
    await writeFile(decodedProvision, provisionXml, { mode: 0o600 });
    const provision = await plistJson(decodedProvision);
    invariant(
      !Array.isArray(provision.ProvisionedDevices) && provision.ProvisionsAllDevices !== true,
      'iOS release provisioning profile is not an App Store distribution profile'
    );
    invariant(
      new Date(provision.ExpirationDate).getTime() > Date.now(),
      'iOS release provisioning profile is expired'
    );
    invariant(
      String(provision.Entitlements?.['application-identifier'] ?? '').endsWith('.org.garden.ai') &&
        provision.Entitlements?.['get-task-allow'] !== true,
      'iOS provisioning profile does not securely cover org.garden.ai'
    );

    assertNoIosSensitiveContent('iOS application executable', await readFile(executable));
  } finally {
    await rm(extractionDirectory, { recursive: true, force: true });
  }

  const ipaBytes = await readFile(resolvedIpa);
  assertNoIosSensitiveContent('iOS package', ipaBytes);
  const digest = createHash('sha256').update(ipaBytes).digest('hex');
  console.log(
    `Verified iOS IPA ${basename(resolvedIpa)}: arm64, signed App Store profile, sha256 ${digest}`
  );
  return { digest };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  invariant(process.argv.length === 3, 'Usage: verify-ios-artifact.mjs IPA');
  await verifyIosIpa(process.argv[2]);
}
