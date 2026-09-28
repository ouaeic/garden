import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ConnectorScope } from '@garden/contracts';
import { type AccountApi, accountResourceId } from './account-api.js';
import type { AccountOperation } from './account-operation.js';
import { GardenError } from './errors.js';

const zone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Use an IANA time zone.');
const time = z
  .object({
    start: z.string().max(100),
    end: z.string().max(100),
    allDay: z.boolean(),
    timeZone: zone.optional()
  })
  .strict()
  .superRefine((value, context) => {
    const format = value.allDay ? z.iso.date() : z.iso.datetime({ offset: true });
    for (const field of ['start', 'end'] as const)
      if (!format.safeParse(value[field]).success)
        context.addIssue({
          code: 'custom',
          path: [field],
          message: value.allDay ? 'Use a calendar date.' : 'Use an explicit UTC offset.'
        });
    if (!(Date.parse(value.end) > Date.parse(value.start)))
      context.addIssue({
        code: 'custom',
        path: ['end'],
        message: 'The exclusive end must follow the start.'
      });
  });
export const AccountCalendarChanges = z
  .object({
    summary: z.string().min(1).max(1000).optional(),
    description: z.string().max(20000).optional(),
    location: z.string().max(1000).optional(),
    time: time.optional(),
    attendees: z
      .array(
        z.object({ address: z.email().max(320), name: z.string().max(200).optional() }).strict()
      )
      .max(200)
      .optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Choose at least one change.');
const identity = {
  calendarId: accountResourceId.optional(),
  eventId: accountResourceId,
  expectedVersion: z
    .string()
    .max(2048)
    .regex(/^"[\x21\x23-\x7e]+"$/),
  target: z.enum(['single', 'occurrence', 'series'])
};
export const AccountCalendarUpdate = z
  .object({ ...identity, changes: AccountCalendarChanges })
  .strict();
export const AccountCalendarDelete = z.object(identity).strict();
type Intent =
  | (z.infer<typeof AccountCalendarUpdate> & { action: 'update' })
  | (z.infer<typeof AccountCalendarDelete> & { action: 'delete' });
const record = z.record(z.string(), z.unknown());
const Checkpoint = z
  .object({
    version: z.literal(1),
    kind: z.literal('calendar_mutation'),
    operationId: z.uuid(),
    digest: z.string().length(64),
    phase: z.enum(['ready', 'submitted']),
    body: record.optional()
  })
  .strict();
const Receipt = z
  .object({
    status: z.enum(['updated', 'deleted', 'absent']),
    operationId: z.uuid(),
    eventId: accountResourceId,
    version: z.string().optional(),
    recovered: z.boolean(),
    message: z.string()
  })
  .strict();
const missing = (error: unknown) =>
  error instanceof GardenError && error.code === 'connector_resource_not_found';
const uncertain = (operationId: string) => ({
  status: 'uncertain' as const,
  operationId,
  message:
    'The calendar outcome is uncertain. Inspect this same operation; no mutation will be repeated automatically.'
});
const eventKind = (event: Record<string, unknown>) =>
  event.recurringEventId
    ? 'occurrence'
    : Array.isArray(event.recurrence) && event.recurrence.length
      ? 'series'
      : 'single';

export async function readAccountCalendarEvent(
  api: AccountApi,
  input: { calendarId?: string | undefined; eventId: string }
) {
  const id = accountResourceId.parse(input.eventId);
  const calendar = accountResourceId.parse(input.calendarId ?? 'primary');
  const url =
    api.secret.provider === 'google'
      ? api.url(
          'googleCalendar',
          `calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(id)}`
        )
      : api.url(
          'graph',
          input.calendarId
            ? `calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(id)}`
            : `events/${encodeURIComponent(id)}`
        );
  const event = await api.json(url);
  if (event.id !== id)
    throw new GardenError('connector_response_invalid', 'The provider returned a different event.');
  return {
    event,
    ...(api.secret.provider === 'google' ? { target: eventKind(event), version: event.etag } : {})
  };
}

function bodyFor(event: Record<string, unknown>, changes: z.infer<typeof AccountCalendarChanges>) {
  const body: Record<string, unknown> = {};
  for (const key of ['summary', 'description', 'location'] as const)
    if (changes[key] !== undefined) body[key] = changes[key];
  if (changes.time) {
    for (const key of ['start', 'end'] as const) {
      const original = record.parse(event[key]);
      const timeZone = changes.time.timeZone ?? original.timeZone;
      if (!changes.time.allDay && eventKind(event) === 'series' && typeof timeZone !== 'string')
        throw new GardenError(
          'calendar_time_zone_required',
          'A recurring series needs its IANA time zone.'
        );
      body[key] = changes.time.allDay
        ? {
            date: changes.time[key],
            dateTime: null,
            timeZone: typeof timeZone === 'string' ? timeZone : null
          }
        : {
            date: null,
            dateTime: changes.time[key],
            ...(typeof timeZone === 'string' ? { timeZone } : {})
          };
    }
  }
  if (changes.attendees) {
    const previous = z.array(record).parse(event.attendees ?? []);
    const addresses = changes.attendees.map((item) => item.address.toLowerCase());
    if (new Set(addresses).size !== addresses.length)
      throw new GardenError('calendar_attendees_invalid', 'Each attendee must appear once.');
    body.attendees = changes.attendees.map((item) => ({
      ...previous.find(
        (value) =>
          typeof value.email === 'string' &&
          value.email.toLowerCase() === item.address.toLowerCase()
      ),
      email: item.address,
      ...(item.name === undefined ? {} : { displayName: item.name })
    }));
  }
  return body;
}
function reflects(event: Record<string, unknown>, body: Record<string, unknown>) {
  for (const [key, expected] of Object.entries(body)) {
    if (key === 'extendedProperties') continue;
    if (key === 'start' || key === 'end') {
      const actual = record.safeParse(event[key]),
        time = record.parse(expected);
      if (!actual.success) return false;
      if (
        time.date
          ? actual.data.date !== time.date
          : typeof actual.data.dateTime !== 'string' ||
            Date.parse(actual.data.dateTime) !== Date.parse(String(time.dateTime))
      )
        return false;
      if (time.timeZone && time.timeZone !== actual.data.timeZone) return false;
    } else if (key === 'attendees') {
      const actual = z.array(record).safeParse(event.attendees ?? []);
      const desired = z.array(record).parse(expected);
      if (!actual.success || actual.data.length !== desired.length) return false;
      for (const person of desired) {
        const found = actual.data.find(
          (value) =>
            typeof value.email === 'string' &&
            value.email.toLowerCase() === String(person.email).toLowerCase()
        );
        if (
          !found ||
          (person.displayName !== undefined && person.displayName !== found.displayName)
        )
          return false;
      }
    } else if (!isDeepStrictEqual(event[key] ?? '', expected)) return false;
  }
  return true;
}

/** Conditional changes never replace a concurrent edit or blindly repeat an uncertain write. */
export async function mutateAccountCalendarEvent(
  api: AccountApi,
  raw: Intent,
  operation: AccountOperation,
  scopes: readonly ConnectorScope[]
) {
  if (api.secret.provider !== 'google')
    throw new GardenError(
      'calendar_conditional_update_unavailable',
      'Conditional calendar changes are unavailable for this provider.'
    );
  const { action, ...parameters } = raw;
  const input: Intent =
    action === 'update'
      ? { ...AccountCalendarUpdate.parse(parameters), action }
      : { ...AccountCalendarDelete.parse(parameters), action };
  api.requireScope(
    scopes,
    input.action === 'update' ? 'calendar:events.edit' : 'calendar:events.delete'
  );
  api.requireScope(scopes, 'calendar:calendars.read');
  z.uuid().parse(operation.id);
  operation.signal.throwIfAborted();
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const saved = operation.recovery == null ? null : Checkpoint.parse(operation.recovery);
  if (saved && (saved.operationId !== operation.id || saved.digest !== digest))
    throw new GardenError(
      'connector_operation_context',
      'The calendar checkpoint belongs to another intent.'
    );
  if (operation.completed) {
    const result = Receipt.parse(operation.result);
    if (
      result.operationId !== operation.id ||
      result.eventId !== input.eventId ||
      (result.status === 'updated') !== (input.action === 'update')
    )
      throw new GardenError(
        'connector_operation_context',
        'The calendar receipt belongs to another intent.'
      );
    return result;
  }
  const url = api.url(
    'googleCalendar',
    `calendars/${encodeURIComponent(input.calendarId ?? 'primary')}/events/${encodeURIComponent(input.eventId)}`
  );
  const finish = async (
    status: 'updated' | 'deleted' | 'absent',
    recovered: boolean,
    version?: string
  ) => {
    const result = {
      status,
      operationId: operation.id,
      eventId: input.eventId,
      recovered,
      ...(version ? { version } : {}),
      message:
        status === 'absent'
          ? 'The event is absent. This does not establish who removed it or whether cancellation notices were delivered.'
          : status === 'deleted'
            ? 'The provider accepted the deletion. Notification delivery is not confirmed.'
            : 'The requested fields are present in the observed event. Notification delivery is not confirmed.'
    };
    await operation.complete(result);
    return result;
  };
  const inspect = async () => {
    let event: Record<string, unknown>;
    try {
      event = await api.json(url);
    } catch (error) {
      if (missing(error) && input.action === 'delete') return finish('absent', true);
      throw error;
    }
    if (event.id !== input.eventId)
      throw new GardenError(
        'connector_response_invalid',
        'The provider returned a different event.'
      );
    if (event.status === 'cancelled' && input.action === 'delete') return finish('absent', true);
    if (input.action === 'delete' || event.status === 'cancelled' || !saved?.body)
      return uncertain(operation.id);
    const extensions = record.safeParse(event.extendedProperties);
    const properties = extensions.success ? record.safeParse(extensions.data.private) : null;
    if (
      !properties?.success ||
      properties.data.gardenMutation !== operation.id ||
      !reflects(event, saved.body)
    )
      return uncertain(operation.id);
    return finish('updated', true, typeof event.etag === 'string' ? event.etag : undefined);
  };
  if (saved?.phase === 'submitted') return inspect();
  let current: Record<string, unknown>;
  try {
    current = await api.json(url);
  } catch (error) {
    if (missing(error) && input.action === 'delete') return finish('absent', false);
    throw error;
  }
  if (current.id !== input.eventId)
    throw new GardenError('connector_response_invalid', 'The provider returned a different event.');
  if (current.status === 'cancelled') {
    if (input.action === 'delete') return finish('absent', false);
    throw new GardenError('calendar_event_cancelled', 'Choose an active calendar event.');
  }
  if (current.etag !== input.expectedVersion)
    throw new GardenError(
      'calendar_version_changed',
      'The event changed. Read its current version and review the intended changes.'
    );
  if (eventKind(current) !== input.target)
    throw new GardenError(
      'calendar_target_changed',
      'Choose explicitly between this event, one occurrence and the whole series.'
    );
  let body: Record<string, unknown> | undefined;
  if (input.action === 'update') {
    body = bodyFor(current, input.changes);
    const extensions = record.parse(current.extendedProperties ?? {});
    body.extendedProperties = {
      ...extensions,
      private: { ...record.parse(extensions.private ?? {}), gardenMutation: operation.id }
    };
  }
  const checkpoint = {
    version: 1,
    kind: 'calendar_mutation',
    operationId: operation.id,
    digest,
    phase: 'submitted',
    ...(body ? { body } : {})
  };
  await operation.checkpoint(checkpoint);
  operation.signal.throwIfAborted();
  const destination = new URL(url);
  destination.searchParams.set('sendUpdates', 'all');
  try {
    const options = { headers: { 'if-match': input.expectedVersion } };
    if (input.action === 'delete') {
      await api.request(destination, { ...options, method: 'DELETE' });
      return finish('deleted', false);
    }
    const event = await api.json(destination, { ...options, method: 'PATCH', body });
    if (event.id !== input.eventId || event.status === 'cancelled' || !reflects(event, body!))
      return uncertain(operation.id);
    return finish('updated', false, typeof event.etag === 'string' ? event.etag : undefined);
  } catch (error) {
    const status = error instanceof GardenError ? error.details?.statusCode : undefined;
    if (
      typeof status === 'number' &&
      [400, 401, 403, 404, 412, 413, 415, 422, 429].includes(status)
    )
      await operation.checkpoint({ ...checkpoint, phase: 'ready' });
    throw error;
  }
}
