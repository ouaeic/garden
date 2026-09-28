import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNoMacSensitiveContent, validateMacInfo } from './verify-macos-artifact.mjs';

function validInfo() {
  return {
    CFBundleIdentifier: 'org.garden.ai',
    CFBundleName: 'garden',
    CFBundleShortVersionString: '0.1.0',
    CFBundleVersion: '1',
    CFBundleExecutable: 'garden-desktop',
    LSMinimumSystemVersion: '12.0',
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

test('requires exact macOS identity, pairing, transport, discovery, and privacy policy', () => {
  assert.doesNotThrow(() => validateMacInfo(validInfo(), '0.1.0'));
  const broadTransport = validInfo();
  broadTransport.NSAppTransportSecurity.NSAllowsArbitraryLoads = true;
  assert.throws(() => validateMacInfo(broadTransport, '0.1.0'));
  const broadDomain = validInfo();
  broadDomain.NSAppTransportSecurity.NSExceptionDomains['example.com'] = {};
  assert.throws(() => validateMacInfo(broadDomain, '0.1.0'));
});

test('pins the macOS deployment floor rather than accepting any newer one', () => {
  for (const version of ['10.13', '11.0', '13.0']) {
    const drifted = validInfo();
    drifted.LSMinimumSystemVersion = version;
    assert.throws(() => validateMacInfo(drifted, '0.1.0'));
  }
});

test('distinguishes parser labels from complete private keys in macOS artifacts', () => {
  assert.doesNotThrow(() =>
    assertNoMacSensitiveContent(
      'parser',
      Buffer.from('-----BEGIN OPENSSH PRIVATE KEY----------BEGIN PRIVATE KEY-----')
    )
  );
  const body = Buffer.from('private key material must never ship').toString('base64').repeat(4);
  assert.throws(() =>
    assertNoMacSensitiveContent(
      'fixture',
      Buffer.from(`-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`)
    )
  );
});
