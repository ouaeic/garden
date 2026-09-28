import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertNoIosSensitiveContent,
  isSafeArchivePath,
  validateIosInfo
} from './verify-ios-artifact.mjs';

function validInfo() {
  return {
    CFBundleIdentifier: 'org.garden.ai',
    CFBundleName: 'garden',
    CFBundleShortVersionString: '0.1.0',
    CFBundleVersion: '1',
    CFBundleExecutable: 'garden',
    MinimumOSVersion: '15.0',
    CFBundleURLTypes: [{ CFBundleURLSchemes: ['garden'] }],
    NSAppTransportSecurity: {
      NSExceptionDomains: {
        localhost: {
          NSExceptionAllowsInsecureHTTPLoads: true,
          NSIncludesSubdomains: false
        }
      }
    },
    NSBonjourServices: ['_garden._tcp'],
    NSCameraUsageDescription: 'Used only when the person attaches a camera photo.',
    NSLocalNetworkUsageDescription: 'Used only to rediscover the paired remote computer.',
    NSMicrophoneUsageDescription: 'Used only when the person records a voice note.',
    NSPhotoLibraryUsageDescription: 'Used only for photos the person explicitly chooses.'
  };
}

test('accepts only safe IPA archive paths', () => {
  assert.equal(isSafeArchivePath('Payload/garden.app/Info.plist'), true);
  assert.equal(isSafeArchivePath('../escape'), false);
  assert.equal(isSafeArchivePath('/absolute'), false);
  assert.equal(isSafeArchivePath('C:\\escape'), false);
});

test('requires exact iOS identity, pairing, transport, discovery, and privacy policy', () => {
  assert.doesNotThrow(() => validateIosInfo(validInfo(), '0.1.0'));
  const broadTransport = validInfo();
  broadTransport.NSAppTransportSecurity.NSAllowsArbitraryLoads = true;
  assert.throws(() => validateIosInfo(broadTransport, '0.1.0'));
  const broadDomain = validInfo();
  broadDomain.NSAppTransportSecurity.NSExceptionDomains['example.com'] = {};
  assert.throws(() => validateIosInfo(broadDomain, '0.1.0'));
});

test('pins the iOS deployment floor rather than accepting any newer one', () => {
  for (const version of ['14.0', '16.0', '26.0']) {
    const drifted = validInfo();
    drifted.MinimumOSVersion = version;
    assert.throws(() => validateIosInfo(drifted, '0.1.0'));
  }
});

test('distinguishes parser labels from complete private keys', () => {
  assert.doesNotThrow(() =>
    assertNoIosSensitiveContent(
      'parser',
      Buffer.from('-----BEGIN OPENSSH PRIVATE KEY----------BEGIN PRIVATE KEY-----')
    )
  );
  const body = Buffer.from('private key material must never ship').toString('base64').repeat(4);
  assert.throws(() =>
    assertNoIosSensitiveContent(
      'fixture',
      Buffer.from(`-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`)
    )
  );
});
