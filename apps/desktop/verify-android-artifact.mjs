import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MAX_COMMAND_OUTPUT = 64 * 1024 * 1024;
const EXPECTED_PERMISSIONS = new Set([
  'android.permission.INTERNET',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.RECORD_AUDIO',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.WAKE_LOCK',
  'org.garden.ai.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'
]);
const EXPECTED_BACKUP_DOMAINS = [
  'root',
  'file',
  'database',
  'sharedpref',
  'external',
  'device_root',
  'device_file',
  'device_database',
  'device_sharedpref'
];
const SECRET_PATTERNS = [
  ['OpenRouter key', /sk-or-v1-[A-Za-z0-9_-]{20,}/],
  [
    'private key',
    /-----BEGIN ((?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----[\r\n]+[A-Za-z0-9+/=\r\n]{64,}-----END \1-----/
  ],
  ['macOS build path', /\/Users\/[^/\0]+\/(?:\.cargo|\.rustup|Documents)\//],
  ['GitHub runner path', /\/home\/runner\/work\//],
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

async function binaryCommand(commandPath, argumentsForCommand) {
  return await new Promise((resolveCommand, reject) => {
    execFileCallback(
      commandPath,
      argumentsForCommand,
      { encoding: 'buffer', maxBuffer: MAX_COMMAND_OUTPUT },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${basename(commandPath)} failed: ${Buffer.from(stderr ?? '')
                .toString('utf8')
                .trim()}`
            )
          );
        } else {
          resolveCommand(Buffer.from(stdout));
        }
      }
    );
  });
}

async function archiveEntries(archivePath) {
  const archiveTool = process.platform === 'win32' ? 'tar' : 'unzip';
  const listArguments = process.platform === 'win32' ? ['-tf', archivePath] : ['-Z1', archivePath];
  const { stdout } = await command(archiveTool, listArguments);
  const entries = stdout.trim().split(/\r?\n/).filter(Boolean);
  for (const entry of entries) {
    invariant(
      !entry.startsWith('/') && !entry.split('/').includes('..'),
      `Android package contains an unsafe archive path: ${entry}`
    );
  }
  return entries;
}

async function archiveEntry(archivePath, entry) {
  return process.platform === 'win32'
    ? await binaryCommand('tar', ['-xOf', archivePath, entry])
    : await binaryCommand('unzip', ['-p', archivePath, entry]);
}

async function latestBuildTools(sdkRoot) {
  invariant(sdkRoot, 'Set ANDROID_HOME or ANDROID_SDK_ROOT before auditing an APK');
  const root = join(sdkRoot, 'build-tools');
  const candidates = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  invariant(candidates.length > 0, `No Android build tools were found below ${root}`);
  return join(root, candidates[0]);
}

function stringSet(values) {
  return new Set(values.filter(Boolean));
}

function equalSets(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

export function parseBadging(badging) {
  const packageLine = badging.match(
    /^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m
  );
  const minSdk = badging.match(/^minSdkVersion:'([^']+)'/m)?.[1];
  const targetSdk = badging.match(/^targetSdkVersion:'([^']+)'/m)?.[1];
  const permissions = [...badging.matchAll(/^uses-permission: name='([^']+)'/gm)].map(
    (match) => match[1]
  );
  const nativeCode = badging.match(/^native-code: (.+)$/m)?.[1] ?? '';
  const abis = [...nativeCode.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  return {
    packageName: packageLine?.[1],
    versionCode: packageLine?.[2],
    versionName: packageLine?.[3],
    minSdk,
    targetSdk,
    permissions,
    abis
  };
}

export function validateManifestTree(manifest) {
  const requirements = [
    ['release cleartext traffic is disabled', /usesCleartextTraffic[^=\n]*=false/],
    ['Android backup is disabled', /allowBackup[^=\n]*=false/],
    ['network security config is attached', /networkSecurityConfig[^=\n]*=@/],
    ['Android 12 backup rules are attached', /dataExtractionRules[^=\n]*=@/],
    ['legacy backup rules are attached', /fullBackupContent[^=\n]*=@/],
    ['the private deep-link scheme is present', /scheme[^=\n]*="garden"/],
    ['the file provider is not exported', /FileProvider[\s\S]*?exported[^=\n]*=false/]
  ];
  for (const [label, pattern] of requirements) {
    invariant(pattern.test(manifest), `Android manifest audit failed: ${label}`);
  }
  invariant(
    !/debuggable[^=\n]*=true/.test(manifest),
    'Android manifest audit failed: release package is debuggable'
  );
  invariant(
    !manifest.includes('android.software.leanback') &&
      !manifest.includes('android.intent.category.LEANBACK_LAUNCHER'),
    'Android manifest audit failed: the phone client must not advertise unsupported TV behavior'
  );
  invariant(
    (manifest.match(/exported[^=\n]*=true/g) ?? []).length === 2,
    'Android manifest audit failed: the exported-component boundary changed'
  );
  invariant(
    /ProfileInstallReceiver[\s\S]*?permission[^=\n]*="android\.permission\.DUMP"[\s\S]*?exported[^=\n]*=true/.test(
      manifest
    ),
    'Android manifest audit failed: the only library-exported receiver lost its DUMP permission'
  );
}

export function validateNetworkSecurity(networkSecurity) {
  invariant(
    (networkSecurity.match(/cleartextTrafficPermitted=false/g) ?? []).length === 1,
    'Android network policy must deny cleartext by default'
  );
  invariant(
    (networkSecurity.match(/cleartextTrafficPermitted=true/g) ?? []).length === 1,
    'Android network policy must contain one loopback exception'
  );
  invariant(
    (networkSecurity.match(/includeSubdomains=false/g) ?? []).length === 1,
    'Android loopback cleartext permission must not include subdomains'
  );
  const domains = [...networkSecurity.matchAll(/T: '([^']+)'/g)].map((match) => match[1]);
  invariant(
    domains.length === 1 && domains[0] === 'localhost',
    'Android cleartext traffic may be permitted only for exact localhost'
  );
}

export function validateBackupRules(contents, modern) {
  if (modern) {
    invariant(contents.includes('E: cloud-backup'), 'Android cloud-backup exclusions are missing');
    invariant(
      contents.includes('E: device-transfer'),
      'Android device-transfer exclusions are missing'
    );
  } else {
    invariant(
      contents.includes('E: full-backup-content'),
      'Legacy Android backup exclusions are missing'
    );
  }
  const expectedCount = modern ? 2 : 1;
  for (const domain of EXPECTED_BACKUP_DOMAINS) {
    const escaped = domain.replaceAll('_', '\\_');
    const matches = contents.match(new RegExp(`domain(?:\\([^)]*\\))?="${escaped}"`, 'g')) ?? [];
    invariant(
      matches.length === expectedCount,
      `Android backup rules do not exclude ${domain} from every backup mode`
    );
  }
  invariant(
    (contents.match(/path(?:\([^)]*\))?="\."/g) ?? []).length ===
      EXPECTED_BACKUP_DOMAINS.length * expectedCount,
    'Android backup exclusions must cover each complete storage domain'
  );
}

export function parseLoadAlignments(readelfOutput) {
  return readelfOutput
    .split('\n')
    .filter((line) => /^\s*LOAD\s/.test(line))
    .map((line) => Number.parseInt(line.trim().split(/\s+/).at(-1), 16));
}

export function validateRelroAlignment(programHeaders, minimumAlignment) {
  const segments = programHeaders.split('\n').filter((line) => /^\s*GNU_RELRO\s/.test(line));
  invariant(segments.length > 0, 'Native library has no GNU_RELRO protection segment');
  for (const segment of segments) {
    const fields = segment.trim().split(/\s+/);
    invariant(
      /^0x[0-9a-f]+$/i.test(fields[2] ?? '') && /^0x[0-9a-f]+$/i.test(fields[5] ?? ''),
      'Malformed GNU_RELRO program header'
    );
    const end = BigInt(fields[2]) + BigInt(fields[5]);
    invariant(
      end % BigInt(minimumAlignment) === 0n,
      `GNU_RELRO end is not aligned to ${minimumAlignment / 1024} KiB pages`
    );
  }
}

export function minimumElfPageAlignment(archivePath) {
  return /^lib\/(?:arm64-v8a|x86_64)\//.test(archivePath) ? 0x4000 : 0x1000;
}

function resourcePath(resources, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return resources.match(
    new RegExp(`resource 0x[0-9a-f]+ ${escaped}\\s+\\(\\) \\(file\\) (\\S+) type=XML`)
  )?.[1];
}

export function assertNoSensitiveContent(label, bytes) {
  const text = bytes.toString('latin1');
  for (const [kind, pattern] of SECRET_PATTERNS) {
    invariant(!pattern.test(text), `${label} contains a ${kind} or its build-time location`);
  }
}

function ndkReadelfPath(ndkRoot) {
  invariant(ndkRoot, 'Set NDK_HOME or ANDROID_NDK_HOME before auditing an APK');
  const host =
    process.platform === 'darwin'
      ? 'darwin-x86_64'
      : process.platform === 'linux'
        ? 'linux-x86_64'
        : 'windows-x86_64';
  return join(
    ndkRoot,
    'toolchains',
    'llvm',
    'prebuilt',
    host,
    'bin',
    process.platform === 'win32' ? 'llvm-readelf.exe' : 'llvm-readelf'
  );
}

async function auditNativeLibraries(archivePath, nativeLibraries, environment) {
  invariant(nativeLibraries.length > 0, 'Android package has no native library');
  const auditDirectory = await mkdtemp(join(tmpdir(), 'garden-android-audit-'));
  try {
    const readelf = ndkReadelfPath(environment.NDK_HOME ?? environment.ANDROID_NDK_HOME);
    for (const entry of nativeLibraries) {
      const bytes = await archiveEntry(archivePath, entry);
      assertNoSensitiveContent(entry, bytes);
      const extractedPath = join(auditDirectory, basename(entry));
      await writeFile(extractedPath, bytes, { mode: 0o600 });
      const { stdout: programHeaders } = await command(readelf, ['-lW', extractedPath]);
      const alignments = parseLoadAlignments(programHeaders);
      invariant(alignments.length > 0, `${entry} has no ELF LOAD segments`);
      const abiPath = entry.replace(/^base\//, '');
      const minimumAlignment = minimumElfPageAlignment(abiPath);
      invariant(
        alignments.every((alignment) => alignment >= minimumAlignment),
        `${entry} does not satisfy Android's ${minimumAlignment / 1024} KiB ELF page alignment requirement`
      );
      validateRelroAlignment(programHeaders, minimumAlignment);
    }
  } finally {
    await rm(auditDirectory, { recursive: true, force: true });
  }
}

export async function verifyAndroidApk(
  apkPath,
  { allowUnsigned = false, expectedAbis = [], environment = process.env } = {}
) {
  const resolvedApk = resolve(apkPath);
  const details = await stat(resolvedApk);
  invariant(details.isFile(), `Android artifact is not a file: ${resolvedApk}`);
  invariant(details.size < 300 * 1024 * 1024, 'Android artifact is unexpectedly large');

  const sdkRoot = environment.ANDROID_HOME ?? environment.ANDROID_SDK_ROOT;
  const buildTools = await latestBuildTools(sdkRoot);
  const executableSuffix = process.platform === 'win32' ? '.exe' : '';
  const aapt2 = join(buildTools, `aapt2${executableSuffix}`);
  const apksigner = join(buildTools, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
  const zipalign = join(buildTools, `zipalign${executableSuffix}`);

  const { stdout: badging } = await command(aapt2, ['dump', 'badging', resolvedApk]);
  const parsed = parseBadging(badging);
  const tauri = JSON.parse(
    await readFile(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf8')
  );
  invariant(parsed.packageName === 'org.garden.ai', 'Android package identifier changed');
  invariant(parsed.versionName === tauri.version, 'Android and Tauri versions do not match');
  invariant(/^[1-9]\d*$/.test(parsed.versionCode ?? ''), 'Android versionCode is not positive');
  invariant(parsed.minSdk === '26', 'Android minSdk must remain 26');
  invariant(parsed.targetSdk === '36', 'Android targetSdk must remain 36');
  invariant(
    equalSets(stringSet(parsed.permissions), EXPECTED_PERMISSIONS),
    `Android permissions changed: ${parsed.permissions.join(', ')}`
  );
  if (expectedAbis.length > 0) {
    invariant(
      equalSets(stringSet(parsed.abis), stringSet(expectedAbis)),
      `Android ABIs do not match the requested build: ${parsed.abis.join(', ')}`
    );
  }

  const { stdout: manifest } = await command(aapt2, [
    'dump',
    'xmltree',
    resolvedApk,
    '--file',
    'AndroidManifest.xml'
  ]);
  validateManifestTree(manifest);
  const { stdout: resources } = await command(aapt2, ['dump', 'resources', resolvedApk]);
  for (const [resource, validator] of [
    ['xml/network_security_config', validateNetworkSecurity],
    ['xml/backup_rules', (contents) => validateBackupRules(contents, true)],
    ['xml/backup_rules_legacy', (contents) => validateBackupRules(contents, false)]
  ]) {
    const path = resourcePath(resources, resource);
    invariant(path, `Android package is missing ${resource}`);
    const { stdout } = await command(aapt2, ['dump', 'xmltree', resolvedApk, '--file', path]);
    validator(stdout);
  }

  await command(zipalign, ['-c', '-P', '16', '-v', '4', resolvedApk]);
  const signature = await command(
    apksigner,
    ['verify', '--verbose', '--print-certs', resolvedApk],
    { allowFailure: true }
  );
  if (!allowUnsigned) {
    invariant(signature.code === 0, 'Android release artifact is not signed');
  } else if (signature.code !== 0) {
    invariant(
      /DOES NOT VERIFY|Missing META-INF/i.test(`${signature.stdout}\n${signature.stderr}`),
      'Android artifact signature verification failed for a reason other than being unsigned'
    );
  }

  const entries = await archiveEntries(resolvedApk);
  const nativeLibraries = entries.filter((entry) => /^lib\/[^/]+\/[^/]+\.so$/.test(entry));
  await auditNativeLibraries(resolvedApk, nativeLibraries, environment);

  const apkBytes = await readFile(resolvedApk);
  assertNoSensitiveContent('Android package', apkBytes);
  const digest = createHash('sha256').update(apkBytes).digest('hex');
  console.log(
    `Verified Android APK ${basename(resolvedApk)}: ${parsed.abis.join(', ')}, ` +
      `16 KiB package and 64-bit ELF aligned, ` +
      `${signature.code === 0 ? 'signed' : 'unsigned test artifact'}, sha256 ${digest}`
  );
  return { ...parsed, digest, signed: signature.code === 0 };
}

export async function verifyAndroidBundle(
  bundlePath,
  { allowUnsigned = false, expectedAbis = [], environment = process.env } = {}
) {
  const resolvedBundle = resolve(bundlePath);
  const details = await stat(resolvedBundle);
  invariant(details.isFile(), `Android app bundle is not a file: ${resolvedBundle}`);
  invariant(details.size < 350 * 1024 * 1024, 'Android app bundle is unexpectedly large');

  const entries = await archiveEntries(resolvedBundle);
  for (const required of [
    'BundleConfig.pb',
    'base/manifest/AndroidManifest.xml',
    'base/assets/tauri.conf.json',
    'base/res/xml/network_security_config.xml',
    'base/res/xml/backup_rules.xml',
    'base/res/xml/backup_rules_legacy.xml'
  ]) {
    invariant(entries.includes(required), `Android app bundle is missing ${required}`);
  }
  const nativeLibraries = entries.filter((entry) => /^base\/lib\/[^/]+\/[^/]+\.so$/.test(entry));
  const abis = stringSet(nativeLibraries.map((entry) => entry.match(/^base\/lib\/([^/]+)\//)?.[1]));
  if (expectedAbis.length > 0) {
    invariant(
      equalSets(abis, stringSet(expectedAbis)),
      `Android app bundle ABIs do not match the requested build: ${[...abis].join(', ')}`
    );
  }

  const embeddedConfig = JSON.parse(
    (await archiveEntry(resolvedBundle, 'base/assets/tauri.conf.json')).toString('utf8')
  );
  const sourceConfig = JSON.parse(
    await readFile(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf8')
  );
  invariant(embeddedConfig.identifier === 'org.garden.ai', 'Android bundle identifier changed');
  invariant(
    embeddedConfig.version === sourceConfig.version,
    'Android bundle and Tauri versions do not match'
  );
  invariant(
    embeddedConfig.app?.withGlobalTauri === false &&
      embeddedConfig.app?.security?.csp === sourceConfig.app?.security?.csp,
    'Android bundle embedded an unsafe Tauri configuration'
  );

  await auditNativeLibraries(resolvedBundle, nativeLibraries, environment);
  const jarsigner =
    environment.JAVA_HOME && process.platform === 'win32'
      ? join(environment.JAVA_HOME, 'bin', 'jarsigner.exe')
      : environment.JAVA_HOME
        ? join(environment.JAVA_HOME, 'bin', 'jarsigner')
        : process.platform === 'win32'
          ? 'jarsigner.exe'
          : 'jarsigner';
  const signature = await command(jarsigner, ['-verify', '-verbose', '-certs', resolvedBundle], {
    allowFailure: true
  });
  const signatureOutput = `${signature.stdout}\n${signature.stderr}`;
  const signed = signature.code === 0 && /\bjar verified\./i.test(signatureOutput);
  if (!allowUnsigned) {
    invariant(signed, 'Android app bundle is not signed');
  } else if (!signed) {
    invariant(
      /\bjar is unsigned\./i.test(signatureOutput),
      'Android app bundle signature verification failed for a reason other than being unsigned'
    );
  }

  const bundleBytes = await readFile(resolvedBundle);
  assertNoSensitiveContent('Android app bundle', bundleBytes);
  const digest = createHash('sha256').update(bundleBytes).digest('hex');
  console.log(
    `Verified Android app bundle ${basename(resolvedBundle)}: ${[...abis].join(', ')}, ` +
      `64-bit ELF aligned, ${signed ? 'signed' : 'unsigned test artifact'}, sha256 ${digest}`
  );
  return { abis: [...abis], digest, signed };
}

function parseCli(argumentsForCli) {
  const apkPath = argumentsForCli[0];
  let allowUnsigned = false;
  let expectedAbis = [];
  let bundle = false;
  for (let index = 1; index < argumentsForCli.length; index += 1) {
    const argument = argumentsForCli[index];
    if (argument === '--allow-unsigned') allowUnsigned = true;
    else if (argument === '--bundle') bundle = true;
    else if (argument === '--expected-abis') {
      expectedAbis = (argumentsForCli[index + 1] ?? '').split(',').filter(Boolean);
      index += 1;
    } else {
      throw new Error(`Unknown Android artifact audit option: ${argument}`);
    }
  }
  invariant(
    apkPath,
    'Usage: verify-android-artifact.mjs APK [--allow-unsigned] [--expected-abis list]'
  );
  return { apkPath, allowUnsigned, expectedAbis, bundle };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseCli(process.argv.slice(2));
  if (options.bundle) await verifyAndroidBundle(options.apkPath, options);
  else await verifyAndroidApk(options.apkPath, options);
}
