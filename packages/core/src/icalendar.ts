/**
 * iCalendar (RFC 5545) in the subset a calendar connector needs: read a VEVENT well enough to
 * tell the owner what is happening and when, and write one back that every CalDAV server and
 * every desktop client will accept.
 *
 * Written here rather than taken from a library for the same reason as the MIME parser: calendar
 * objects arrive from other people's invitations, the format is line-oriented and small, and the
 * failure mode of a wrong answer - a meeting an hour out - is worse than the failure mode of an
 * unsupported property.
 */
import { GardenError } from './errors.js';

export interface IcalProperty {
  name: string;
  parameters: Map<string, string>;
  value: string;
}

export interface IcalComponent {
  name: string;
  properties: IcalProperty[];
  components: IcalComponent[];
}

const MAX_LINES = 50_000;
const MAX_DEPTH = 8;

const unescapeValue = (value: string): string =>
  value.replaceAll(/\\([\\;,nNtT])/g, (_, character: string) =>
    character === 'n' || character === 'N'
      ? '\n'
      : character === 't' || character === 'T'
        ? '\t'
        : character
  );

const escapeValue = (value: string): string =>
  value
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replaceAll(/\r?\n/g, '\\n');

/**
 * Properties whose value is structured rather than text: ';' and ',' inside them are RFC 5545
 * separators, not characters, so escaping them corrupts the value. `RRULE:FREQ=WEEKLY;BYDAY=TU`
 * went out as `FREQ=WEEKLY\;BYDAY=TU` and `CATEGORIES:Work,Planning` as `Work\,Planning`. Our own
 * parser unescaped both again, which is why no round-trip test ever saw it - but answering a
 * repeating invitation writes the whole VCALENDAR back to a CalDAV server, and that server reads
 * one malformed rule part. A line break is still impossible in any of these values, so writing
 * them through unescaped costs nothing; `escapeValue` stays exactly as it was for text.
 */
const STRUCTURED_VALUE_PROPERTIES = new Set([
  'RRULE',
  'EXRULE',
  'RDATE',
  'EXDATE',
  'CATEGORIES',
  'RESOURCES',
  'FREEBUSY',
  'GEO',
  'REQUEST-STATUS'
]);

/**
 * Parameter values carry the caret escapes of RFC 6868 rather than the backslash escapes of a
 * property value, and a quoted parameter value cannot contain a '"' at all. Writing one through
 * raw produced `CN="Doe, "JJ" Jane"` from an ordinary attendee whose name has a nickname in it -
 * a line no conforming reader can parse, PUT straight back at the server on accept or update.
 * Encoding on the way out only stays honest if we decode on the way in, so both directions live
 * here together; without the pair, a `^'` a server sent would go back out as `^^'`.
 */
