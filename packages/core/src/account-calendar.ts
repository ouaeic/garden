import { z } from 'zod';
import { type AccountApi, accountResourceId } from './account-api.js';
import { AthanorError } from './errors.js';

const pageInput = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().max(16384).optional()
});
const rangeInput = pageInput
  .extend({
    calendarId: accountResourceId.optional(),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true })
  })
  .refine(
    (value) => Date.parse(value.end) > Date.parse(value.start),
    'The calendar range must end after it starts.'
  );
const rows = z.array(z.record(z.string(), z.unknown()));
const pageToken = (value: unknown) =>
  value === undefined ? undefined : z.string().min(1).max(8192).parse(value);

function page(
  api: AccountApi,
  collection: URL,
  result: Record<string, unknown>,
  limit: number,
  field: string
) {
  const values = rows.parse(result[field] ?? (api.secret.provider === 'google' ? [] : undefined));
  if (values.length > limit)
    throw new AthanorError(
      'calendar_page_invalid',
      'The account provider exceeded the requested page size.'
    );
  let next = pageToken(result['@odata.nextLink']);
  if (api.secret.provider === 'google' && result.nextPageToken) {
    const url = new URL(collection);
    url.searchParams.set('pageToken', pageToken(result.nextPageToken)!);
    next = url.toString();
  }
  return { values, nextCursor: api.nextCursor(collection, next) };
}

export async function listAccountCalendars(api: AccountApi, input: z.input<typeof pageInput> = {}) {
  const parsed = pageInput.parse(input);
  const collection =
    api.secret.provider === 'google'
      ? api.url('googleCalendar', 'users/me/calendarList', { maxResults: String(parsed.limit) })
      : api.url('graph', 'calendars', {
          $top: String(parsed.limit),
          $select: 'id,name,owner,canEdit,isDefaultCalendar'
        });
  const result = page(
    api,
    collection,
    await api.json(api.pageUrl(collection, parsed.cursor)),
    parsed.limit,
    api.secret.provider === 'google' ? 'items' : 'value'
  );
  return { calendars: result.values, nextCursor: result.nextCursor };
}

export async function readAccountCalendarRange(api: AccountApi, input: z.input<typeof rangeInput>) {
  const parsed = rangeInput.parse(input);
  const collection =
    api.secret.provider === 'google'
      ? api.url(
          'googleCalendar',
          `calendars/${encodeURIComponent(parsed.calendarId ?? 'primary')}/events`,
          {
            timeMin: parsed.start,
            timeMax: parsed.end,
            singleEvents: 'true',
            orderBy: 'startTime',
            maxResults: String(parsed.limit)
          }
        )
      : api.url(
          'graph',
          parsed.calendarId
            ? `calendars/${encodeURIComponent(parsed.calendarId)}/calendarView`
            : 'calendarView',
          {
            startDateTime: parsed.start,
            endDateTime: parsed.end,
            $top: String(parsed.limit),
            $select:
              'id,subject,bodyPreview,start,end,isAllDay,isCancelled,location,organizer,attendees,responseStatus,seriesMasterId,webLink'
          }
        );
  const raw = await api.json(api.pageUrl(collection, parsed.cursor));
  const result = page(
    api,
    collection,
    raw,
    parsed.limit,
    api.secret.provider === 'google' ? 'items' : 'value'
  );
  return {
    events: result.values,
    nextCursor: result.nextCursor,
    range: { start: parsed.start, end: parsed.end },
    ...(api.secret.provider === 'google' ? { timeZone: raw.timeZone } : {})
  };
}
