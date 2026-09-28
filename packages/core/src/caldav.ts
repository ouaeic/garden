/**
 * CalDAV (RFC 4791) over the same guarded HTTPS transport the other connectors use.
 *
 * CalDAV is WebDAV with two extra verbs' worth of behaviour, so the transport, the address checks
 * and the redirect refusal all come for free; what is here is the XML the protocol speaks and the
 * discovery walk from "the URL the owner pasted" to "the calendars they actually have".
 *
 * The XML reader is deliberately a scanner rather than a parser: DAV responses are a shallow,
 * predictable shape, and a scanner with hard limits cannot be talked into expanding an entity or
 * following a doctype.
 */
import { GardenError } from './errors.js';
import type { ConnectorRequestResult, ConnectorTransport } from './connectors.js';

export interface XmlNode {
  name: string;
  children: XmlNode[];
  text: string;
}

const MAX_XML_BYTES = 4 * 1024 * 1024;
const MAX_XML_NODES = 20_000;
const MAX_XML_DEPTH = 24;

const decodeXmlText = (value: string): string =>
  value.replaceAll(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    const code = entity.startsWith('#x')
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000
      ? String.fromCodePoint(code)
      : whole;
  });

const localName = (tag: string): string => {
  const name = tag.split(/[\s/>]/)[0] ?? '';
  return (name.split(':').pop() ?? name).toLowerCase();
};

export const parseXml = (input: string): XmlNode => {
  if (input.length > MAX_XML_BYTES)
    throw new GardenError('caldav_response_too_large', 'The calendar server sent too much XML');
  const root: XmlNode = { name: '#document', children: [], text: '' };
  const stack: XmlNode[] = [root];
  // Opens that were refused a place on the stack because the document is deeper than we will
  // follow. Their closing tags have to be swallowed here rather than popping a real ancestor:
  // popping one closes an element that is still open, and every element after it reattaches to
  // the wrong parent. Measured on a 30-deep document, a top-level sibling of the deep subtree
  // ended up inside it, and a <response>'s calendar-data came back empty.
  let suppressed = 0;
  let nodes = 0;
  let index = 0;
  while (index < input.length) {
    const open = input.indexOf('<', index);
    if (open < 0) break;
    if (open > index) {
      const text = decodeXmlText(input.slice(index, open));
      const parent = stack[stack.length - 1]!;
      if (text.trim()) parent.text += text;
    }
    if (input.startsWith('<!--', open)) {
      const end = input.indexOf('-->', open);
      index = end < 0 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith('<![CDATA[', open)) {
      const end = input.indexOf(']]>', open);
      const body = input.slice(open + 9, end < 0 ? input.length : end);
      stack[stack.length - 1]!.text += body;
      index = end < 0 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith('<?', open) || input.startsWith('<!', open)) {
      const end = input.indexOf('>', open);
      index = end < 0 ? input.length : end + 1;
      continue;
    }
    const close = input.indexOf('>', open);
    if (close < 0) break;
    const tag = input.slice(open + 1, close);
    index = close + 1;
    if (tag.startsWith('/')) {
      if (suppressed > 0) suppressed -= 1;
      else if (stack.length > 1) stack.pop();
      continue;
    }
    nodes += 1;
    if (nodes > MAX_XML_NODES)
      throw new GardenError('caldav_response_too_large', 'The calendar server sent too much XML');
    const node: XmlNode = { name: localName(tag), children: [], text: '' };
    stack[stack.length - 1]!.children.push(node);
    if (tag.endsWith('/')) continue;
    // Over the depth limit the subtree is flattened onto the deepest node we did keep - less,
    // rather than a guess - but the stack stays balanced so the rest of the document is intact.
    if (stack.length < MAX_XML_DEPTH) stack.push(node);
    else suppressed += 1;
  }
  return root;
};

export const findAll = (node: XmlNode, name: string): XmlNode[] => {
  const found: XmlNode[] = [];
  const visit = (current: XmlNode) => {
    for (const child of current.children) {
      if (child.name === name) found.push(child);
      visit(child);
    }
  };
  visit(node);
  return found;
};

export const findFirst = (node: XmlNode, name: string): XmlNode | undefined =>
  findAll(node, name)[0];

export interface CalDavContext {
  baseUrl: URL;
  headers: Record<string, string>;
  transport: ConnectorTransport;
  allowedHostSuffixes: string[];
}

/**
 * Every href a calendar server hands back is resolved against the connector's own origin and then
 * required to still be on it. A calendar server is the owner's, but it is still the far side of
 * the connection: an href pointing somewhere else is an instruction to send the owner's password
 * to a third party, and it never gets to be one.
 */
