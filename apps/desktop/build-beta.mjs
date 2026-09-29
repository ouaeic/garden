import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const platform = process.argv[2];
if (!['desktop', 'android'].includes(platform)) throw new Error('Choose desktop or android');
const environment = { ...process.env };
environment.GARDEN_BUILD_CHANNEL = 'beta';
environment.GARDEN_SOURCE_COMMIT = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
  cwd: directory,
  encoding: 'utf8'
}).trim();
if (platform === 'android') {
  const signingNames = [
    'GARDEN_ANDROID_KEYSTORE',
    'GARDEN_ANDROID_KEYSTORE_PASSWORD',
    'GARDEN_ANDROID_KEY_ALIAS',
    'GARDEN_ANDROID_KEY_PASSWORD'
  ];
  const configured = signingNames.filter((name) => environment[name]);
  if (configured.length && configured.length !== signingNames.length)
    throw new Error('Provide all Android signing values; a partial configuration cannot be used.');
  if (!configured.length) {
    if (environment.CI)
      throw new Error(
        'Set the GARDEN_ANDROID_* repository secrets. Android signing needs a persistent key, not an app-store account.'
      );
    const signingDirectory = resolve(directory, '../../.garden/beta-signing');
    mkdirSync(signingDirectory, { recursive: true, mode: 0o700 });
    const passwordFile = resolve(signingDirectory, 'android-password');
    const keystore = resolve(signingDirectory, 'android.jks');
    if (!existsSync(keystore)) {
      if (!existsSync(passwordFile))
        writeFileSync(passwordFile, randomBytes(32).toString('hex'), { mode: 0o600 });
      const keytool = environment.JAVA_HOME
        ? resolve(environment.JAVA_HOME, 'bin/keytool')
        : 'keytool';
      execFileSync(
        keytool,
        [
          '-genkeypair',
          '-keystore',
          keystore,
          '-storetype',
          'JKS',
          '-alias',
          'garden-beta',
          '-keyalg',
          'RSA',
          '-keysize',
          '3072',
          '-validity',
          '10000',
          '-dname',
          'CN=garden beta,O=garden',
          '-storepass:file',
          passwordFile,
          '-keypass:file',
          passwordFile
        ],
        { stdio: 'pipe' }
      );
    }
    const password = readFileSync(passwordFile, 'utf8').trim();
    chmodSync(keystore, 0o600);
    Object.assign(environment, {
      GARDEN_ANDROID_KEYSTORE: keystore,
      GARDEN_ANDROID_KEYSTORE_PASSWORD: password,
      GARDEN_ANDROID_KEY_ALIAS: 'garden-beta',
      GARDEN_ANDROID_KEY_PASSWORD: password
    });
    console.log(
      'Using the persistent local Android beta key. Back up .garden/beta-signing privately; updates need the same key.'
    );
  }
  environment.GARDEN_ANDROID_REQUIRE_SIGNED = '1';
} else if (process.platform === 'darwin') {
  environment.APPLE_SIGNING_IDENTITY = '-';
  for (const key of [
    'APPLE_CERTIFICATE',
    'APPLE_CERTIFICATE_PASSWORD',
    'APPLE_ID',
    'APPLE_PASSWORD',
    'APPLE_TEAM_ID',
    'APPLE_API_KEY',
    'APPLE_API_ISSUER',
    'APPLE_API_KEY_PATH'
  ])
    delete environment[key];
}
const result = spawnSync(
  process.execPath,
  [
    resolve(directory, platform === 'android' ? 'build-mobile.mjs' : 'build-native.mjs'),
    ...(platform === 'android' ? ['android', '--apk'] : []),
    ...process.argv.slice(3)
  ],
  { cwd: directory, env: environment, stdio: 'inherit' }
);
if (result.error) throw result.error;
if (result.signal) throw new Error(`Beta build stopped by ${result.signal}`);
process.exit(result.status ?? 1);
