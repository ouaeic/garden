import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chooseLocalFolder,
  enrollmentCodeFromFragment,
  localInstallerUrl,
  nativeCapabilities,
  nativeNotificationPermission,
  nativeStatus,
  openPreviewBrowser,
  pairNative,
  previewConnectionTicket,
  readLocalFile,
  requestNativeNotifications
} from './native.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const now = Date.UTC(2026, 8, 6);
const packet = {
  version: 2,
  identity: `sha256/${btoa('a'.repeat(32))}`,
  endpoints: ['https://computer.example:443'],
  discovery: { mdnsService: '_garden._tcp.local', mdnsPort: 443 },
  pairingCode: 'a-one-time-code-123456789',
  expiresAt: Math.floor(now / 1000) + 300
};
const ticket = (changes: Record<string, unknown> = {}) =>
  `garden://pair/${btoa(JSON.stringify({ ...packet, ...changes }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')}`;

describe('native connection boundaries', () => {
  it('rejects an unrelated pairing scheme', () => {
    expect(() => previewConnectionTicket(ticket().replace('garden:', 'https:'), now)).toThrow();
  });
  it('reads a camera-opened enrollment fragment only on its intended server before expiry', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const fragment = `#pair=${ticket().replace('garden://pair/', '')}`;
    expect(enrollmentCodeFromFragment(fragment, 'https://computer.example')).toBe(
      packet.pairingCode
    );
    expect(enrollmentCodeFromFragment(fragment, 'https://different.example')).toBeNull();
    expect(enrollmentCodeFromFragment(fragment, 'http://computer.example')).toBeNull();
    expect(
      enrollmentCodeFromFragment(fragment + '&extra=value', 'https://computer.example')
    ).toBeNull();
    expect(enrollmentCodeFromFragment('#pair=broken', 'https://computer.example')).toBeNull();
    vi.setSystemTime(now + 300_000);
    expect(enrollmentCodeFromFragment(fragment, 'https://computer.example')).toBeNull();
  });
  it('previews the identity and canonical endpoints without exposing the enrollment secret', () => {
    const result = previewConnectionTicket(ticket(), now);
    expect(result).toEqual({
      identity: packet.identity,
      endpoints: ['https://computer.example'],
      expiresAt: packet.expiresAt
    });
    expect(JSON.stringify(result)).not.toContain(packet.pairingCode);
  });
  it('rejects expired, oversized and altered tickets before any gateway request', async () => {
    expect(() =>
      previewConnectionTicket(ticket({ expiresAt: Math.floor(now / 1000) }), now)
    ).toThrow('expired');
    expect(() => previewConnectionTicket(`garden://pair/${'a'.repeat(32768)}`, now)).toThrow(
      'large'
    );
    const invalid = [
      { version: 1 },
      { identity: 'sha256/wrong' },
      { identity: packet.identity.slice(0, -2) + 'B=' },
      { endpoints: [] },
      { endpoints: ['http://computer.example'] },
      { endpoints: ['https://secret@computer.example'] },
      { endpoints: ['https://computer.example:444'] },
      { endpoints: ['https://computer.example/path'] },
      { endpoints: ['https://computer.example?secret=yes'] },
      { endpoints: Array(17).fill('https://computer.example') },
      { discovery: { mdnsService: '_other._tcp.local', mdnsPort: 443 } },
      { pairingCode: 'short' },
      { execute: 'an untrusted instruction' }
    ];
    expect(invalid.length).toBeGreaterThan(0);
    for (const value of invalid)
      expect(() => previewConnectionTicket(ticket(value), now)).toThrow();
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    await expect(pairNative('https://unexpected.example')).rejects.toThrow('complete');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps credential entry on the separate credential-free localhost installer origin', () => {
    expect(localInstallerUrl('http://localhost:34567')).toBe('http://localhost:34567/');
    const invalid = [
      'https://remote.example',
      'http://localhost',
      'http://localhost.evil:1234',
      'http://127.0.0.1:1234',
      'http://user@localhost:1234',
      'http://localhost:1234/path',
      'http://localhost:1234?password=secret',
      'http://localhost:1234/#bad',
      'javascript:alert(1)'
    ];
    expect(invalid.length).toBeGreaterThan(0);
    for (const value of invalid) expect(localInstallerUrl(value)).toBeNull();
  });
  it('does not contact native routes or manufacture capabilities in a browser', async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('window', {});
    expect(await nativeStatus()).toBeNull();
    expect(await nativeCapabilities()).toBeNull();
    await expect(chooseLocalFolder()).rejects.toMatchObject({ code: 'native_unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('pairs through the verified gateway, saves the network preference and obtains enrollment once', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (path) => {
      if (typeof path === 'string' && path.endsWith('/bootstrap'))
        return Response.json({
          pairingCode: 'new-enrollment',
          installerUrl: 'http://localhost:34678'
        });
      return Response.json({ connected: true, saved: true });
    });
    vi.stubGlobal('fetch', fetcher);
    const raw = ticket({ expiresAt: Math.floor(Date.now() / 1000) + 300 });
    expect(await pairNative(raw, 'dynamic')).toEqual({
      pairingCode: 'new-enrollment',
      installerUrl: 'http://localhost:34678/'
    });
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      '/__garden/client/pair',
      '/__garden/client/network-preference',
      '/__garden/client/bootstrap'
    ]);
    expect(fetcher.mock.calls[0]![1]?.body).toBe(JSON.stringify({ ticket: raw }));
    expect(fetcher.mock.calls[1]![1]?.body).toBe(JSON.stringify({ preference: 'dynamic' }));
  });
  it('opens the original signed preview through the native owner command and propagates refusal', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
    const signed =
      'https://garden.test:8443/__garden/preview/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/?access=fixture%2Fgrant%3D#scene';
    await openPreviewBrowser(signed);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('open_preview_browser', { url: signed });
    invoke.mockRejectedValueOnce(new Error('Preview origin unavailable'));
    await expect(openPreviewBrowser(signed)).rejects.toThrow('Preview origin unavailable');
  });

  it('uses the shell bridge and folder grant tokens; notification permission remains explicit', async () => {
    const invoke = vi.fn().mockImplementation(async (command: string) => {
      if (command === 'native_capabilities')
        return { folderPicker: true, notifications: true, downloads: true, deepLinkEvents: false };
      if (command === 'read_local_file') return [65, 66];
      if (command.endsWith('is_permission_granted')) return false;
      if (command.endsWith('request_permission')) return 'denied';
      return null;
    });
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
    expect(await readLocalFile('grant-token', 'notes/a.txt')).toEqual(new Uint8Array([65, 66]));
    expect(invoke).toHaveBeenCalledWith('read_local_file', {
      token: 'grant-token',
      relative: 'notes/a.txt'
    });
    expect(await nativeNotificationPermission()).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith('plugin:notification|request_permission', undefined);
    expect(await requestNativeNotifications()).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith('plugin:notification|notify', expect.anything());
  });
});
