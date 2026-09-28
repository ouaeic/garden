import type { DataStore } from '@garden/data';
import { notificationSubject, ownerPresent, ownerSettings, type PendingRow } from './context.js';
import type { OwnerNotificationSettings } from './model.js';
import { deliveryDecision } from './policy.js';
import { backoffMs, endpointHost, isGone, RETRY_HORIZON_MS, type EndpointHealth } from './retry.js';
import { transportFailure, type Delivered, type Transports } from './transport.js';

/**
 * How far past the batch size a sweep may reach to get round endpoints that are waiting.
 *
 * The wait lives in this process and the batch is chosen by a query, which cannot see it - so a
 * hundred items belonging to one refusing endpoint still fill the page they are ordered to the
 * front of, and skipping them cheaply is not the same as getting past them. Asking for as many
 * extra rows as were skipped last time restores a full batch of deliverable work behind them. It is
 * bounded because the honest version of this is a predicate in the query, which is in the handoff;
 * this is what keeps the queue moving until that lands.
 *
 * A hold does not widen the page and deliberately so. An endpoint wait is a fact about one device,
 * so the rows behind it are ordinary work; a hold is a decision about the owner - they are at the
 * keyboard, or it is the middle of their night - and it is the same decision for every row of that
 * kind on that pass, so reaching further would only return more rows that hold too.
 */
export const MAX_DEFERRED_PAGE_ROOM = 400;

export interface SweepInput {
  store: DataStore;
  /**
   * The owner's key, or undefined on a box that has none.
   *
   * This is the whole difference between a notification that says which conversation it is about
   * and one that says "Untitled conversation". The data layer is the only place holding both the
   * envelope and the key, so the title and the agent's sentence are unwrapped there and arrive on
   * the row already in the clear - which only happens if the key gets this far.
   */
  masterKey: Uint8Array | undefined;
  endpoints: EndpointHealth;
  batchSize: number;
  /** Endpoint waits carried over from the previous pass, which widen this one's page. */
  deferredLastSweep: number;
  /**
   * Shutdown, checked between items and nowhere else.
   *
   * A full batch is a hundred serial sends, each with a ten-second ceiling, so a pass that meets a
   * push service which accepts the connection and then says nothing can run for minutes - longer
   * than the thirty seconds `garden@.service` gives a stop before it sends SIGKILL. Two things
   * follow, and only the second is a defect: every `garden restart` and every update pays that
   * thirty seconds, and the kill can land in the gap between a push that was sent and the ledger
   * row recording it was sent, so the owner gets that notification a second time on the next start.
   * Checking here - at an item boundary, never inside one - closes both without abandoning work.
   */
  signal?: AbortSignal;
  /**
   * How each kind of row travels, keyed by the row's own `transport`. A row whose transport is
   * absent - a device row on a box with no signing keys, a destination row on a box with no master
   * key - is left alone: nothing sent, nothing settled, counted under `unsendable`.
   */
  transports: Transports;
  now?: () => Date;
  /** The journal. Separated so a test can read what an owner at the box would have read. */
  warn?: (line: string) => void;
  /**
   * Destination ids already warned about, kept by the caller for the life of the process. A
   * destination whose configuration will not open is skipped on every pass, and the journal line
   * saying so is worth writing once, not every two seconds.
   */
  warnedOnce?: Set<string>;
}

export interface SweepResult {
  /** Rows the query returned, before anything was decided about them. */
  pending: number;
  delivered: number;
  failed: number;
  suppressed: number;
  retired: number;
  /** Endpoints inside their wait: nothing attempted, and the only thing that widens the next page. */
  deferred: number;
  /** Decisions to hold: nothing sent, nothing settled, reconsidered on a later pass. */
  held: number;
  /**
   * Rows nothing on this box can send: no transport for their kind, or a destination whose sealed
   * configuration will not open. Nothing sent, nothing settled, and the reason is in the journal.
   */
  unsendable: number;
  /** The phone transport's share of `delivered` and `failed`, for its own two counters. */
  destinationDelivered: number;
  destinationFailed: number;
  /**
   * Nothing in this batch could be attempted, so the caller must wait before asking again.
   *
   * A sweep whose whole batch was held used to leave this false, because only endpoint waits were
   * counted - so the loop re-issued the candidate UNION as fast as PostgreSQL would answer it,
   * for as long as the owner kept a tab open or their quiet hours lasted. Nine hours of a hot loop
   * on a machine whose whole point is running unattended, with an inflating suppressed counter on
   * a loopback metrics port as the only sign of it.
   */
  idle: boolean;
}