const decodeParameterValue = (value: string): string =>
  value.replaceAll(/\^([n^'])/g, (_, character: string) =>
    character === 'n' ? '\n' : character === "'" ? '"' : '^'
  );

const encodeParameterValue = (value: string): string =>
  value.replaceAll('^', '^^').replaceAll('"', "^'").replaceAll(/\r?\n/g, '^n');

const unfoldLines = (text: string): string[] => {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (lines.length >= MAX_LINES) break;
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += line.slice(1);
    else if (line.length) lines.push(line);
  }
  return lines;
};

const parseContentLine = (line: string): IcalProperty | null => {
  let inQuotes = false;
  let colon = -1;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') inQuotes = !inQuotes;
    else if (character === ':' && !inQuotes) {
      colon = index;
      break;
    }
  }
  if (colon <= 0) return null;
  const head = line.slice(0, colon);
  const segments: string[] = [];
  let current = '';
  inQuotes = false;
  for (const character of head) {
    if (character === '"') inQuotes = !inQuotes;
    if (character === ';' && !inQuotes) {
      segments.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  segments.push(current);
  const parameters = new Map<string, string>();
  for (const segment of segments.slice(1)) {
    const equals = segment.indexOf('=');
    if (equals <= 0) continue;
    parameters.set(
      segment.slice(0, equals).toUpperCase(),
      decodeParameterValue(
        segment
          .slice(equals + 1)
          .trim()
          .replace(/^"(.*)"$/, '$1')
      )
    );
  }
  return {
    name: (segments[0] ?? '').toUpperCase(),
    parameters,
    value: unescapeValue(line.slice(colon + 1))
  };
};

/** Returns every top-level component; a CalDAV response may legitimately carry more than one. */
export const parseIcalendar = (text: string): IcalComponent[] => {
  const roots: IcalComponent[] = [];
  const stack: IcalComponent[] = [];
  for (const line of unfoldLines(text)) {
    const property = parseContentLine(line);
    if (!property) continue;
    if (property.name === 'BEGIN') {
      if (stack.length >= MAX_DEPTH) return roots;
      const component: IcalComponent = {
        name: property.value.toUpperCase(),
        properties: [],
        components: []
      };
      const parent = stack[stack.length - 1];
      if (parent) parent.components.push(component);
      else roots.push(component);
      stack.push(component);
      continue;
    }
    if (property.name === 'END') {
      stack.pop();
      continue;
    }
    stack[stack.length - 1]?.properties.push(property);
  }
  return roots;
};

const foldLine = (line: string): string => {
  if (Buffer.byteLength(line, 'utf8') <= 73) return line;
  const pieces: string[] = [];
  let current = '';
  for (const character of line) {
    if (Buffer.byteLength(current + character, 'utf8') > 73) {
      pieces.push(current);
      current = ' ';
    }
    current += character;
  }
  pieces.push(current);
  return pieces.join('\r\n');
};

export const serializeIcalendar = (component: IcalComponent): string => {
  const lines: string[] = [`BEGIN:${component.name}`];
  for (const property of component.properties) {
    const parameters = [...property.parameters]
      .map(([name, value]) => {
        const encoded = encodeParameterValue(value);
        return `;${name}=${/[;:,]/.test(encoded) ? `"${encoded}"` : encoded}`;
      })
      .join('');
    // Structured values go out verbatim, minus any line break. Nothing legitimate puts one there,
    // but a parsed value can hold one - `\n` in an incoming line is unescaped on the way in - and
    // writing it raw would end the content line early and let the rest of it pose as a property.
    const value = STRUCTURED_VALUE_PROPERTIES.has(property.name)
      ? property.value.replaceAll(/\r?\n/g, ' ')
      : escapeValue(property.value);
    lines.push(foldLine(`${property.name}${parameters}:${value}`));
  }
  for (const child of component.components) lines.push(serializeIcalendar(child));
  lines.push(`END:${component.name}`);
  return lines.join('\r\n');
};

const zoneOffsetMinutes = (instant: number, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(new Date(instant));
  const field = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour') % 24,
    field('minute'),
    field('second')
  );
  return (asUtc - instant) / 60_000;
};

const isKnownTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
};

/**
 * A wall-clock time in a named zone converted to an instant. The second pass is what makes the
 * hour either side of a DST change come out right: the offset that applies is the one in force at
 * the answer, not the one in force at the guess.
 */
const wallClockToInstant = (
  parts: [number, number, number, number, number, number],
  timeZone: string
): number => {
  const guess = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
  const first = zoneOffsetMinutes(guess, timeZone);
  const candidate = guess - first * 60_000;
  const second = zoneOffsetMinutes(candidate, timeZone);
  return second === first ? candidate : guess - second * 60_000;
};

export interface IcalMoment {
  /** ISO 8601. A UTC instant when one could be established, otherwise the local wall clock. */
  value: string;
  allDay: boolean;
  timeZone: string | null;
  /** True when the value is a wall clock with no zone: it means "whenever it is there". */
  floating: boolean;
}

const digits = (value: string, start: number, length: number): number =>
  Number(value.slice(start, start + length));

