import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { sharedEnv } from '@garden/contracts/env';
import { decodeMasterKey } from '@garden/core';
import { createDatabase, DataStore, migrateDatabase } from '@garden/data';
import { epochSeconds, readCatalogRecord, writeCatalogRecord } from './catalog-state.js';
import { catalogueFrozenLine, refreshFailureReason, refreshLogLine } from './refresh-log.js';
import { refreshOnce } from './refresh-once.js';

/*
 * Every key more than one garden unit reads is taken from `sharedEnv` rather than restated here.
 *
 * It used to restate eight of them, and three had drifted: this schema defaulted DATABASE_DRIVER to
 * `postgres` where every other unit defaults to `pglite`, trimmed whitespace out of DATA_MASTER_KEY
 * where no other unit does, and accepted a third AI_PROVIDER - `ollama-cloud` - that the API and the
 * worker both refuse to start on. All four units are started by systemd from the same
 * /etc/garden/control.env, so that last one is a file on which this loop runs and the box does
 * not. None of it was ever compared, because `packages/contracts/src/env.test.ts` walked
 * `src/config.ts` and this unit's schema is inline in `src/index.ts`; that walk has been widened.
 *
 * MODEL_CATALOG_SCOPE moved into `sharedEnv` at the same time, from here and from
 * `apps/api/src/config.ts`, the two units that read it. Both write the catalogue with it - the API
 * when a provider key is saved, this loop every hour - so a box where the two disagree has each of
 * them undoing the other's answer about which models exist.
 */
const Config = z.object({
  DATABASE_DRIVER: sharedEnv.DATABASE_DRIVER,
  DATABASE_URL: sharedEnv.DATABASE_URL,
  PGLITE_PATH: sharedEnv.PGLITE_PATH,
  REGISTRY_REFRESH_SECONDS: z.coerce.number().int().min(60).default(3600),
  OPENROUTER_BASE_URL: sharedEnv.OPENROUTER_BASE_URL,
  OPENROUTER_REGISTRY_KEY: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
    z.string().min(1).optional()
  ),
  /**
   * Absent is a working state here alone. The declaration is optional in every unit; what differs
   * is that the others refuse to start without a key, because they cannot do their job at all,
   * and this one can still seed an empty catalogue - a developer running the loop against a
   * scratch database should not have to hold the owner's key to do it.
   */
  DATA_MASTER_KEY: sharedEnv.DATA_MASTER_KEY,
  MODEL_CATALOG_SCOPE: sharedEnv.MODEL_CATALOG_SCOPE,
  /*
   * Where an operator pointed this box, when they did it in control.env rather than in Settings.
   *
   * The third of three shapes a box can be pointed at a provider in, and the one that refreshed
   * nothing: `seedModelCatalog` writes one `custom/AI_DEFAULT_MODEL` row when the API starts and no
   * process ever asks that endpoint another question. Read here because the unit already loads the
   * file that holds them - the same values the worker reads to send the work - so this costs no new
   * configuration and no new place for the two halves to disagree about where the provider is.
   *
   * "The same values" is now literally the same declaration. It was a copy that had grown a third
   * provider the worker's own enum does not have, which is exactly the disagreement the sentence
   * above claims this arrangement avoids. Ollama Cloud is still reached the way owners actually
   * reach it - a credential saved in Settings, whose provider is a free string on that path - and
   * `configured-catalog.ts` still treats it as a subscription rather than a single pinned model.
   */
  AI_PROVIDER: sharedEnv.AI_PROVIDER,
  AI_API_KEY: sharedEnv.AI_API_KEY,
  OPENROUTER_API_KEY: sharedEnv.OPENROUTER_API_KEY,
  AI_REQUIRE_ZDR: sharedEnv.AI_REQUIRE_ZDR,
  AI_BASE_URL: sharedEnv.AI_BASE_URL,
  AI_DEFAULT_MODEL: sharedEnv.AI_DEFAULT_MODEL,
  /**
   * Where each pass writes down what it did, for `garden doctor` to read. The default is inside
   * /var/lib/garden-control because that is the one directory `garden@.service` may write to.
   * `doctor` reads the same variable out of control.env, so an operator who moves the file moves
   * both halves at once.
   */
  MODEL_CATALOG_STATE_PATH: z.string().default('/var/lib/garden-control/model-catalog.state')
});
const config = Config.parse(process.env);
const database = createDatabase({
  driver: config.DATABASE_DRIVER,
  ...(config.DATABASE_DRIVER === 'postgres'
    ? { url: config.DATABASE_URL }
    : { pglitePath: config.PGLITE_PATH })
});
await migrateDatabase(database);
const store = new DataStore(database);
const masterKey = config.DATA_MASTER_KEY ? decodeMasterKey(config.DATA_MASTER_KEY) : null;
/*
 * Shutting down means waking up, not just being told.
 *
 * Almost all of this service's life is the hour it spends asleep between refreshes, and a flag set
 * by the signal handler is not read until that hour is over. So every restart - and every update,
 * which restarts each service in turn - waited out `TimeoutStopSec` and then killed it: thirty
 * seconds of the outage the owner is watching, spent on a process that had nothing to finish.
 */
