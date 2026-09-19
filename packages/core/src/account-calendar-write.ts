import { z } from 'zod';
import type { ConnectorScope } from '@athanor/contracts';
import { type AccountApi, accountResourceId } from './account-api.js';
import type { AccountOperation } from './account-operation.js';
import { AthanorError } from './errors.js';

const timeZone = z
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
const person = z.object({ address: z.email().max(320), name: z.string().max(200).optional() });
const common = {
  calendarId: accountResourceId.optional(),
  summary: z.string().min(1).max(1000),
  description: z.string().max(20000).default(''),
  location: z.string().max(1000).default(''),
  attendees: z.array(person).max(200).default([])
};
export const AccountCalendarCreate = z
  .object({
    ...common,
    allDay: z.boolean().default(false),
    start: z.string().max(100),
    end: z.string().max(100),
    timeZone: timeZone.optional()
  })
  .superRefine((value, context) => {
    const format = value.allDay ? z.iso.date() : z.iso.datetime({ offset: true });
    for (const field of ['start', 'end'] as const) {
      if (!format.safeParse(value[field]).success)
        context.addIssue({
          code: 'custom',
          path: [field],
          message: value.allDay
            ? 'Use a calendar date.'
            : 'Use a date and time with an explicit UTC offset.'
        });
    }
    if (value.allDay && !value.timeZone)
      context.addIssue({
        code: 'custom',
        path: ['timeZone'],
        message: 'All-day events need their IANA time zone.'
      });
    if (!(Date.parse(value.end) > Date.parse(value.start)))
      context.addIssue({
        code: 'custom',
        path: ['end'],
        message: 'The exclusive end must follow the start.'
      });
  });

// A private named property makes the provider resource recoverable even when its creation reply is lost.
const graphOperationProperty = 'String {ecf226b3-7319-4c42-a34e-452a2ed9180b} Name GardenOperation';
const Recovery = z.object({
  version: z.literal(1),
  kind: z.literal('calendar_create'),
  phase: z.enum(['ready', 'submitted']),
  operationId: z.uuid(),
  eventId: z.string().optional()
});
const eventRecord = z
  .record(z.string(), z.unknown())
  .refine((value) => typeof value.id === 'string' && value.id.length > 0);
const eventTime = z.object({
  date: z.string().max(10).optional(),
  dateTime: z.string().max(100).optional(),
  timeZone: z.string().max(100).optional()
});
const eventReceipt = z.object({
  id: accountResourceId,
  summary: z.string().max(1000).optional(),
  subject: z.string().max(1000).optional(),
  start: eventTime.optional(),
  end: eventTime.optional(),
  htmlLink: z.string().max(8192).optional(),
  webLink: z.string().max(8192).optional(),
  etag: z.string().max(2048).optional(),
  status: z.string().max(100).optional(),
  isCancelled: z.boolean().optional()
});
const Created = z.object({
  status: z.literal('created'),
  operationId: z.uuid(),
  event: eventReceipt,
  recovered: z.boolean()
});
export type AccountCalendarCreation =
  | z.infer<typeof Created>
  | { status: 'uncertain'; operationId: string; message: string };
const uncertain = (id: string): AccountCalendarCreation => ({
  status: 'uncertain',
  operationId: id,
  message:
    'The provider may have created this event. Retry this same operation to check its recorded identity; do not create another event or claim success.'
});

