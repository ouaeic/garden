import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNativeBinaries } from './check-native-binary.mjs';
import { withReleaseRustFlags } from './release-build-env.mjs';
import { withReleaseSwiftTools } from './release-swift-env.mjs';
import { verifyAndroidApk, verifyAndroidBundle } from './verify-android-artifact.mjs';
import { verifyIosIpa } from './verify-ios-artifact.mjs';

const desktopDirectory = dirname(fileURLToPath(import.meta.url));
const platform = process.argv[2];
if (platform !== 'android' && platform !== 'ios') {
  throw new Error('The native mobile build platform must be android or ios');
}

const environment = withReleaseRustFlags(process.env, platform);
if (!environment.GRADLE_USER_HOME && environment.CARGO_TARGET_DIR) {
  environment.GRADLE_USER_HOME = resolve(environment.CARGO_TARGET_DIR, '..', 'gradle-home');
}
const platformArguments = process.argv.slice(3);
const tauriCli = resolve(desktopDirectory, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const argumentsForTauri = [tauriCli, platform, 'build', ...platformArguments];

const swiftTools = platform === 'ios' ? await withReleaseSwiftTools(environment) : null;
let exitCode;
try {
  exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, argumentsForTauri, {
      cwd: desktopDirectory,
      env: swiftTools?.environment ?? environment,
      stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Tauri ${platform} build terminated by ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
} finally {
  await swiftTools?.dispose();
}

if (exitCode !== 0) process.exit(exitCode);

const targetRoot = resolve(
  environment.CARGO_TARGET_DIR ?? resolve(desktopDirectory, 'src-tauri', 'target')
);
await checkNativeBinaries(targetRoot, environment, platform);

async function newestMobileArtifact(directory, suffix, missingMessage) {
  const candidates = [];
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith(suffix) && !path.split(/[\\/]/).includes('debug')) {
        candidates.push({ path, modified: (await stat(path)).mtimeMs });
      }
    }
  }
  await visit(directory);
  candidates.sort((left, right) => right.modified - left.modified);
  if (candidates.length === 0) throw new Error(missingMessage);
  return candidates[0].path;
}

function requestedAndroidAbis(argumentsForPlatform) {
  const aliases = {
    aarch64: 'arm64-v8a',
    armv7: 'armeabi-v7a',
    i686: 'x86',
    x86_64: 'x86_64'
  };
  const index = argumentsForPlatform.indexOf('--target');
  if (index < 0) return Object.values(aliases);
  const targets = [];
  for (const value of argumentsForPlatform.slice(index + 1)) {
    if (value.startsWith('-')) break;
    if (!aliases[value]) throw new Error(`Unsupported Android target requested: ${value}`);
    targets.push(aliases[value]);
  }
  return targets;
}

if (platform === 'android') {
  const options = {
    allowUnsigned: environment.GARDEN_ANDROID_REQUIRE_SIGNED !== '1',
    expectedAbis: requestedAndroidAbis(platformArguments),
    environment
  };
  if (platformArguments.includes('--apk')) {
    const apk = await newestMobileArtifact(
      resolve(desktopDirectory, 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'apk'),
      '.apk',
      'The Android build produced no release APK'
    );
    await verifyAndroidApk(apk, options);
  }
  if (platformArguments.includes('--aab')) {
    const bundle = await newestMobileArtifact(
      resolve(desktopDirectory, 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'bundle'),
      '.aab',
      'The Android build produced no release app bundle'
    );
    await verifyAndroidBundle(bundle, options);
  }
}

const exportsIosArchive = platformArguments.some(
  (argument) => argument === '--export-method' || argument.startsWith('--export-method=')
);
if (platform === 'ios' && exportsIosArchive) {
  const ipa = await newestMobileArtifact(
    resolve(desktopDirectory, 'src-tauri', 'gen', 'apple', 'build'),
    '.ipa',
    'The iOS build produced no release IPA'
  );
  await verifyIosIpa(ipa);
}