/**
 * The ledger row that stops a notification firing twice is keyed by target, kind and resource, so
 * it is also the only way to record "this one will never be sent". Writing it for a dropped item
 * is deliberate: without it, a message the owner has already read on screen — or has switched off
 * entirely — would be re-examined on every pass for as long as the row exists. Each transport has
 * its own ledger, because the push ledger's key is a foreign key to the device's subscription.
 */
const settle = (store: DataStore, row: PendingRow, delivered: Delivered = {}): Promise<void> =>
  row.transport === 'push'
    ? store.recordNotificationDelivery(row.id, row.kind, row.resourceId)
    : store.recordDestinationDelivery(
        row.id,
        row.kind,
        row.resourceId,
        delivered.externalRef ?? null,
        delivered.nonce ?? null
      );

/** The far end, for a journal line: the push service by host, the phone transport by name. */
const farEnd = (row: PendingRow): string =>
  row.transport === 'push' ? endpointHost(row.endpoint) : 'the phone transport';

/**
 * A write that records a failure must not be able to end the loop.
 *
 * These run inside the handler for a delivery that already went wrong, and an exception thrown
 * there escapes the batch, escapes the while, and stops the service - turning one refusing push
 * service into no notifications at all. The journal line beside each of them is the record that
 * survives a database that will not take the write.
 */
const bestEffort = (work: Promise<unknown>): Promise<void> =>
  work.then(
    () => undefined,
    () => undefined
  );