export const parseIcalMoment = (property: IcalProperty): IcalMoment | null => {
  const raw = property.value.trim();
  const timeZone = property.parameters.get('TZID') ?? null;
  if (/^\d{8}$/.test(raw) || property.parameters.get('VALUE') === 'DATE') {
    if (!/^\d{8}/.test(raw)) return null;
    return {
      value: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`,
      allDay: true,
      timeZone: null,
      floating: false
    };
  }
  const match = /^(\d{8})T(\d{6})(Z?)$/.exec(raw);
  if (!match) return null;
  const [, date = '', time = '', zulu = ''] = match;
  const parts: [number, number, number, number, number, number] = [
    digits(date, 0, 4),
    digits(date, 4, 2),
    digits(date, 6, 2),
    digits(time, 0, 2),
    digits(time, 2, 2),
    digits(time, 4, 2)
  ];
  if (zulu === 'Z')
    return {
      value: new Date(
        Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5])
      ).toISOString(),
      allDay: false,
      timeZone: 'UTC',
      floating: false
    };
  if (timeZone && isKnownTimeZone(timeZone))
    return {
      value: new Date(wallClockToInstant(parts, timeZone)).toISOString(),
      allDay: false,
      timeZone,
      floating: false
    };
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return {
    value: `${pad(parts[0], 4)}-${pad(parts[1])}-${pad(parts[2])}T${pad(parts[3])}:${pad(parts[4])}:${pad(parts[5])}`,
    allDay: false,
    timeZone,
    floating: true
  };
};

export type ParticipationStatus =
  | 'accepted'
  | 'declined'
  | 'tentative'
  | 'needs-action'
  | 'delegated';

export interface CalendarAttendee {
  name: string | null;
  address: string;
  participationStatus: ParticipationStatus;
  role: string;
}

export interface CalendarEvent {
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  start: IcalMoment | null;
  end: IcalMoment | null;
  status: string | null;
  organizer: { name: string | null; address: string } | null;
  attendees: CalendarAttendee[];
  /** The RRULE as written. garden reads recurrence back but never composes one. */
  recurrenceRule: string | null;
  sequence: number;
  lastModified: string | null;
}

const property = (component: IcalComponent, name: string): IcalProperty | undefined =>
  component.properties.find((entry) => entry.name === name);

const calendarAddress = (value: string): string =>
  value
    .trim()
    .replace(/^mailto:/i, '')
    .toLowerCase();

const participationStatus = (value: string | undefined): ParticipationStatus => {
  const normalized = (value ?? '').toUpperCase();
  if (normalized === 'ACCEPTED') return 'accepted';
  if (normalized === 'DECLINED') return 'declined';
  if (normalized === 'TENTATIVE') return 'tentative';
  if (normalized === 'DELEGATED') return 'delegated';
  return 'needs-action';
};

export const eventFromComponent = (component: IcalComponent): CalendarEvent => {
  const start = property(component, 'DTSTART');
  const end = property(component, 'DTEND') ?? property(component, 'DUE');
  const organizer = property(component, 'ORGANIZER');
  const lastModified = property(component, 'LAST-MODIFIED')?.value ?? '';
  return {
    uid: property(component, 'UID')?.value ?? '',
    summary: property(component, 'SUMMARY')?.value ?? '',
    description: property(component, 'DESCRIPTION')?.value ?? null,
    location: property(component, 'LOCATION')?.value ?? null,
    start: start ? parseIcalMoment(start) : null,
    end: end ? parseIcalMoment(end) : null,
    status: property(component, 'STATUS')?.value.toLowerCase() ?? null,
    organizer: organizer
      ? {
          name: organizer.parameters.get('CN') ?? null,
          address: calendarAddress(organizer.value)
        }
      : null,
    attendees: component.properties
      .filter((entry) => entry.name === 'ATTENDEE')
      .slice(0, 200)
      .map((entry) => ({
        name: entry.parameters.get('CN') ?? null,
        address: calendarAddress(entry.value),
        participationStatus: participationStatus(entry.parameters.get('PARTSTAT')),
        role: entry.parameters.get('ROLE') ?? 'REQ-PARTICIPANT'
      })),
    recurrenceRule: property(component, 'RRULE')?.value ?? null,
    sequence: Number(property(component, 'SEQUENCE')?.value ?? '0') || 0,
    lastModified: /^\d{8}T\d{6}Z$/.test(lastModified)
      ? (parseIcalMoment({ name: 'LAST-MODIFIED', parameters: new Map(), value: lastModified })
          ?.value ?? null)
      : null
  };
};

const icalUtcStamp = (instant: Date): string =>
  `${instant.toISOString().replaceAll(/[-:]/g, '').slice(0, 15)}Z`;

const icalDate = (value: string): string => value.replaceAll('-', '');

export interface EventDraft {
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  /** A UTC instant for a timed event, or a plain YYYY-MM-DD for an all-day one. */
  start: string;
  end: string;
  allDay: boolean;
  attendees?: Array<{ address: string; name?: string }>;
  organizer?: { address: string; name?: string };
  sequence?: number;
}

const assertNoBreaks = (value: string, field: string): string => {
  if (/[\r\n]/.test(value) || value.includes(String.fromCharCode(0)))
    throw new GardenError(
      'calendar_value_invalid',
      `The ${field} value contains a line break and cannot be written`
    );
  return value;
};

/**
 * Timed events are written as UTC instants and all-day events as VALUE=DATE. Refusing to write a
 * floating or TZID-bearing DTSTART is the whole reason this never needs a bundled zone database:
 * the instant is unambiguous, and every client renders it in the reader's own zone.
 */
export const buildEventComponent = (draft: EventDraft): IcalComponent => {
  const now = new Date();
  const moment = (value: string, field: string): IcalProperty => {
    if (draft.allDay) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
        throw new GardenError(
          'calendar_value_invalid',
          `An all-day event needs ${field} as YYYY-MM-DD`
        );
      return {
        name: field,
        parameters: new Map([['VALUE', 'DATE']]),
        value: icalDate(value)
      };
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed))
      throw new GardenError('calendar_value_invalid', `${field} is not a valid date and time`);
    return { name: field, parameters: new Map(), value: icalUtcStamp(new Date(parsed)) };
  };
  const properties: IcalProperty[] = [
    { name: 'UID', parameters: new Map(), value: assertNoBreaks(draft.uid, 'uid') },
    { name: 'DTSTAMP', parameters: new Map(), value: icalUtcStamp(now) },
    { name: 'SUMMARY', parameters: new Map(), value: draft.summary },
    moment(draft.start, 'DTSTART'),
    moment(draft.end, 'DTEND'),
    { name: 'SEQUENCE', parameters: new Map(), value: String(draft.sequence ?? 0) }
  ];
  if (draft.description)
    properties.push({ name: 'DESCRIPTION', parameters: new Map(), value: draft.description });
  if (draft.location)
    properties.push({ name: 'LOCATION', parameters: new Map(), value: draft.location });
  if (draft.organizer)
    properties.push({
      name: 'ORGANIZER',
      parameters: new Map(
        draft.organizer.name ? [['CN', assertNoBreaks(draft.organizer.name, 'organizer')]] : []
      ),
      value: `mailto:${assertNoBreaks(draft.organizer.address, 'organizer')}`
    });
  for (const attendee of (draft.attendees ?? []).slice(0, 100))
    properties.push({
      name: 'ATTENDEE',
      parameters: new Map([
        ['ROLE', 'REQ-PARTICIPANT'],
        ['PARTSTAT', 'NEEDS-ACTION'],
        ['RSVP', 'TRUE'],
        ...(attendee.name
          ? ([['CN', assertNoBreaks(attendee.name, 'attendee')]] as Array<[string, string]>)
          : [])
      ]),
      value: `mailto:${assertNoBreaks(attendee.address, 'attendee')}`
    });
  return {
    name: 'VCALENDAR',
    properties: [
      { name: 'VERSION', parameters: new Map(), value: '2.0' },
      { name: 'PRODID', parameters: new Map(), value: '-//garden//calendar//EN' },
      { name: 'CALSCALE', parameters: new Map(), value: 'GREGORIAN' }
    ],
    components: [{ name: 'VEVENT', properties, components: [] }]
  };
};

export const findEventComponent = (calendar: IcalComponent): IcalComponent | undefined =>
  calendar.components.find((component) => component.name === 'VEVENT');
