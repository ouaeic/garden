import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  epochSeconds,
  readCatalogRecord,
  writeCatalogRecord,
  type CatalogRefreshRecord
} from './catalog-state.js';

const record = (over: Partial<CatalogRefreshRecord> = {}): CatalogRefreshRecord => ({
  checkedAtEpoch: 1787648400,
  lastRefreshEpoch: 1787644800,
  state: 'refreshed',
  models: 312,
  intervalSeconds: 3600,
  reason: null,
  ...over
});

const scratch = () => mkdtemp(join(tmpdir(), 'garden-catalog-state-'));

describe('the catalogue refresh record', () => {
  it('round-trips through a directory it has to create itself, because nothing else makes one', async () => {
    const path = join(await scratch(), 'nested', 'model-catalog.state');
    await writeCatalogRecord(path, record());
    expect(await readCatalogRecord(path)).toEqual(record());
  });

  it('holds whole seconds, which is the one form the shell reading it can render without parsing a date', async () => {
    const path = join(await scratch(), 'model-catalog.state');
    await writeCatalogRecord(
      path,
      record({
        state: 'frozen',
        checkedAtEpoch: epochSeconds(new Date('2026-08-25T09:00:00.987Z'))
      })
    );
    const written = JSON.parse(await readFile(path, 'utf8')) as CatalogRefreshRecord;
    expect(written.checkedAtEpoch).toBe(1787648400);
    expect(Number.isInteger(written.checkedAtEpoch)).toBe(true);
    expect(written).toMatchObject({ state: 'frozen', intervalSeconds: 3600 });
  });

  it('answers null for a file that is missing or half-written rather than throwing, because the loop must go on refreshing either way', async () => {
    const directory = await scratch();
    expect(await readCatalogRecord(join(directory, 'never-written.state'))).toBeNull();
    const truncated = join(directory, 'truncated.state');
    await writeFile(truncated, '{"checkedAtEpoch": 17876');
    expect(await readCatalogRecord(truncated)).toBeNull();
  });

  it('reads a stamp another build spelled differently as no stamp at all, rather than carrying it into arithmetic', async () => {
    const path = join(await scratch(), 'from-another-build.state');
    await writeFile(path, JSON.stringify({ state: 'refreshed', lastRefreshedAt: 'yesterday' }));
    const read = await readCatalogRecord(path);
    expect(read?.checkedAtEpoch).toBe(0);
    expect(read?.lastRefreshEpoch).toBe(0);
    const carried = (read?.lastRefreshEpoch ?? 0) + 3600;
    expect(Number.isFinite(carried)).toBe(true);
  });
});
