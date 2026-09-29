import { describe, expect, it, vi } from 'vitest';
import { createUpdateChecker } from './updates.js';

const revision = 'a'.repeat(40);
const requestUrl = (input: Parameters<typeof fetch>[0]): string =>
  input instanceof Request ? input.url : input.toString();
const fetcher = (status = 'ahead') =>
  vi.fn<typeof fetch>(async (input) =>
    requestUrl(input).includes('/commits/')
      ? Response.json({ sha: revision })
      : requestUrl(input).includes('/compare/')
        ? Response.json({ status })
        : Response.json([
            {
              tag_name: 'v0.3.0',
              draft: false,
              prerelease: false,
              assets: [{ name: 'garden.apk' }]
            }
          ])
  );

describe('update discovery', () => {
  it('coalesces device requests and caches catalogue checks', async () => {
    const fetch = fetcher();
    const check = createUpdateChecker('1234567', fetch);
    const [first, second] = await Promise.all([check(), check()]);
    expect(first).toEqual(second);
    expect(first.server).toEqual({ status: 'available', revision });
    expect(first.client).toEqual({
      version: '0.3.0',
      revision: null,
      url: 'https://github.com/ouaeic/garden/releases/tag/v0.3.0'
    });
    expect(await check()).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [url, options] of fetch.mock.calls) {
      expect(requestUrl(url)).toMatch(/^https:\/\/api.github.com\/repos\/ouaeic\/garden\//);
      expect(options?.redirect).toBe('error');
      expect(options?.headers).not.toHaveProperty('authorization');
    }
  });
  it.each(['identical', 'behind'])(
    'does not suggest a downgrade when upstream is %s',
    async (status) => {
      expect((await createUpdateChecker('1234567', fetcher(status))()).server.status).toBe(
        'current'
      );
    }
  );
  it('reports an unreachable catalogue and a fork as unknown', async () => {
    expect((await createUpdateChecker('1234567', fetcher('diverged'))()).server.status).toBe(
      'unknown'
    );
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('offline'));
    const result = await createUpdateChecker('1234567', fetch)();
    expect(result.server.status).toBe('unknown');
    expect(result.client).toBeNull();
  });
  it('never follows catalogue-provided links or announces drafts and source-only releases', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json([
        { tag_name: 'v9.0.0', draft: true, prerelease: false, assets: [{ name: 'garden.apk' }] },
        { tag_name: 'v8.0.0', draft: false, prerelease: false, assets: [] },
        {
          tag_name: `beta-0.2.0-${revision}`,
          draft: false,
          prerelease: true,
          assets: [{ name: 'garden.apk' }],
          html_url: 'https://untrusted.example/'
        }
      ])
    );
    const result = await createUpdateChecker(null, fetch)();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.client?.url).toBe(
      `https://github.com/ouaeic/garden/releases/tag/beta-0.2.0-${revision}`
    );
    expect(result.server.status).toBe('unknown');
  });
});
