import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MAX_COMMAND_OUTPUT = 16 * 1024 * 1024;
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

export function assertNoMacSensitiveContent(label, bytes) {
  const text = bytes.toString('latin1');
  for (const [kind, pattern] of SECRET_PATTERNS) {
    invariant(!pattern.test(text), `${label} contains a ${kind} or its build-time location`);
  }
}

export function validateMacInfo(info, expectedVersion) {
  invariant(info.CFBundleIdentifier === 'org.garden.ai', 'macOS bundle identifier changed');
  invariant(info.CFBundleName === 'garden', 'macOS bundle name changed');
  invariant(
    info.CFBundleShortVersionString === expectedVersion,
    'macOS and Tauri versions do not match'
  );
  invariant(
    typeof info.CFBundleVersion === 'string' && info.CFBundleVersion.length > 0,
    'macOS bundle version is missing'
  );
  invariant(
    typeof info.CFBundleExecutable === 'string' && info.CFBundleExecutable.length > 0,
    'macOS executable name is missing'
  );
  invariant(
    info.LSMinimumSystemVersion === '12.0',
    'macOS minimum operating-system version must remain 12.0'
  );
  const schemes = (info.CFBundleURLTypes ?? []).flatMap((entry) => entry.CFBundleURLSchemes ?? []);
  invariant(
    schemes.length === 1 && schemes.includes('garden'),
    'macOS pairing deep-link boundary changed'
  );
  const transport = info.NSAppTransportSecurity ?? {};
  const exceptionDomains = transport.NSExceptionDomains ?? {};
  invariant(
    Object.keys(transport).length === 1 &&
      Object.keys(exceptionDomains).length === 1 &&
      exceptionDomains.localhost?.NSExceptionAllowsInsecureHTTPLoads === true &&
      exceptionDomains.localhost?.NSIncludesSubdomains === false,
    'macOS transport policy must permit insecure HTTP only for exact localhost'
  );
  invariant(
    JSON.stringify(info.NSBonjourServices) === JSON.stringify(['_garden._tcp']),
    'macOS Bonjour discovery boundary changed'
  );
  for (const key of [
    'NSCameraUsageDescription',
    'NSLocalNetworkUsageDescription',
    'NSMicrophoneUsageDescription',
    'NSPhotoLibraryUsageDescription'
  ]) {
    invariant(
      typeof info[key] === 'string' && info[key].trim().length >= 20,
      `macOS privacy declaration is missing: ${key}`
    );
  }
}

async function plistJson(path) {
  const { stdout } = await command('plutil', ['-convert', 'json', '-o', '-', path]);
  return JSON.parse(stdout);
}

async function inspectBundleTree(root) {
  const canonicalRoot = `${await realpath(root)}${sep}`;
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const details = await lstat(path);
      if (details.isSymbolicLink()) {
        const target = await realpath(path);
        invariant(
          target === canonicalRoot.slice(0, -1) || target.startsWith(canonicalRoot),
          `macOS application contains a symlink outside its bundle: ${path}`
        );
      } else if (details.isDirectory()) {
        await visit(path);
      } else if (details.isFile()) {
        invariant(details.size < 350 * 1024 * 1024, `macOS bundle file is too large: ${path}`);
        files.push(path);
      }
    }
  }
  await visit(root);
  return files;
}

export async function verifyMacApplication(
  applicationPath,
  { requireDistribution = false, expectedArchitectures } = {}
) {
  invariant(process.platform === 'darwin', 'macOS application auditing requires macOS');
  const application = resolve(applicationPath);
  invariant(
    (await stat(application)).isDirectory(),
    `macOS artifact is not an app: ${application}`
  );
  invariant(application.endsWith('.app'), 'macOS artifact must be an application bundle');

  const infoPath = join(application, 'Contents', 'Info.plist');
  const info = await plistJson(infoPath);
  const sourceConfig = JSON.parse(
    await readFile(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf8')
  );
  validateMacInfo(info, sourceConfig.version);

  const executable = join(application, 'Contents', 'MacOS', info.CFBundleExecutable);
  invariant((await stat(executable)).isFile(), 'macOS application executable is missing');
  const icon = join(application, 'Contents', 'Resources', 'icon.icns');
  invariant((await stat(icon)).size > 0, 'macOS application icon is missing');

  const files = await inspectBundleTree(application);
  invariant(files.length >= 3, 'macOS application bundle is incomplete');
  for (const file of files) {
    assertNoMacSensitiveContent(`macOS bundle file ${file}`, await readFile(file));
  }

  const { stdout: architectures } = await command('lipo', ['-archs', executable]);
  const actualArchitectures = architectures.trim().split(/\s+/).sort();
  if (expectedArchitectures?.length) {
    invariant(
      JSON.stringify(actualArchitectures) === JSON.stringify([...expectedArchitectures].sort()),
      `macOS application architectures changed: ${architectures.trim()}`
    );
  } else {
    invariant(
      actualArchitectures.length > 0 &&
        actualArchitectures.every((architecture) => ['arm64', 'x86_64'].includes(architecture)),
      `macOS application architecture is unsupported: ${architectures.trim()}`
    );
  }

  await command('codesign', ['--verify', '--deep', '--strict', '--verbose=2', application]);
  const signatureResult = await command('codesign', ['--display', '--verbose=4', application]);
  const signatureText = `${signatureResult.stdout}\n${signatureResult.stderr}`;
  const isAdhoc = /Signature=adhoc/.test(signatureText);
  if (requireDistribution) {
    invariant(!isAdhoc, 'macOS release application has only an ad-hoc signature');
    invariant(
      /Authority=Developer ID Application:/.test(signatureText),
      'macOS release application is not signed by a Developer ID Application identity'
    );
    invariant(
      /TeamIdentifier=[A-Z0-9]{10}/.test(signatureText),
      'macOS release application has no Apple team identifier'
    );
  }

  const entitlementsResult = await command(
    'codesign',
    ['--display', '--entitlements', ':-', application],
    { allowFailure: true }
  );
  const entitlements = `${entitlementsResult.stdout}\n${entitlementsResult.stderr}`;
  invariant(
    !/<key>com\.apple\.security\.get-task-allow<\/key>\s*<true\/>/.test(entitlements),
    'macOS release artifact permits debugger attachment'
  );

  const digest = createHash('sha256');
  for (const file of files.sort()) {
    digest.update(file.slice(application.length));
    digest.update(await readFile(file));
  }
  const hash = digest.digest('hex');
  console.log(
    `Verified macOS app ${basename(application)}: ${actualArchitectures.join('+')}, ${
      isAdhoc ? 'ad-hoc' : 'distribution'
    } signature, sha256-tree ${hash}`
  );
  return { architectures: actualArchitectures, digest: hash, isAdhoc };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const requireDistribution = args.includes('--require-distribution');
  const architectureArgument = args.find((argument) =>
    argument.startsWith('--expected-architectures=')
  );
  const application = args.find((argument) => !argument.startsWith('--'));
  invariant(
    application,
    'Usage: verify-macos-artifact.mjs APP [--require-distribution] [--expected-architectures=arm64,x86_64]'
  );
  await verifyMacApplication(application, {
    requireDistribution,
    expectedArchitectures: architectureArgument?.split('=')[1].split(',').filter(Boolean)
  });
}
