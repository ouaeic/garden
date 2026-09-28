import { afterEach, describe, expect, it, vi } from 'vitest';
const origin = 'https://garden.test';
const path = '/__garden/preview/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.html?access=fixture#game';
const fixture = async (location = 'http://localhost:41000', marker = '1', advertised = origin) => {
  vi.resetModules();
  vi.stubGlobal('window', { location: new URL(location) });
  vi.stubGlobal('fetch', async () =>
    Response.json(
      {},
      {
        headers: {
          'x-garden-native-client': marker,
          'x-garden-server-origin': advertised
        }
      }
    )
  );
  const client = await import('./client');
  const { previewUrl } = await import('./preview-url');
  await client.get('/v1/bootstrap');
  return { ...client, previewUrl };
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
describe('native preview origin authority', () => {
  it('maps only an embedded preview from the pinned native server', async () => {
    const client = await fixture();
    expect(client.isNativeClient()).toBe(true);
    expect(client.nativeServerOrigin()).toBe(origin);
    expect(client.previewUrl(origin + path)).toBe(path);
    expect(client.previewUrl(origin + path, false)).toBe(origin + path);
    const distinct = [
      origin + ':8443' + path,
      'https://garden.test.evil' + path,
      origin + '/__garden/preview/other/',
      origin + '/v1/bootstrap'
    ];
    expect(distinct.length).toBeGreaterThan(0);
    for (const url of distinct) expect(client.previewUrl(url)).toBe(url);
  });
  it('cannot adopt native origin metadata from an ordinary web response', async () => {
    const client = await fixture('https://garden.test');
    expect(client.isNativeClient()).toBe(false);
    expect(client.nativeServerOrigin()).toBeNull();
    expect(client.previewUrl(origin + path)).toBe(origin + path);
  });
  it('requires the native marker before adopting a server origin', async () => {
    const client = await fixture('http://localhost:41000', '');
    expect(client.nativeServerOrigin()).toBeNull();
    expect(client.previewUrl(origin + path)).toBe(origin + path);
  });
  it.each([
    'https://garden.test/path',
    'https://name@garden.test',
    'http://garden.test',
    'invalid'
  ])('refuses malformed native metadata %s', async (advertised) => {
    const client = await fixture('http://localhost:41000', '1', advertised);
    expect(client.nativeServerOrigin()).toBeNull();
    expect(client.previewUrl(origin + path)).toBe(origin + path);
  });
  it('clears stale origin authority when the native connection omits its origin', async () => {
    const client = await fixture();
    expect(client.nativeServerOrigin()).toBe(origin);
    vi.stubGlobal('fetch', async () =>
      Response.json({}, { headers: { 'x-garden-native-client': '1' } })
    );
    await client.get('/v1/bootstrap');
    expect(client.nativeServerOrigin()).toBeNull();
    expect(client.previewUrl(origin + path)).toBe(origin + path);
  });
});

it('maps the configured native preview onto its own verified loopback origin', async () => {
  const client = await fixture();
  vi.stubGlobal('fetch', async () =>
    Response.json(
      {},
      {
        headers: {
          'x-garden-native-client': '1',
          'x-garden-server-origin': origin,
          'x-garden-preview-origin': origin + ':8443',
          'x-garden-preview-local-origin': 'http://localhost:41001'
        }
      }
    )
  );
  await client.get('/v1/bootstrap');
  const { previewIsolated } = await import('./preview-url');
  const remote = origin + ':8443' + path;
  expect(client.previewUrl(remote)).toBe('http://localhost:41001' + path);
  expect(previewIsolated(remote)).toBe(true);
  expect(previewIsolated(client.previewUrl(remote))).toBe(true);
  expect(previewIsolated(origin + path)).toBe(false);
  expect(previewIsolated('http://localhost:41000' + path)).toBe(false);
  expect(previewIsolated('http://localhost:41001/v1/bootstrap')).toBe(false);
  expect(client.previewUrl(remote, false)).toBe(remote);
  expect(client.previewUrl('https://other.test' + path)).toBe('https://other.test' + path);
  vi.stubGlobal('fetch', async () =>
    Response.json(
      {},
      {
        headers: {
          'x-garden-native-client': '1',
          'x-garden-server-origin': origin,
          'x-garden-preview-origin': origin + ':8443',
          'x-garden-preview-local-origin': 'http://localhost:41000'
        }
      }
    )
  );
  await client.get('/v1/bootstrap');
  expect(previewIsolated(remote)).toBe(false);
  expect(client.previewUrl(remote)).toBe(remote);
});

it('enables ordinary browser storage only across an actual preview origin boundary', async () => {
  await fixture(origin);
  const { previewIsolated } = await import('./preview-url');
  expect(previewIsolated(origin + ':8443' + path)).toBe(true);
  expect(previewIsolated(origin + path)).toBe(false);
  expect(previewIsolated('https://other.test/v1/bootstrap')).toBe(false);
  expect(previewIsolated('javascript:alert(1)')).toBe(false);
});