/** One pass over everything waiting to be told to a device that has not been told it yet. */
export const runSweep = async (input: SweepInput): Promise<SweepResult> => {
  const { store, endpoints } = input;
  const clock = input.now ?? (() => new Date());
  const warn = input.warn ?? ((line: string) => void process.stderr.write(line));
  const warnedOnce = input.warnedOnce ?? new Set<string>();
  const result: SweepResult = {
    pending: 0,
    delivered: 0,
    failed: 0,
    suppressed: 0,
    retired: 0,
    deferred: 0,
    held: 0,
    unsendable: 0,
    destinationDelivered: 0,
    destinationFailed: 0,
    idle: true
  };

  const pending: PendingRow[] = await store
    .listPendingNotifications(
      input.batchSize + Math.min(input.deferredLastSweep, MAX_DEFERRED_PAGE_ROOM),
      input.masterKey
    )
    .catch(() => []);
  result.pending = pending.length;
  if (!pending.length) return result;

  const now = clock();
  // One owner, one set of switches, one presence answer — resolved once per pass rather than once
  // per subscription, which for a household of devices is the difference between one query and ten.
  const settingsByUser = new Map<string, OwnerNotificationSettings>();
  const presenceByUser = new Map<string, boolean>();
  for (const item of pending) {
    // Told to stop. Nothing in this batch is settled or lost by leaving now - an item that was not
    // reached has no delivery record, so the next start considers it again - and leaving between
    // items is the only place where that is true.
    if (input.signal?.aborted) break;
    // An endpoint inside its wait costs nothing here: no request, no ten-second timeout, and no
    // place at the front of the queue. Nothing is settled and nothing is lost - the item is simply
    // considered again once the wait is over.
    if (endpoints.waiting(item.id, clock())) {
      result.deferred += 1;
      continue;
    }
    const transport = input.transports[item.transport];
    if (!transport) {
      result.unsendable += 1;
      continue;
    }
    if (item.transport === 'telegram' && (!item.config || !item.senderId)) {
      // The row is a candidate because the destination is verified, so a missing sender cannot
      // happen; an unopened configuration can, when the master key on this box is not the one
      // the API sealed with. Neither is the far end's doing, so nothing is held against it.
      result.unsendable += 1;
      if (!warnedOnce.has(item.id)) {
        warnedOnce.add(item.id);
        warn(
          `garden-notifications: notification.destination_unreadable destination=${item.id} its configuration does not open under DATA_MASTER_KEY; nothing is sent to it. Unpair and pair again in Settings\n`
        );
      }
      continue;
    }
    let sending = false;
    try {
      let settings = settingsByUser.get(item.userId);
      if (!settings) {
        settings = await ownerSettings(store, item.userId);
        settingsByUser.set(item.userId, settings);
      }
      let present = presenceByUser.get(item.userId);
      if (present === undefined) {
        present = await ownerPresent(store, item.userId, now);
        presenceByUser.set(item.userId, present);
      }

      const { subject, eventAt } = await notificationSubject(store, item);
      const decision = deliveryDecision({
        kind: item.kind,
        settings,
        ownerPresent: present,
        eventAt,
        now
      });
      if (decision.action === 'hold') {
        result.suppressed += 1;
        result.held += 1;
        continue;
      }
      if (decision.action === 'drop') {
        result.suppressed += 1;
        await settle(store, item);
        continue;
      }

      // Only what the push service does counts against the push service. Everything above this
      // point is a database read of the owner's own rows, and a failure there says nothing about
      // the far end and must not put a working device into a wait.
      sending = true;
      const delivered = await transport.send(item, subject, settings);
      sending = false;
      await settle(store, item, delivered);
      result.delivered += 1;
      if (item.transport === 'telegram') result.destinationDelivered += 1;
      // One delivery is proof the endpoint is back, so it starts again from no failures at all.
      endpoints.succeeded(item.id);
    } catch (error) {
      result.failed += 1;
      if (item.transport === 'telegram') result.destinationFailed += 1;
      // Not the endpoint's doing: retried on the next sweep, holding nothing against the device.
      if (!sending) continue;
      const { statusCode, retryAfterMs, gone } = transportFailure(error);
      const host = farEnd(item);
      // The far end saying the subscription is gone. Nothing to wait for and nothing to tell the
      // owner: a device that unsubscribed, or a browser profile that was cleared, is ordinary. Only
      // a device can be gone in this sense; a destination is the owner's, and only they remove it.
      if (item.transport === 'push' && (gone || isGone(statusCode))) {
        endpoints.forget(item.id);
        await bestEffort(store.deletePushSubscriptionById(item.id));
        continue;
      }

      const outcome = endpoints.failed(item.id, statusCode, clock(), retryAfterMs);
      const status = statusCode ? ` (HTTP ${statusCode})` : '';
      if (outcome.exhausted && item.transport === 'push') {
        /*
         * A day of refusals, so this endpoint is not coming back and every notification queued
         * behind it has been waiting on something that cannot happen. Retiring it removes its
         * candidates; it writes no delivery record, so nothing is marked sent that was not, and
         * everything the owner should have been told is still in the conversation it belongs to
         * and in the standing list of what the agent has raised.
         */
        endpoints.forget(item.id);
        await bestEffort(store.deletePushSubscriptionById(item.id));
        result.retired += 1;
        await bestEffort(
          store.recordSecurityEvent({
            userId: item.userId,
            kind: 'push_endpoint_retired',
            outcome: 'failure',
            // The push service and the code it answered with. The rest of the endpoint is the
            // secret that authorises sending to that device and never leaves this process.
            metadata: { host, statusCode, attempts: outcome.state.attempts }
          })
        );
        warn(
          `garden-notifications: ${host} has refused every notification for ${Math.round(RETRY_HORIZON_MS / 3_600_000)}h${status}; that device has been retired and will not be tried again. Turn notifications on again on the device to restore it\n`
        );
        continue;
      }
      // A destination is never retired: it is the owner's one phone, paired on purpose, and a
      // bot API that has refused for a day is a bot API that will be tried again in half an hour.
      // The exhaustion horizon is a fact about devices, whose subscriptions go stale on their own.

      if (outcome.first) {
        /*
         * Said out loud once, when a target starts failing rather than on every refusal.
         *
         * The only record of a failure was `failed`, a counter on a metrics port bound to loopback
         * - so a device whose notifications had silently stopped working looked exactly like a
         * device nothing had happened on, and the owner's first clue was noticing they had stopped
         * arriving. A push cannot report that pushes are not arriving, so it is written where the
         * owner can find it without one: the journal for whoever is at the box, and the security
         * record, which is theirs and travels in the privacy export.
         */
        await bestEffort(
          store.recordSecurityEvent({
            userId: item.userId,
            kind:
              item.transport === 'push' ? 'push_delivery_failing' : 'destination_delivery_failing',
            outcome: 'failure',
            metadata:
              item.transport === 'push'
                ? { host, statusCode }
                : { destinationId: item.id, statusCode }
          })
        );
        const wait = Math.max(1, Math.round((outcome.state.retryAt - clock().getTime()) / 60_000));
        warn(
          item.transport === 'push'
            ? `garden-notifications: ${host} refused a notification${status}; nothing is lost and it will be tried again in ${wait} min, backing off to ${Math.round(RETRY_HORIZON_MS / 3_600_000)}h before that device is retired\n`
            : `garden-notifications: notification.destination_delivery_failing destination=${item.id} ${host} refused a message${status}; nothing is lost and it will be tried again in ${wait} min, backing off to ${Math.round(backoffMs(Number.MAX_SAFE_INTEGER) / 60_000)} min between attempts\n`
        );
      }
    }
  }

  // A sweep with nothing left to attempt waits, rather than reselecting the same rows as fast as
  // the database will answer. Everything else falls straight through to the next batch, which is
  // what drains a backlog quickly.
  result.idle = result.deferred + result.held + result.unsendable === pending.length;
  return result;
};
