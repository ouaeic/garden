import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RefreshOutcome } from './refresh-once.js';

/**
 * What the last refresh pass did, written where something outside this process can read it.
 *
 * Nothing anywhere read the age of the model catalogue. The unit being active is not the same
 * fact: almost all of this service's life is the hour it spends asleep, so a revoked provider key,
 * an owner on a provider this service cannot ask, and a feed that has been failing since Friday
 * all look exactly like a healthy sleeping process to `systemctl`, to `garden doctor` and to the
 * owner. Meanwhile the picker goes on offering models the provider withdrew last quarter, at
 * prices from whenever they were last written - and those prices are what a run is weighed against
 * when it is charged to a spending window.
 *
 * A file rather than a row, because the reader is `garden doctor`, a shell script that already
 * reads `connection.json` and `ddns.state` this way and has no database password of its own. It
 * lives under /var/lib/garden-control because that is the one directory `garden@.service` is
 * allowed to write to; putting it beside the other state in /var/lib/garden would need a change
 * to the unit's ReadWritePaths, and a diagnostic is not worth widening what a service can write.
 */
export interface CatalogRefreshRecord {
  /**
   * When the loop last finished a pass, whatever that pass did - which is what says the loop is
   * still turning inside a unit that looks active either way.
   *
   * Seconds since the epoch and not an ISO string, for the same reason `ddns.state` holds one: the
   * reader is /bin/sh, `date -u -d "@N"` renders it there in one step, and asking it to parse a
   * date instead puts a false report one unfamiliar `date` implementation away. A number that
   * cannot be read is read as zero, which every reader here already treats as "no record".
   */
  checkedAtEpoch: number;
  /** When a provider last actually answered. Zero on a box that has never had a live catalogue. */
  lastRefreshEpoch: number;
  state: RefreshOutcome['state'];
  models: number;
  /** So the reader can size "overdue" against this box's own interval rather than a guess. */
  intervalSeconds: number;
  reason: string | null;
}

/** Zero for anything that is not a whole number of seconds, which is what "no record" reads as. */
const seconds = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/**
 * Absent, unreadable and unparseable all answer null, and all mean the same thing to the caller:
 * there is no record of a previous pass. The loop must not stop refreshing the catalogue because
 * it could not read a file it only keeps for somebody else to look at.
 *
 * The two stamps are taken through `seconds` rather than trusted, because this file outlives the
 * build that wrote it. A field an older or newer registry spelled differently would otherwise
 * arrive as `undefined`, be carried into arithmetic, and be written back as `NaN` - which the
 * reader on the other end resolves to zero and reports as a catalogue that has never refreshed,
 * for ever, on a box that is refreshing hourly.
 */
export const readCatalogRecord = async (path: string): Promise<CatalogRefreshRecord | null> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Partial<CatalogRefreshRecord>;
    return {
      ...record,
      checkedAtEpoch: seconds(record.checkedAtEpoch),
      lastRefreshEpoch: seconds(record.lastRefreshEpoch)
    } as CatalogRefreshRecord;
  } catch {
    return null;
  }
};

/**
 * Written whole and moved into place, because `doctor` may be reading it at the moment the hourly
 * pass rewrites it and half a JSON document parses as nothing.
 */
export const writeCatalogRecord = async (
  path: string,
  record: CatalogRefreshRecord
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
  await rename(temporary, path);
};

/** Seconds since the epoch, which is what this record holds, from the instant a pass ended. */
export const epochSeconds = (at: Date): number => Math.floor(at.getTime() / 1000);
