import { describe, expect, it } from 'vitest';
import { newerVersion, nativeUpdateAvailable } from './UpdateNotice.js';

describe('native version notices', () => {
  it('compares numeric release versions without prompting for older or unrecognized builds', () => {
    expect(newerVersion('0.10.0', '0.9.0')).toBe(true);
    expect(newerVersion('1.0.0', '0.99.99')).toBe(true);
    expect(newerVersion('0.2.0', '0.2.0')).toBe(false);
    expect(newerVersion('0.2.0', '0.3.0')).toBe(false);
    expect(newerVersion('not-a-version', '0.2.0')).toBe(false);
    expect(newerVersion('0.3.0', 'unknown')).toBe(false);
  });
  it('offers a different published source build only to the same beta version with known identities', () => {
    const revision = 'a'.repeat(40);
    const release = {
      version: '0.2.0',
      revision,
      url: 'https://github.com/ouaeic/garden/releases'
    };
    const client = {
      appVersion: '0.2.0',
      appRevision: 'b'.repeat(40),
      appChannel: 'beta' as const
    };
    expect(nativeUpdateAvailable(release, client)).toBe(true);
    expect(nativeUpdateAvailable(release, { ...client, appRevision: revision })).toBe(false);
    expect(nativeUpdateAvailable(release, { ...client, appChannel: 'stable' })).toBe(false);
    expect(nativeUpdateAvailable(release, { appVersion: '0.2.0', appChannel: 'beta' })).toBe(false);
    expect(nativeUpdateAvailable({ ...release, version: '0.1.0' }, client)).toBe(false);
    expect(nativeUpdateAvailable({ ...release, revision: 'unknown' }, client)).toBe(false);
  });
});