export const resolveHref = (context: CalDavContext, href: string): URL => {
  let url: URL;
  try {
    url = new URL(href.trim(), context.baseUrl);
  } catch {
    throw new GardenError(
      'caldav_href_invalid',
      'The calendar server returned an unusable address'
    );
  }
  if (url.origin !== context.baseUrl.origin)
    throw new GardenError(
      'caldav_href_invalid',
      'The calendar server pointed at a different host, which garden will not follow'
    );
  url.hash = '';
  return url;
};

const request = async (
  context: CalDavContext,
  input: {
    url: URL;
    method: string;
    body?: string;
    headers?: Record<string, string>;
    allowedStatuses?: number[];
    maxResponseBytes?: number;
  }
): Promise<ConnectorRequestResult> => {
  const response = await context.transport({
    url: input.url,
    method: input.method,
    headers: { ...context.headers, ...input.headers },
    ...(input.body ? { body: Buffer.from(input.body, 'utf8') } : {}),
    allowedHostSuffixes: context.allowedHostSuffixes,
    timeoutMs: 30_000,
    maxResponseBytes: input.maxResponseBytes ?? 2_000_000
  });
  const allowed = input.allowedStatuses ?? [200, 207];
  if (!allowed.includes(response.status)) {
    // If-Match and If-None-Match exist to produce exactly this answer, and until it had its own
    // code it was indistinguishable from the server being broken: "answered 412" told the owner
    // nothing about the one thing that is true and actionable - somebody else changed this event
    // since garden read it, so re-read and decide again. 409 and 423 are the same conversation.
    if ([409, 412, 423].includes(response.status))
      throw new GardenError(
        'caldav_precondition_failed',
        response.status === 423
          ? 'The calendar server has this event locked by another client'
          : 'This event changed on the server since garden read it, so the change was not applied',
        409,
        { status: response.status }
      );
    // The status stays spelled out in the message because the owner-facing copy scrapes it back
    // out with /answered (\d{3})/; details carries it in a form that does not depend on prose.
    throw new GardenError(
      'caldav_request_failed',
      `The calendar server answered ${response.status}`,
      400,
      { status: response.status }
    );
  }
  return response;
};

const propfind = async (
  context: CalDavContext,
  url: URL,
  depth: '0' | '1',
  properties: string
): Promise<XmlNode> => {
  const response = await request(context, {
    url,
    method: 'PROPFIND',
    headers: { depth, 'content-type': 'application/xml; charset=utf-8' },
    body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"><d:prop>${properties}</d:prop></d:propfind>`
  });
  return parseXml(response.body.toString('utf8'));
};

export interface CalDavCalendar {
  url: string;
  name: string;
  description: string | null;
  color: string | null;
  readOnly: boolean;
}

const responseHref = (node: XmlNode): string => findFirst(node, 'href')?.text.trim() ?? '';

const calendarsFrom = (context: CalDavContext, document: XmlNode): CalDavCalendar[] => {
  const calendars: CalDavCalendar[] = [];
  for (const entry of findAll(document, 'response').slice(0, 500)) {
    const resourceType = findFirst(entry, 'resourcetype');
    if (!resourceType || !findFirst(resourceType, 'calendar')) continue;
    const href = responseHref(entry);
    if (!href) continue;
    const privileges = findAll(entry, 'privilege')
      .flatMap((privilege) => privilege.children.map((child) => child.name))
      .filter(Boolean);
    calendars.push({
      url: resolveHref(context, href).toString(),
      name: findFirst(entry, 'displayname')?.text.trim() || href,
      description: findFirst(entry, 'calendar-description')?.text.trim() || null,
      color: findFirst(entry, 'calendar-color')?.text.trim() || null,
      readOnly: privileges.length > 0 && !privileges.includes('write-content')
    });
  }
  return calendars;
};

/**
 * The walk RFC 6764 prescribes: principal, then calendar home, then the collections inside it.
 * Each hop is allowed to fail, because plenty of servers are happy to answer a PROPFIND on the URL
 * the owner pasted and nothing else - and a URL that is already the calendar home is the single
 * most common thing an owner pastes.
 */
export const discoverCalendars = async (context: CalDavContext): Promise<CalDavCalendar[]> => {
  const homes: URL[] = [];
  try {
    const principalDocument = await propfind(
      context,
      context.baseUrl,
      '0',
      '<d:current-user-principal/>'
    );
    const principalHref = findFirst(
      findFirst(principalDocument, 'current-user-principal') ?? principalDocument,
      'href'
    )?.text;
    if (principalHref) {
      const homeDocument = await propfind(
        context,
        resolveHref(context, principalHref),
        '0',
        '<c:calendar-home-set/>'
      );
      for (const home of findAll(
        findFirst(homeDocument, 'calendar-home-set') ?? homeDocument,
        'href'
      ))
        homes.push(resolveHref(context, home.text));
    }
  } catch {
    // Discovery is a convenience; the pasted URL is the contract.
  }
  if (!homes.length) homes.push(context.baseUrl);
  const properties =
    '<d:resourcetype/><d:displayname/><d:current-user-privilege-set/><c:calendar-description/><cs:getctag/>';
  const calendars: CalDavCalendar[] = [];
  for (const home of homes.slice(0, 5))
    calendars.push(...calendarsFrom(context, await propfind(context, home, '1', properties)));
  const seen = new Set<string>();
  return calendars.filter((calendar) => {
    if (seen.has(calendar.url)) return false;
    seen.add(calendar.url);
    return true;
  });
};