/** Records intent before creation and reconciles by provider identity after an uncertain response. */
export async function createAccountCalendarEvent(
  api: AccountApi,
  input: z.input<typeof AccountCalendarCreate>,
  operation: AccountOperation,
  scopes: readonly ConnectorScope[]
): Promise<AccountCalendarCreation> {
  api.requireScope(scopes, 'calendar:events.write');
  const parsed = AccountCalendarCreate.parse(input);
  z.uuid().parse(operation.id);
  operation.signal.throwIfAborted();
  if (operation.completed) {
    const result = Created.parse(operation.result);
    if (result.operationId !== operation.id)
      throw new AthanorError(
        'connector_operation_context',
        'The calendar receipt belongs to another operation.'
      );
    return result;
  }
  const google = api.secret.provider === 'google';
  const eventId = `garden${operation.id.replaceAll('-', '')}`;
  const collection = google
    ? api.url(
        'googleCalendar',
        `calendars/${encodeURIComponent(parsed.calendarId ?? 'primary')}/events`
      )
    : api.url(
        'graph',
        parsed.calendarId ? `calendars/${encodeURIComponent(parsed.calendarId)}/events` : 'events'
      );
  const saved =
    operation.recovery === null || operation.recovery === undefined
      ? null
      : Recovery.parse(operation.recovery);
  if (saved && saved.operationId !== operation.id)
    throw new AthanorError(
      'connector_operation_context',
      'The calendar checkpoint belongs to another operation.'
    );
  const finish = async (
    event: Record<string, unknown>,
    recovered: boolean
  ): Promise<AccountCalendarCreation> => {
    eventRecord.parse(event);
    if (google && event.id !== eventId)
      throw new AthanorError(
        'connector_response_invalid',
        'The calendar returned a different event identity.'
      );
    if (event.status === 'cancelled' || event.isCancelled === true) return uncertain(operation.id);
    const receipt = {
      status: 'created' as const,
      operationId: operation.id,
      event: eventReceipt.parse(event),
      recovered
    };
    await operation.complete(receipt);
    return receipt;
  };
  if (saved?.phase === 'submitted') {
    try {
      if (google) {
        const event = await api.json(new URL(`${collection.pathname}/${eventId}`, collection));
        const properties = z
          .object({ private: z.record(z.string(), z.string()) })
          .safeParse(event.extendedProperties);
        if (!properties.success || properties.data.private.gardenOperation !== operation.id)
          return uncertain(operation.id);
        return await finish(event, true);
      }
      const query = new URL(collection);
      query.searchParams.set(
        '$filter',
        `singleValueExtendedProperties/Any(p:p/id eq '${graphOperationProperty}' and p/value eq '${operation.id}')`
      );
      query.searchParams.set(
        '$expand',
        `singleValueExtendedProperties($filter=id eq '${graphOperationProperty}')`
      );
      query.searchParams.set('$top', '2');
      const response = await api.json(query);
      const matches = z.array(eventRecord).parse(response.value);
      if (matches.length !== 1 || response['@odata.nextLink']) return uncertain(operation.id);
      const event = matches[0]!;
      const properties = z
        .array(z.object({ id: z.string(), value: z.string() }))
        .safeParse(event.singleValueExtendedProperties);
      if (
        !properties.success ||
        !properties.data.some(
          (property) => property.id === graphOperationProperty && property.value === operation.id
        )
      )
        return uncertain(operation.id);
      return await finish(event, true);
    } catch (error) {
      if (error instanceof AthanorError && error.code === 'connector_resource_not_found')
        return uncertain(operation.id);
      throw error;
    }
  }
  const start = parsed.allDay
    ? google
      ? { date: parsed.start }
      : { dateTime: parsed.start + 'T00:00:00', timeZone: parsed.timeZone }
    : google
      ? { dateTime: parsed.start }
      : { dateTime: new Date(parsed.start).toISOString().slice(0, -1), timeZone: 'UTC' };
  const end = parsed.allDay
    ? google
      ? { date: parsed.end }
      : { dateTime: parsed.end + 'T00:00:00', timeZone: parsed.timeZone }
    : google
      ? { dateTime: parsed.end }
      : { dateTime: new Date(parsed.end).toISOString().slice(0, -1), timeZone: 'UTC' };
  const body = google
    ? {
        id: eventId,
        summary: parsed.summary,
        description: parsed.description,
        location: parsed.location,
        start,
        end,
        attendees: parsed.attendees.map((value) => ({
          email: value.address,
          ...(value.name ? { displayName: value.name } : {})
        })),
        extendedProperties: { private: { gardenOperation: operation.id } }
      }
    : {
        transactionId: operation.id,
        subject: parsed.summary,
        body: { contentType: 'text', content: parsed.description },
        location: { displayName: parsed.location },
        start,
        end,
        isAllDay: parsed.allDay,
        attendees: parsed.attendees.map((value) => ({
          emailAddress: { address: value.address, ...(value.name ? { name: value.name } : {}) },
          type: 'required'
        })),
        singleValueExtendedProperties: [{ id: graphOperationProperty, value: operation.id }]
      };
  if (google) collection.searchParams.set('sendUpdates', 'all');
  const checkpoint = {
    version: 1,
    kind: 'calendar_create',
    phase: 'submitted',
    operationId: operation.id,
    ...(google ? { eventId } : {})
  };
  await operation.checkpoint(checkpoint);
  operation.signal.throwIfAborted();
  try {
    const event = await api.json(collection, { method: 'POST', body });
    return await finish(event, false);
  } catch (error) {
    const status = error instanceof AthanorError ? error.details?.statusCode : undefined;
    // A definitive rejection is retryable; a transport loss or server failure can hide a commit.
    if (
      typeof status === 'number' &&
      [400, 401, 403, 404, 412, 413, 415, 422, 429].includes(status)
    )
      await operation.checkpoint({ ...checkpoint, phase: 'ready' });
    throw error;
  }
}
