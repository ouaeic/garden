import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertNoSensitiveContent,
  minimumElfPageAlignment,
  parseBadging,
  parseLoadAlignments,
  validateBackupRules,
  validateRelroAlignment,
  validateNetworkSecurity
} from './verify-android-artifact.mjs';

test('parses the release identity and ABI boundary from aapt badging', () => {
  assert.deepEqual(
    parseBadging(`package: name='org.garden.ai' versionCode='1000' versionName='0.1.0'
minSdkVersion:'26'
targetSdkVersion:'36'
uses-permission: name='android.permission.INTERNET'
native-code: 'arm64-v8a' 'x86_64'
`),
    {
      packageName: 'org.garden.ai',
      versionCode: '1000',
      versionName: '0.1.0',
      minSdk: '26',
      targetSdk: '36',
      permissions: ['android.permission.INTERNET'],
      abis: ['arm64-v8a', 'x86_64']
    }
  );
});

test('accepts only one exact localhost cleartext exception', () => {
  const valid = `E: network-security-config
  E: base-config
    A: cleartextTrafficPermitted=false
  E: domain-config
    A: cleartextTrafficPermitted=true
    E: domain
      A: includeSubdomains=false
      T: 'localhost'`;
  assert.doesNotThrow(() => validateNetworkSecurity(valid));
  assert.throws(() => validateNetworkSecurity(valid.replace('localhost', 'example.com')));
  assert.throws(() => validateNetworkSecurity(`${valid}\nT: 'localhost.local'`));
});

test('requires every storage domain to be excluded from both modern backup modes', () => {
  const domains = [
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
  const excludes = domains.map((domain) => `A: domain="${domain}"\nA: path="."`).join('\n');
  const valid = `E: cloud-backup\n${excludes}\nE: device-transfer\n${excludes}`;
  assert.doesNotThrow(() => validateBackupRules(valid, true));
  assert.throws(() => validateBackupRules(valid.replace('domain="root"', 'domain="file"'), true));
});

test('reads every ELF load alignment', () => {
  assert.deepEqual(
    parseLoadAlignments(`Type Offset Align
LOAD 0x000 0x000 R E 0x4000
LOAD 0x100 0x100 RW 0x4000
NOTE 0x200 0x200 R 0x4`),
    [0x4000, 0x4000]
  );
});

test('rejects missing, malformed or page-straddling RELRO protection even with aligned LOAD segments', () => {
  const valid = '  GNU_RELRO 0x0cfaf0 0x00000000000dfaf0 0x00000000000dfaf0 0x01510 0x00510 R 0x1';
  assert.doesNotThrow(() => validateRelroAlignment(valid, 0x4000));
  const invalid = valid.replace('0x00510', '0x01510');
  assert.throws(() => validateRelroAlignment(invalid, 0x4000), /not aligned/);
  assert.doesNotThrow(() => validateRelroAlignment(invalid, 0x1000));
  assert.throws(() => validateRelroAlignment('', 0x4000), /no GNU_RELRO/);
  assert.throws(() => validateRelroAlignment(valid.replace('0x00510', 'bad'), 0x4000), /Malformed/);
});

test('requires 16 KiB ELF pages only for Android 64-bit ABIs', () => {
  assert.equal(minimumElfPageAlignment('lib/arm64-v8a/libgarden.so'), 0x4000);
  assert.equal(minimumElfPageAlignment('lib/x86_64/libgarden.so'), 0x4000);
  assert.equal(minimumElfPageAlignment('lib/armeabi-v7a/libgarden.so'), 0x1000);
  assert.equal(minimumElfPageAlignment('lib/x86/libgarden.so'), 0x1000);
});

test('distinguishes private-key parser constants from embedded private-key material', () => {
  assert.doesNotThrow(() =>
    assertNoSensitiveContent(
      'parser library',
      Buffer.from(
        '-----BEGIN OPENSSH PRIVATE KEY----------BEGIN ENCRYPTED PRIVATE KEY-----',
        'utf8'
      )
    )
  );
  const body = Buffer.from('private key material must never ship').toString('base64').repeat(4);
  assert.throws(() =>
    assertNoSensitiveContent(
      'leaked fixture',
      Buffer.from(
        `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----`,
        'utf8'
      )
    )
  );
});