const icalStamp = (iso: string): string => {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed))
    throw new GardenError('calendar_range_invalid', `"${iso}" is not a date and time`);
  return `${new Date(parsed).toISOString().replaceAll(/[-:]/g, '').slice(0, 15)}Z`;
};

export interface CalDavObject {
  url: string;
  etag: string | null;
  calendarData: string;
}

const objectsFrom = (context: CalDavContext, document: XmlNode, limit: number): CalDavObject[] =>
  findAll(document, 'response')
    // Everything a response has to have is checked before the limit is applied. It used to be
    // checked after, so a multistatus whose first entries carry no VCALENDAR - a 404 propstat,
    // a collection listed alongside its members - spent the caller's budget on rows that were
    // then dropped, and a range that did contain `limit` events came back short.
    .filter((entry) => {
      const data = findFirst(entry, 'calendar-data')?.text;
      return Boolean(responseHref(entry) && data && data.includes('BEGIN:VCALENDAR'));
    })
    .slice(0, limit)
    .map((entry) => ({
      url: resolveHref(context, responseHref(entry)).toString(),
      etag: findFirst(entry, 'getetag')?.text.trim().replace(/^W\//, '') || null,
      calendarData: findFirst(entry, 'calendar-data')?.text ?? ''
    }));

/**
 * The server-side expansion is asked for first because an unexpanded weekly meeting comes back
 * once, on the day it was created, which is a wrong answer rather than a partial one. Servers that
 * do not implement it say so with a 4xx, and the caller is told the result is unexpanded.
 */
export const readEventRange = async (
  context: CalDavContext,
  calendarUrl: URL,
  start: string,
  end: string,
  limit: number
): Promise<{ objects: CalDavObject[]; expanded: boolean }> => {
  const range = `<c:time-range start="${icalStamp(start)}" end="${icalStamp(end)}"/>`;
  const report = (expand: boolean) =>
    request(context, {
      url: calendarUrl,
      method: 'REPORT',
      headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
      body: `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data>${
        expand ? `<c:expand start="${icalStamp(start)}" end="${icalStamp(end)}"/>` : ''
      }</c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">${range}</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
      allowedStatuses: [207]
    });
  try {
    return {
      objects: objectsFrom(context, parseXml((await report(true)).body.toString('utf8')), limit),
      expanded: true
    };
  } catch (error) {
    // Only "the server refused this request", and only in the 4xx range, is evidence that expand
    // is the thing it will not do. Retrying on every GardenError sent a second full REPORT after
    // a blocked redirect, a response that was already too large, and a transport timeout - which
    // on a stalled server doubles a 30-second wait into a minute and then reports the second
    // failure in place of the first. Measured: a blocked redirect produced two transport calls.
    const status = error instanceof GardenError ? Number(error.details?.['status'] ?? 0) : 0;
    if (
      !(error instanceof GardenError) ||
      error.code !== 'caldav_request_failed' ||
      status < 400 ||
      status >= 500
    )
      throw error;
    return {
      objects: objectsFrom(context, parseXml((await report(false)).body.toString('utf8')), limit),
      expanded: false
    };
  }
};

export const readEvent = async (context: CalDavContext, url: URL): Promise<CalDavObject> => {
  const response = await request(context, {
    url,
    method: 'GET',
    headers: { accept: 'text/calendar' },
    allowedStatuses: [200]
  });
  return {
    url: url.toString(),
    etag: (response.headers.etag ?? '').trim().replace(/^W\//, '') || null,
    calendarData: response.body.toString('utf8')
  };
};

/**
 * If-Match on update and If-None-Match on create are the whole concurrency story: without them a
 * connector that re-sends a stale copy silently reverts a change the owner made on their phone
 * thirty seconds earlier.
 */
export const writeEvent = async (
  context: CalDavContext,
  url: URL,
  calendarData: string,
  precondition: { ifMatch: string } | { create: true }
): Promise<{ etag: string | null; statusCode: number }> => {
  const response = await request(context, {
    url,
    method: 'PUT',
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      ...('ifMatch' in precondition
        ? { 'if-match': precondition.ifMatch }
        : { 'if-none-match': '*' })
    },
    body: calendarData,
    allowedStatuses: [200, 201, 204]
  });
  return {
    etag: (response.headers.etag ?? '').trim().replace(/^W\//, '') || null,
    statusCode: response.status
  };
};
