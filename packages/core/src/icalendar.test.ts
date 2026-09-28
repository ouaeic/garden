import { describe, expect, it } from 'vitest';
import {
  buildEventComponent,
  eventFromComponent,
  findEventComponent,
  parseIcalendar,
  serializeIcalendar
} from './icalendar.js';

const calendar = (lines: string[]): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n');

describe('icalendar reading', () => {
  it('reads an invitation with a zoned start, folded lines and escaped text', () => {
    const parsed = parseIcalendar(
      calendar([
        'BEGIN:VEVENT',
        'UID:invite-1@example.test',
        'SUMMARY:Quarterly review\\, London',
        'DESCRIPTION:Line one\\nLine two',
        'LOCATION:Room 4',
        'DTSTART;TZID=Europe/London:20260714T093000',
        'DTEND;TZID=Europe/London:20260714T103000',
        'ORGANIZER;CN=Ada Lovelace:mailto:ada@example.test',
        'ATTENDEE;CN=Owner;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:mailto:owner@exa',
        ' mple.test',
        'RRULE:FREQ=WEEKLY;BYDAY=TU',
        'SEQUENCE:3',
        'END:VEVENT'
      ])
    );
    const event = eventFromComponent(findEventComponent(parsed[0]!)!);
    expect(event.uid).toBe('invite-1@example.test');
    expect(event.summary).toBe('Quarterly review, London');
    expect(event.description).toBe('Line one\nLine two');
    // 09:30 in London in July is 08:30 UTC; the offset has to come from the date, not a constant.
    expect(event.start?.value).toBe('2026-07-14T08:30:00.000Z');
    expect(event.start?.timeZone).toBe('Europe/London');
    expect(event.start?.floating).toBe(false);
    expect(event.attendees).toEqual([
      {
        name: 'Owner',
        address: 'owner@example.test',
        participationStatus: 'needs-action',
        role: 'REQ-PARTICIPANT'
      }
    ]);
    expect(event.organizer).toEqual({ name: 'Ada Lovelace', address: 'ada@example.test' });
    expect(event.recurrenceRule).toBe('FREQ=WEEKLY;BYDAY=TU');
    expect(event.sequence).toBe(3);
  });

  it('puts a winter and a summer wall clock on the right side of the daylight change', () => {
    const at = (stamp: string) =>
      eventFromComponent(
        findEventComponent(
          parseIcalendar(
            calendar(['BEGIN:VEVENT', 'UID:x', `DTSTART;TZID=Europe/London:${stamp}`, 'END:VEVENT'])
          )[0]!
        )!
      ).start?.value;
    expect(at('20260114T120000')).toBe('2026-01-14T12:00:00.000Z');
    expect(at('20260714T120000')).toBe('2026-07-14T11:00:00.000Z');
  });

  it('marks all-day and floating starts for what they are', () => {
    const event = eventFromComponent(
      findEventComponent(
        parseIcalendar(
          calendar(['BEGIN:VEVENT', 'UID:x', 'DTSTART;VALUE=DATE:20260714', 'END:VEVENT'])
        )[0]!
      )!
    );
    expect(event.start).toEqual({
      value: '2026-07-14',
      allDay: true,
      timeZone: null,
      floating: false
    });
    const floating = eventFromComponent(
      findEventComponent(
        parseIcalendar(
          calendar(['BEGIN:VEVENT', 'UID:x', 'DTSTART:20260714T093000', 'END:VEVENT'])
        )[0]!
      )!
    );
    expect(floating.start).toEqual({
      value: '2026-07-14T09:30:00',
      allDay: false,
      timeZone: null,
      floating: true
    });
  });
});

describe('icalendar writing', () => {
  it('writes a timed event as a UTC instant and reads it back unchanged', () => {
    const component = buildEventComponent({
      uid: 'new-1@garden',
      summary: 'Design review; with the team',
      description: 'Bring:\nthe deck',
      location: 'Room 4',
      start: '2026-07-14T09:30:00.000Z',
      end: '2026-07-14T10:30:00.000Z',
      allDay: false,
      attendees: [{ address: 'ada@example.test', name: 'Ada' }],
      organizer: { address: 'owner@example.test' }
    });
    const text = serializeIcalendar(component);
    expect(text).toContain('DTSTART:20260714T093000Z');
    expect(text).toContain('SUMMARY:Design review\\; with the team');
    const event = eventFromComponent(findEventComponent(parseIcalendar(text)[0]!)!);
    expect(event.summary).toBe('Design review; with the team');
    expect(event.description).toBe('Bring:\nthe deck');
    expect(event.start?.value).toBe('2026-07-14T09:30:00.000Z');
    expect(event.attendees[0]).toEqual({
      name: 'Ada',
      address: 'ada@example.test',
      participationStatus: 'needs-action',
      role: 'REQ-PARTICIPANT'
    });
  });

  it('writes an all-day event as a date and refuses a mismatched pair', () => {
    const text = serializeIcalendar(
      buildEventComponent({
        uid: 'new-2@garden',
        summary: 'Leave',
        start: '2026-07-14',
        end: '2026-07-16',
        allDay: true
      })
    );
    expect(text).toContain('DTSTART;VALUE=DATE:20260714');
    expect(() =>
      buildEventComponent({
        uid: 'new-3@garden',
        summary: 'Leave',
        start: '2026-07-14T09:00:00Z',
        end: '2026-07-14T10:00:00Z',
        allDay: true
      })
    ).toThrow('YYYY-MM-DD');
    expect(() =>
      buildEventComponent({
        uid: 'new-4@garden',
        summary: 'Leave',
        start: 'whenever',
        end: 'later',
        allDay: false
      })
    ).toThrow('not a valid date');
  });

  it('folds a long line and unfolds it back to the same value', () => {
    const summary = 'A'.repeat(300);
    const text = serializeIcalendar(
      buildEventComponent({
        uid: 'new-5@garden',
        summary,
        start: '2026-07-14T09:00:00Z',
        end: '2026-07-14T10:00:00Z',
        allDay: false
      })
    );
    expect(text.split('\r\n').every((line) => Buffer.byteLength(line, 'utf8') <= 75)).toBe(true);
    expect(eventFromComponent(findEventComponent(parseIcalendar(text)[0]!)!).summary).toBe(summary);
  });
});