let running = true;
const shutdown = new AbortController();
const stop = (): void => {
  running = false;
  shutdown.abort();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

let consecutiveFailures = 0;
let frozenSaid = false;
let stateWriteSaid = false;
/*
 * When a provider last answered, held here as well as in the record on disk. The file is the
 * durable copy and survives the restart this process gets on every update; this one covers the
 * hour after a pass that could not write it, so a directory that was briefly unwritable does not
 * make the next pass report a catalogue that has never refreshed.
 */
let lastRefreshEpoch = 0;

while (running) {
  const previous = await readCatalogRecord(config.MODEL_CATALOG_STATE_PATH);
  const outcome = await refreshOnce({
    store,
    masterKey,
    environmentKey: config.OPENROUTER_REGISTRY_KEY,
    environmentProvider: {
      provider: config.AI_PROVIDER,
      baseUrl: config.AI_BASE_URL,
      modelId: config.AI_DEFAULT_MODEL,
      apiKey:
        config.AI_API_KEY ??
        (config.AI_PROVIDER === 'openrouter' ? config.OPENROUTER_API_KEY : undefined),
      enforceZeroDataRetention: config.AI_REQUIRE_ZDR
    },
    baseUrl: config.OPENROUTER_BASE_URL,
    scope: config.MODEL_CATALOG_SCOPE
  });
  // The journal is the whole of the observation this box has: one owner, no alerting, and this
  // service has no endpoint to ask. Silence would make a catalogue that stopped changing
  // indistinguishable from a provider that shipped nothing, so the first failure and the recovery
  // are both said once, in `garden logs registry` - and so is the state where there is nothing to
  // refresh from at all, which used to be the one silence nobody could tell from health.
  const line = refreshLogLine({
    previousFailures: consecutiveFailures,
    reason: outcome.reason,
    intervalSeconds: config.REGISTRY_REFRESH_SECONDS,
    state: outcome.state
  });
  if (line) process.stderr.write(line);
  consecutiveFailures = outcome.reason === null ? 0 : consecutiveFailures + 1;
  const previousRefresh = Math.max(previous?.lastRefreshEpoch ?? 0, lastRefreshEpoch);
  const frozen = catalogueFrozenLine({
    alreadySaid: frozenSaid,
    state: outcome.state,
    models: outcome.models,
    lastRefreshAt: previousRefresh ? new Date(previousRefresh * 1000) : null
  });
  if (frozen) process.stderr.write(frozen);
  frozenSaid = outcome.state === 'refreshed' ? false : frozenSaid || frozen !== null;
  const checkedAtEpoch = epochSeconds(new Date());
  // Only a provider answering moves this. A pass that failed, or had no key to try, leaves it
  // where it was - that is the whole point of recording it, and it is what tells the owner how
  // long the catalogue in front of them has actually been standing still.
  lastRefreshEpoch = outcome.state === 'refreshed' ? checkedAtEpoch : previousRefresh;
  try {
    await writeCatalogRecord(config.MODEL_CATALOG_STATE_PATH, {
      checkedAtEpoch,
      lastRefreshEpoch,
      state: outcome.state,
      models: outcome.models,
      intervalSeconds: config.REGISTRY_REFRESH_SECONDS,
      reason: outcome.reason
    });
    stateWriteSaid = false;
  } catch (error) {
    // Once, at the same cadence as everything else here. A refresh loop must not stop refreshing
    // because it could not write a file it keeps only for somebody else to read, but a silent
    // failure here is a `doctor` check that reports a stale catalogue for ever after.
    if (!stateWriteSaid) {
      process.stderr.write(
        `garden model registry: the refresh record could not be written to ` +
          `${config.MODEL_CATALOG_STATE_PATH} (${refreshFailureReason(error)}), so ` +
          `sudo garden doctor cannot tell a current catalogue from one that stopped refreshing.\n`
      );
      stateWriteSaid = true;
    }
  }
  await delay(config.REGISTRY_REFRESH_SECONDS * 1000, undefined, {
    signal: shutdown.signal
  }).catch(() => undefined);
}
await database.close();
