import { z } from 'zod';

const REPOSITORY = 'https://api.github.com/repos/ouaeic/garden';
const DOWNLOADS = 'https://github.com/ouaeic/garden/releases';
const CHECK_INTERVAL = 6 * 60 * 60_000;

export interface UpdateReport {
  checkedAt: string;
  server: { status: 'current' | 'available' | 'unknown'; revision: string | null };
  client: { version: string; revision: string | null; url: string } | null;
}

const releases = z.array(
  z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    assets: z.array(z.object({ name: z.string() })).default([])
  })
);

/** A failed check is unknown; a fork or a development tree is never told to downgrade. */
export function createUpdateChecker(installed: string | null, fetcher: typeof fetch = fetch) {
  let cached: UpdateReport | null = null;
  let nextCheck = 0;
  let pending: Promise<UpdateReport> | null = null;
  const json = async (path: string) => {
    const response = await fetcher(`${REPOSITORY}${path}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'garden-update-check' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error('Update catalogue unavailable');
    const source = await response.text();
    if (source.length > 1_000_000) throw new Error('Update catalogue too large');
    return JSON.parse(source) as unknown;
  };
  return (): Promise<UpdateReport> => {
    if (cached && Date.now() < nextCheck) return Promise.resolve(cached);
    if (pending) return pending;
    pending = (async () => {
      const [server, client] = await Promise.all([
        (async (): Promise<UpdateReport['server']> => {
          if (!installed || !/^[a-f0-9]{7,40}$/.test(installed))
            return { status: 'unknown', revision: null };
          try {
            const head = z
              .object({ sha: z.string().regex(/^[a-f0-9]{40}$/) })
              .parse(await json('/commits/main')).sha;
            if (head.startsWith(installed)) return { status: 'current', revision: head };
            const comparison = z
              .object({
                status: z.enum(['ahead', 'behind', 'identical', 'diverged'])
              })
              .parse(await json(`/compare/${installed}...${head}?per_page=1`));
            return {
              status:
                comparison.status === 'ahead'
                  ? 'available'
                  : comparison.status === 'identical' || comparison.status === 'behind'
                    ? 'current'
                    : 'unknown',
              revision: head
            };
          } catch {
            return { status: 'unknown', revision: null };
          }
        })(),
        (async (): Promise<UpdateReport['client']> => {
          try {
            const catalogue = releases.parse(await json('/releases?per_page=20'));
            for (const release of catalogue) {
              if (
                release.draft ||
                !release.assets.some((asset) =>
                  /\.(apk|dmg|msi|exe|deb|AppImage|zip)$/.test(asset.name)
                )
              )
                continue;
              const tagged = /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name);
              const beta = /^beta-(\d+\.\d+\.\d+)-([a-f0-9]{40})$/.exec(release.tag_name);
              if (!tagged && !beta) continue;
              return {
                version: (tagged?.[1] ?? beta![1])!,
                revision: beta?.[2] ?? null,
                url: `${DOWNLOADS}/tag/${encodeURIComponent(release.tag_name)}`
              };
            }
          } catch {
            /* Release discovery must not affect the owner's work. */
          }
          return null;
        })()
      ]);
      cached = { checkedAt: new Date().toISOString(), server, client };
      nextCheck = Date.now() + (server.status === 'unknown' ? 15 * 60_000 : CHECK_INTERVAL);
      return cached;
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
}
