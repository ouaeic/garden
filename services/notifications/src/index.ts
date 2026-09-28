import { createServer } from 'node:http';
import { createDatabase, DataStore, migrateDatabase } from '@garden/data';
import webpush from 'web-push';
import {
  apiBaseUrl,
  loadConfig,
  masterKeyBytes,
  NOTIFICATION_HEALTH_HOST,
  NOTIFICATION_HEALTH_PORT,
  pushConfigured
} from './config.js';
import { createNotifier } from './loop.js';
import { createPushTransport } from './push-transport.js';
import { EndpointHealth } from './retry.js';
import { runSweep } from './sweep.js';
import { sweepCardOutcomes } from './telegram/inbound.js';
import { superviseDestinationPollers } from './telegram/poll.js';
import { createTelegramTransport } from './telegram/send.js';
import type { Transports } from './transport.js';

/** The bot API's one real address, used whenever the setting that exists for tests is absent. */
const BOT_API_BASE_URL = 'https://api.telegram.org';

const config = loadConfig();
const database = createDatabase({
  driver: config.DATABASE_DRIVER,
  ...(config.DATABASE_DRIVER === 'postgres'
    ? { url: config.DATABASE_URL }
    : { pglitePath: config.PGLITE_PATH })
});
await migrateDatabase(database);
const store = new DataStore(database);
/*
 * Held for the length of the process and handed to the data layer, which is the only place a
 * ciphertext is unwrapped: the query that selects what is waiting to be sent, and the listing of
 * paired destinations the inbound poller works from. Nothing in this service opens an envelope.
 */
const masterKey = masterKeyBytes(config);
if (!masterKey) {
  // Not fatal, and worth saying once. Without it every notification this box sends is titled
  // "Untitled conversation", which looks to an owner like a bug in the wording rather than a
  // missing line in control.env - and a paired phone receives nothing, because the bot token that
  // reaches it is sealed under the same key.
  process.stdout.write(
    'garden notifications: no DATA_MASTER_KEY is configured, so notifications cannot name the ' +
      'conversation they are about and will be titled "Untitled conversation", and a paired phone ' +
      'cannot be sent to or read from. Set DATA_MASTER_KEY in /etc/garden/control.env to the ' +
      'same value the API and worker use.\n'
  );
}
const pushEnabled = pushConfigured(config);
if (pushEnabled) {
  webpush.setVapidDetails(
    config.PUSH_VAPID_SUBJECT,
    config.PUSH_VAPID_PUBLIC_KEY,
    config.PUSH_VAPID_PRIVATE_KEY
  );
} else {
  // Stay up and report the reason. Exiting would crash-loop under systemd and make an optional
  // feature look like a broken installation; the health endpoint says plainly that it is off.
  process.stdout.write(
    'garden notifications: no Web Push signing keys are configured, so delivery to browsers is ' +
      'disabled. Run the installer, or set PUSH_VAPID_SUBJECT, PUSH_VAPID_PUBLIC_KEY and ' +
      'PUSH_VAPID_PRIVATE_KEY in /etc/garden/control.env to enable it.\n'
  );
}
const endpoints = new EndpointHealth();
const shutdown = new AbortController();
const warn = (line: string): void => void process.stderr.write(line);

/*
 * Whether the conversation an agent notice belongs to is parked waiting for the owner's words with
 * no approval card standing for it. That is the one shape where a reply typed on the phone is the
 * answer, and it is asked here, of the store, so the transport itself needs no database.
 */
const awaitingAnswer = async (row: { userId: string; taskId: string }): Promise<boolean> => {
  const task = await store.getTask(row.userId, row.taskId).catch(() => null);
  if (!task || task.status !== 'awaiting_user') return false;
  const approvals = await store.listApprovals(row.userId, 'pending').catch(() => []);
  return !approvals.some((approval) => String(approval.taskId) === row.taskId);
};

/*
 * One transport per kind of row, each present only when this box can drive it. A row whose
 * transport is absent is counted by the sweep and left for a box that can send it.
 */
const transports: Transports = {
  ...(pushEnabled ? { push: createPushTransport() } : {}),
  ...(masterKey
    ? {
        telegram: createTelegramTransport({
          baseUrl: config.TELEGRAM_API_BASE_URL ?? BOT_API_BASE_URL,
          appUrl: config.PUBLIC_APP_URL,
          awaitingAnswer,
          warn
        })
      }
    : {})
};
const deliveryEnabled = pushEnabled || Boolean(masterKey);

/*
 * The inbound half of the phone transport: one long-poll loop per paired destination, supervised
 * so that a destination created in Settings gets a loop before its pairing link is tapped. It
 * lists destinations even without a master key, so the health port can say "paired, not polled".
 */
const inbound = { total: 0, rejected: 0 };
const pollers = superviseDestinationPollers({
  store,
  masterKey,
  baseUrl: config.TELEGRAM_API_BASE_URL ?? BOT_API_BASE_URL,
  appUrl: config.PUBLIC_APP_URL,
  apiBaseUrl: apiBaseUrl(config),
  timeoutS: config.NOTIFICATION_INBOUND_POLL_TIMEOUT_S,
  signal: shutdown.signal,
  warn,
  onInbound: (outcome) => {
    inbound.total += 1;
    if (outcome === 'rejected') inbound.rejected += 1;
  }
});
const polling = pollers.run();

const warnedOnce = new Set<string>();
const destinationTotals = { delivered: 0, failed: 0 };
/*
 * Built before the health server so the metrics handler can read live counters off it, and the
 * signal handler can stop it. Everything about the loop's shape - what it does with nothing to
 * send with, and how quickly it notices a SIGTERM - is stated and tested in `loop.ts`.
 */
const notifier = createNotifier({
  pollMs: config.NOTIFICATION_POLL_MS,
  deliveryEnabled,
  signal: shutdown.signal,
  sweep: async (deferredLastSweep) => {
    const result = await runSweep({
      store,
      masterKey,
      endpoints,
      batchSize: config.NOTIFICATION_BATCH_SIZE,
      deferredLastSweep,
      signal: shutdown.signal,
      transports,
      warnedOnce,
      warn
    });
    // Cards on the phone whose approval was decided at the keyboard, the command line or the
    // deadline: the buttons come off and the decision goes on, once each. Runs after the sweep so
    // a card sent this pass and decided this pass is settled in one.
    if (masterKey && !shutdown.signal.aborted)
      await sweepCardOutcomes({
        store,
        masterKey,
        appUrl: config.PUBLIC_APP_URL,
        clientFor: pollers.clientFor,
        endpoints,
        warn
      });
    destinationTotals.delivered += result.destinationDelivered;
    destinationTotals.failed += result.destinationFailed;
    return result;
  }
});
const health = createServer((request, response) => {
  const destinations = pollers.health();
  if (request.url === '/metrics') {
    response.setHeader('content-type', 'text/plain; version=0.0.4');
    response.end(
      `garden_notifications_delivered_total ${notifier.totals.delivered}\n` +
        `garden_notifications_failed_total ${notifier.totals.failed}\n` +
        `garden_notifications_suppressed_total ${notifier.totals.suppressed}\n` +
        `garden_notifications_endpoints_retired_total ${notifier.totals.retired}\n` +
        `garden_notifications_endpoints_failing ${endpoints.failingCount}\n` +
        `garden_notifications_deferred ${notifier.totals.deferred}\n` +
        // Told apart from `deferred` deliberately: a deferral is a device that will not take a
        // push right now, a hold is the owner being at the keyboard or asleep. A rising
        // `suppressed_total` beside a flat `held` is the service dropping notifications on
        // purpose; beside a standing `held` it is the same few items waiting for a person.
        `garden_notifications_held ${notifier.totals.held}\n` +
        `garden_notifications_unsendable ${notifier.totals.unsendable}\n` +
        // The phone transport's share of the two totals above, so a phone that has gone quiet is
        // not hidden behind a browser that has not.
        `garden_notifications_destination_delivered_total ${destinationTotals.delivered}\n` +
        `garden_notifications_destination_failed_total ${destinationTotals.failed}\n` +
        `garden_notifications_inbound_total ${inbound.total}\n` +
        `garden_notifications_inbound_rejected_total ${inbound.rejected}\n` +
        `garden_notifications_inbound_poll_age_seconds ${
          destinations.pollAgeMs === null ? -1 : Math.round(destinations.pollAgeMs / 1000)
        }\n`
    );
    return;
  }
  // `deliveryEnabled` is read by `garden doctor`, which reports a service that is answering but
  // has nothing to send with as a warning rather than as health. `endpointsFailing` is the same
  // idea one step further in: keys are configured, the service is sending, and a device is not
  // receiving. The one thing that cannot report a broken push is a push, so it is reported here,
  // in the journal, and in the owner's own security record - three places that do not need the
  // phone. `destinations` is the phone transport's answer to the same question: paired says the
  // owner did their part, polling says this service is doing its own.
  //
  // `endpointsTotal` and `destinationsPaired` are what exists to be sent to, and they are here
  // because `endpointsFailing: 0` is also true of a box with no device at all - which is the
  // commonest real state, and `doctor` was reading it as health. They are read from the database
  // on each request so they say what is enrolled now rather than what the last sweep happened to
  // see; a database that will not answer makes them null, which `doctor` reports as unknown rather
  // than as zero, because those are different states and only one of them is fixed by enrolling.
  void store
    .notificationTargetCounts()
    .then(
      (targets) => targets,
      () => null
    )
    .then((targets) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          ok: true,
          service: 'notifications',
          deliveryEnabled,
          pushEnabled,
          // Served for the same reason as `deliveryEnabled`: the symptom on the phone - every
          // notification titled "Untitled conversation" - looks like a wording bug rather than the
          // missing line in control.env that it is, so it has to be answerable without a push.
          titlesReadable: Boolean(masterKey),
          endpointsFailing: endpoints.failingCount,
          endpointsRetired: notifier.totals.retired,
          endpointsTotal: targets?.pushSubscriptions ?? null,
          destinationsPaired: targets?.pairedDestinations ?? null,
          destinations: { telegram: destinations }
        })
      );
    });
});
health.listen(NOTIFICATION_HEALTH_PORT, NOTIFICATION_HEALTH_HOST);

// Aborting rather than setting a flag: the loop is asleep for almost all of its life, and a flag is
// not read until the sleep is over. See the note on the poll delay in `loop.ts`.
const stop = () => shutdown.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

await notifier.run();
await polling;

await new Promise<void>((resolve) => health.close(() => resolve()));
await database.close();
