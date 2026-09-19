/**
 * Reading and writing internet messages, in the subset a mailbox connector actually needs.
 *
 * This is deliberately first-party. Every mail library on npm carries a parser for a format that
 * has thirty years of malformed real-world traffic behind it, and a mailbox is the one place where
 * every byte was written by someone who is not the owner. A parser we can read end to end, that
 * never allocates more than it was told to, and that has no transitive dependencies is worth more
 * here than one that handles a wider slice of exotica.
 *
 * The rule throughout: bounded work, never throw on bad input, and prefer returning less to
 * guessing. A message that cannot be understood comes back as an empty body with its headers
 * intact, because the headers are what the owner is triaging on.
 */
import { randomUUID } from 'node:crypto';
import { AthanorError } from './errors.js';
import { htmlToText } from './mail-html.js';
export { htmlToText } from './mail-html.js';

export interface MimeAddress {
  name: string | null;
  address: string;
}

export interface MimeAttachment {
  /** Dotted index into this message's part tree, stable for a re-parse of the same bytes. */
  partId: string;
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
}

export interface ParsedMessage {
  subject: string;
  from: MimeAddress[];
  to: MimeAddress[];
  cc: MimeAddress[];
  replyTo: MimeAddress[];
  date: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  listUnsubscribe: string | null;
  text: string;
  textTruncated: boolean;
  /** True when the only body athanor could recover came out of an HTML part. */
  textFromHtml: boolean;
  attachments: MimeAttachment[];
}

export interface MimePart {
  partId: string;
  contentType: string;
  filename: string | null;
  content: Buffer;
}

const MAX_DEPTH = 12;
const MAX_PARTS = 200;
const DEFAULT_MAX_TEXT = 100_000;

const decodeCharset = (bytes: Buffer, charset: string): string => {
  const label = charset.trim().toLowerCase() || 'utf-8';
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    // An unregistered or invented charset label is common in spam and in very old clients; UTF-8
    // with replacement characters reads better than refusing the message.
    return bytes.toString('utf8');
  }
};

/**
 * Decoded into a pre-sized Buffer rather than a `number[]`, because quoted-printable never grows -
 * `=XX` shrinks three bytes to one, a soft line break shrinks to nothing, everything else is
 * one-for-one - so the input length is an exact upper bound. Measured through parseMessage on the
 * same 20 MB part: the array form took 276 ms and grew resident memory by 487 MB, this takes 59 ms
 * and 40 MB. `mail_read_attachment` will fetch 25 MB of bytes an attacker wrote.
 */
const decodeQuotedPrintable = (input: Buffer, underscoreIsSpace: boolean): Buffer => {
  const out = Buffer.allocUnsafe(input.length);
  let filled = 0;
  for (let index = 0; index < input.length; index += 1) {
    const byte = input[index]!;
    if (byte === 0x3d) {
      const next = input[index + 1];
      if (next === 0x0d && input[index + 2] === 0x0a) {
        index += 2;
        continue;
      }
      if (next === 0x0a) {
        index += 1;
        continue;
      }
      const hex = input.subarray(index + 1, index + 3).toString('ascii');
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out[filled++] = Number.parseInt(hex, 16);
        index += 2;
        continue;
      }
      out[filled++] = byte;
      continue;
    }
    out[filled++] = underscoreIsSpace && byte === 0x5f ? 0x20 : byte;
  }
  return out.subarray(0, filled);
};

/** RFC 2047 encoded-words. Adjacent words separated only by whitespace join without the gap. */
export const decodeEncodedWords = (value: string): string => {
  if (!value.includes('=?')) return value;
  const pattern = /=\?([^?]{1,64})\?([BbQq])\?([^?]*)\?=/g;
  let result = '';
  let cursor = 0;
  let previousWasWord = false;
  for (const match of value.matchAll(pattern)) {
    const gap = value.slice(cursor, match.index);
    if (!(previousWasWord && gap.trim() === '')) result += gap;
    const [, charset = 'utf-8', encoding = 'q', payload = ''] = match;
    const raw =
      encoding.toLowerCase() === 'b'
        ? Buffer.from(payload, 'base64')
        : decodeQuotedPrintable(Buffer.from(payload, 'binary'), true);
    result += decodeCharset(raw, charset.split('*')[0] ?? 'utf-8');
    cursor = match.index + match[0].length;
    previousWasWord = true;
  }
  return result + value.slice(cursor);
};

const unfold = (block: string): string[] => {
  const lines = block.split(/\r?\n/);
  const headers: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && headers.length) headers[headers.length - 1] += ` ${line.trim()}`;
    else if (line.length) headers.push(line);
  }
  return headers;
};

export type MimeHeaders = Map<string, string[]>;

const parseHeaders = (block: string): MimeHeaders => {
  const headers: MimeHeaders = new Map();
  for (const line of unfold(block)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const existing = headers.get(name);
    if (existing) existing.push(value);
    else headers.set(name, [value]);
  }
  return headers;
};

const headerValue = (headers: MimeHeaders, name: string): string => headers.get(name)?.[0] ?? '';

const splitMessage = (raw: Buffer): { headers: MimeHeaders; body: Buffer } => {
  const separator = raw.indexOf('\r\n\r\n');
  const loose = raw.indexOf('\n\n');
  const [start, skip] =
    separator >= 0 && (loose < 0 || separator <= loose) ? [separator, 4] : [loose, 2];
  if (start < 0) return { headers: parseHeaders(raw.toString('binary')), body: Buffer.alloc(0) };
  return {
    headers: parseHeaders(raw.subarray(0, start).toString('binary')),
    body: raw.subarray(start + skip)
  };
};

interface ContentType {
  type: string;
  subtype: string;
  parameters: Map<string, string>;
}

/** Handles both plain `name="x"` parameters and the RFC 2231 split/charset form. */
const parseParameters = (input: string): Map<string, string> => {
  const parameters = new Map<string, string>();
  const continuations = new Map<string, { charset: string; parts: Map<number, string> }>();
  const pattern = /;\s*([^\s=;]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g;
  for (const match of input.matchAll(pattern)) {
    const rawName = (match[1] ?? '').toLowerCase();
    let value = (match[2] ?? '').trim();
    if (value.startsWith('"')) value = value.slice(1, -1).replaceAll(/\\(.)/g, '$1');
    const extended = /^(.+?)\*(\d+)?(\*)?$/.exec(rawName);
    if (!extended) {
      parameters.set(rawName, decodeEncodedWords(value));
      continue;
    }
    const base = extended[1]!;
    const index = Number(extended[2] ?? '0');
    const encoded = Boolean(extended[3]) || !extended[2];
    let charset = 'utf-8';
    let piece = value;
    if (encoded && index === 0) {
      const segments = value.split("'");
      if (segments.length >= 3) {
        charset = segments[0] || 'utf-8';
        piece = segments.slice(2).join("'");
      }
    }
    if (encoded)
      piece = decodeCharset(
        Buffer.from(
          piece.replaceAll(/%([0-9a-fA-F]{2})/g, (_, hex: string) =>
            String.fromCharCode(Number.parseInt(hex, 16))
          ),
          'binary'
        ),
        charset
      );
    const entry = continuations.get(base) ?? { charset, parts: new Map<number, string>() };
    if (index === 0) entry.charset = charset;
    entry.parts.set(index, piece);
    continuations.set(base, entry);
  }
  for (const [name, entry] of continuations)
    parameters.set(
      name,
      [...entry.parts.keys()]
        .sort((a, b) => a - b)
        .map((key) => entry.parts.get(key) ?? '')
        .join('')
    );
  return parameters;
};

const parseContentType = (value: string): ContentType => {
  const semicolon = value.indexOf(';');
  const head = (semicolon < 0 ? value : value.slice(0, semicolon)).trim().toLowerCase();
  const [type = 'text', subtype = 'plain'] = head.split('/');
  return {
    type: type || 'text',
    subtype: subtype || 'plain',
    parameters: parseParameters(semicolon < 0 ? '' : value.slice(semicolon))
  };
};

const decodeBody = (body: Buffer, encoding: string): Buffer => {
  const normalized = encoding.trim().toLowerCase();
  if (normalized === 'base64')
    return Buffer.from(body.toString('ascii').replaceAll(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (normalized === 'quoted-printable') return decodeQuotedPrintable(body, false);
  return body;
};

/**
 * Address lists, with the parts of RFC 5322 that appear in real mail: quoted display names,
 * comments, groups, and the bare `user@host` an automated sender emits. Anything that does not
 * parse is dropped rather than surfaced as a half-address the owner might reply to.
 */
export const parseAddressList = (input: string): MimeAddress[] => {
  const addresses: MimeAddress[] = [];
  let buffer = '';
  let depth = 0;
  let quoted = false;
  let angled = false;
  const flush = () => {
    const entry = buffer.trim().replace(/;$/, '');
    buffer = '';
    if (!entry || addresses.length >= 200) return;
    const angle = /<([^>]*)>/.exec(entry);
    // Without angle brackets the address is the last whitespace-delimited token, which is what
    // both a bare `user@example.com` and the `Group: user@example.com` form leave behind.
    const tokens = entry.split(/\s+/).filter(Boolean);
    const address = (angle ? (angle[1] ?? '') : (tokens[tokens.length - 1] ?? ''))
      .trim()
      .replace(/^mailto:/i, '');
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) return;
    let name = angle ? entry.slice(0, angle.index).trim() : '';
    if (name.startsWith('"') && name.endsWith('"') && name.length > 1)
      name = name.slice(1, -1).replaceAll(/\\(.)/g, '$1');
    addresses.push({ name: name ? decodeEncodedWords(name) : null, address });
  };
  for (const character of input) {
    if (quoted) {
      quoted = character !== '"';
      buffer += character;
      continue;
    }
    if (character === '"') {
      quoted = true;
      buffer += character;
      continue;
    }
    if (character === '(' && !angled) {
      depth += 1;
      continue;
    }
    if (character === ')' && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth > 0) continue;
    if (character === '<') angled = true;
    if (character === '>') angled = false;
    if (character === ',' && !angled) {
      flush();
      continue;
    }
    buffer += character;
  }
  flush();
  return addresses;
};

interface WalkState {
  text: string[];
  html: string[];
  attachments: MimeAttachment[];
  parts: number;
}

/** Control characters and path separators out: this name may become a workspace file name. */
const safeFilename = (value: string): string => {
  const cleaned = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f || character === '/' || character === '\\'
        ? '_'
        : character;
    })
    .join('')
    .slice(0, 200);
  // A name made only of dots is not a file name, it is a directory hop: joined onto a workspace
  // path, ".." climbs out of it. Callers substitute "attachment" for an empty result.
  return /^\.+$/.test(cleaned) ? '' : cleaned;
};

const isAttachment = (headers: MimeHeaders, contentType: ContentType): string | null => {
  const disposition = headerValue(headers, 'content-disposition');
  const dispositionParameters = parseParameters(`;${disposition.split(';').slice(1).join(';')}`);
  const filename =
    dispositionParameters.get('filename') ?? contentType.parameters.get('name') ?? null;
  if (/^\s*attachment/i.test(disposition)) return filename ?? 'attachment';
  if (filename) return filename;
  if (contentType.type === 'text' && ['plain', 'html'].includes(contentType.subtype)) return null;
  if (contentType.type === 'multipart') return null;
  return 'attachment';
};

const splitMultipart = (body: Buffer, boundary: string): Buffer[] => {
  if (!boundary) return [];
  const marker = Buffer.from(`--${boundary}`);
  const sections: Buffer[] = [];
  let cursor = body.indexOf(marker);
  if (cursor < 0) return [];
  while (cursor >= 0 && sections.length <= MAX_PARTS) {
    const bodyStart = cursor + marker.length;
    if (body.subarray(bodyStart, bodyStart + 2).toString('ascii') === '--') break;
    const next = body.indexOf(marker, bodyStart);
    const lineEnd = body.indexOf(0x0a, bodyStart);
    if (lineEnd < 0) break;
    sections.push(body.subarray(lineEnd + 1, next < 0 ? body.length : next));
    if (next < 0) break;
    cursor = next;
  }
  // Each section keeps its own trailing CRLF from the delimiter line; drop it so a base64 part
  // does not gain a stray newline and a text part does not gain a blank final line.
  return sections.map((section) =>
    section.subarray(
      0,
      section.length - (section.subarray(-2).toString('ascii') === '\r\n' ? 2 : 0)
    )
  );
};

const walk = (raw: Buffer, partId: string, depth: number, state: WalkState): void => {
  if (depth > MAX_DEPTH || state.parts > MAX_PARTS) return;
  state.parts += 1;
  const { headers, body } = splitMessage(raw);
  const contentType = parseContentType(headerValue(headers, 'content-type') || 'text/plain');
  if (contentType.type === 'multipart') {
    const sections = splitMultipart(body, contentType.parameters.get('boundary') ?? '');
    if (contentType.subtype === 'alternative') {
      // Take the richest readable branch, not every branch: an alternative part repeats the same
      // message, and concatenating them gives the model the message twice.
      const scored = sections.map((section, index) => ({ section, index }));
      const plain = scored.find(
        ({ section }) =>
          parseContentType(headerValue(splitMessage(section).headers, 'content-type')).subtype ===
          'plain'
      );
      const chosen = plain ?? scored[scored.length - 1];
      if (chosen) walk(chosen.section, `${partId}.${chosen.index + 1}`, depth + 1, state);
      for (const { section, index } of scored)
        if (section !== chosen?.section) {
          const nested = splitMessage(section);
          const nestedType = parseContentType(headerValue(nested.headers, 'content-type'));
          if (nestedType.type === 'multipart')
            walk(section, `${partId}.${index + 1}`, depth + 1, state);
        }
      return;
    }
    sections.forEach((section, index) => walk(section, `${partId}.${index + 1}`, depth + 1, state));
    return;
  }
  const content = decodeBody(body, headerValue(headers, 'content-transfer-encoding'));
  const filename = isAttachment(headers, contentType);
  if (filename !== null) {
    state.attachments.push({
      partId,
      filename: safeFilename(filename) || 'attachment',
      contentType: `${contentType.type}/${contentType.subtype}`,
      size: content.byteLength,
      inline: /^\s*inline/i.test(headerValue(headers, 'content-disposition'))
    });
    return;
  }
  const charset = contentType.parameters.get('charset') ?? 'utf-8';
  const decoded = decodeCharset(content, charset);
  if (contentType.subtype === 'html') state.html.push(decoded);
  else state.text.push(decoded);
};

const isoDate = (value: string): string | null => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

export const parseMessage = (
  raw: Buffer,
  options: { maxTextCharacters?: number } = {}
): ParsedMessage => {
  const limit = options.maxTextCharacters ?? DEFAULT_MAX_TEXT;
  const { headers } = splitMessage(raw);
  const state: WalkState = { text: [], html: [], attachments: [], parts: 0 };
  walk(raw, '1', 0, state);
  const plain = state.text.join('\n\n').trim();
  const textFromHtml = !plain && state.html.length > 0;
  const body = textFromHtml ? htmlToText(state.html.join('\n\n')) : plain;
  const references = headerValue(headers, 'references')
    .split(/\s+/)
    .filter((entry) => entry.startsWith('<') && entry.endsWith('>'))
    .slice(0, 50);
  return {
    subject: decodeEncodedWords(headerValue(headers, 'subject')).slice(0, 998),
    from: parseAddressList(headerValue(headers, 'from')),
    to: parseAddressList(headerValue(headers, 'to')),
    cc: parseAddressList(headerValue(headers, 'cc')),
    replyTo: parseAddressList(headerValue(headers, 'reply-to')),
    date: isoDate(headerValue(headers, 'date')),
    messageId: headerValue(headers, 'message-id') || null,
    inReplyTo: headerValue(headers, 'in-reply-to') || null,
    references,
    listUnsubscribe: headerValue(headers, 'list-unsubscribe') || null,
    text: body.slice(0, limit),
    textTruncated: body.length > limit,
    textFromHtml,
    attachments: state.attachments
  };
};

/** Re-walks the same bytes to pull one part out whole, so part ids never need to be stored. */
export const extractPart = (raw: Buffer, partId: string): MimePart | null => {
  let current = raw;
  let depth = 0;
  for (const step of partId.split('.').slice(1)) {
    depth += 1;
    if (depth > MAX_DEPTH) return null;
    const { headers, body } = splitMessage(current);
    const contentType = parseContentType(headerValue(headers, 'content-type') || 'text/plain');
    if (contentType.type !== 'multipart') return null;
    const section = splitMultipart(body, contentType.parameters.get('boundary') ?? '')[
      Number(step) - 1
    ];
    if (!section) return null;
    current = section;
  }
  const { headers, body } = splitMessage(current);
  const contentType = parseContentType(headerValue(headers, 'content-type') || 'text/plain');
  if (contentType.type === 'multipart') return null;
  const dispositionParameters = parseParameters(
    `;${headerValue(headers, 'content-disposition').split(';').slice(1).join(';')}`
  );
  const declaredFilename =
    dispositionParameters.get('filename') ?? contentType.parameters.get('name') ?? null;
  return {
    partId,
    contentType: `${contentType.type}/${contentType.subtype}`,
    // Sanitised on the way out of *this* function too, not only in parseMessage's inventory. This
    // is the call that arrives carrying the bytes, so it is the name the caller is most likely to
    // write to disk - and until this line the two paths disagreed: an attachment listed as
    // ".._.._.ssh_authorized_keys" came back from the download as "../../.ssh/authorized_keys",
    // with embedded NULs and unbounded length surviving as well.
    filename: declaredFilename === null ? null : safeFilename(declaredFilename) || 'attachment',
    content: decodeBody(body, headerValue(headers, 'content-transfer-encoding'))
  };
};

export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface OutgoingMessage {
  from: MimeAddress;
  to: MimeAddress[];
  cc: MimeAddress[];
  bcc: MimeAddress[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: OutgoingAttachment[];
  date?: Date;
}

/**
 * A header value carrying CR or LF is not a formatting problem, it is an injected header - an
 * extra Bcc, a forged Reply-To - so it stops the send rather than being sanitised into something
 * that looks like it worked.
 */
const assertHeaderSafe = (value: string, field: string): string => {
  if (/[\r\n]/.test(value) || value.includes('\0'))
    throw new AthanorError(
      'mail_header_invalid',
      `The ${field} value contains a line break and cannot be sent`
    );
  return value;
};

const encodeWord = (value: string): string => {
  if (!/[^\u0020-\u007e]/.test(value)) return value;
  const chunks: string[] = [];
  let current = '';
  for (const character of value) {
    if (Buffer.byteLength(current + character, 'utf8') > 36) {
      chunks.push(current);
      current = '';
    }
    current += character;
  }
  if (current) chunks.push(current);
  return chunks
    .map((chunk) => `=?utf-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`)
    .join('\r\n ');
};

const formatAddress = (address: MimeAddress): string => {
  const mailbox = assertHeaderSafe(address.address.trim(), 'address');
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+$/.test(mailbox))
    throw new AthanorError('mail_address_invalid', `"${mailbox}" is not a usable email address`);
  if (!address.name) return mailbox;
  const name = assertHeaderSafe(address.name.trim(), 'name');
  if (/[^\u0020-\u007e]/.test(name)) return `${encodeWord(name)} <${mailbox}>`;
  return `"${name.replaceAll(/(["\\])/g, '\\$1')}" <${mailbox}>`;
};

const rfc5322Date = (date: Date): string => {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec'
  ];
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
};

/**
 * RFC 2231 rather than an encoded-word: an encoded-word inside a quoted string is technically
 * invalid and only works because old clients were lenient, and a filename is the one attachment
 * field the owner will recognise their own file by.
 */
const parameterFilename = (filename: string): string => {
  const safe = filename.replaceAll(/[/\\]/g, '_');
  if (!/[^\u0020-\u007e]/.test(safe)) return `filename="${safe.replaceAll(/(["\\])/g, '\\$1')}"`;
  const encoded = [...Buffer.from(safe, 'utf8')]
    .map((byte) =>
      /[A-Za-z0-9!#$&+\-.^_`|~]/.test(String.fromCharCode(byte))
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    )
    .join('');
  return `filename*=utf-8''${encoded}`;
};

const base64Lines = (content: Buffer): string =>
  (content.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');

/**
 * Bodies always go out base64 in UTF-8. Quoted-printable produces a raw message a human can read
 * over the wire, but it also has line-length and trailing-whitespace rules that are the classic
 * source of a mail that arrives subtly corrupted, and no recipient ever sees the raw form.
 */
export const composeMessage = (message: OutgoingMessage): { raw: Buffer; messageId: string } => {
  const domain = message.from.address.split('@')[1] ?? 'localhost';
  const messageId = `<${randomUUID()}@${domain}>`;
  const headers: string[] = [
    `From: ${formatAddress(message.from)}`,
    `To: ${message.to.map(formatAddress).join(', ')}`,
    ...(message.cc.length ? [`Cc: ${message.cc.map(formatAddress).join(', ')}`] : []),
    `Subject: ${encodeWord(assertHeaderSafe(message.subject, 'subject'))}`,
    `Date: ${rfc5322Date(message.date ?? new Date())}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0'
  ];
  if (!message.to.length && !message.cc.length && !message.bcc.length)
    throw new AthanorError('mail_recipients_missing', 'A message needs at least one recipient');
  if (message.inReplyTo)
    headers.push(`In-Reply-To: ${assertHeaderSafe(message.inReplyTo, 'In-Reply-To')}`);
  if (message.references?.length)
    headers.push(
      `References: ${assertHeaderSafe(message.references.slice(-20).join(' '), 'References')}`
    );
  const attachments = message.attachments ?? [];
  const body = Buffer.from(message.text.replaceAll(/\r?\n/g, '\r\n'), 'utf8');
  if (!attachments.length) {
    headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64');
    return {
      raw: Buffer.from(`${headers.join('\r\n')}\r\n\r\n${base64Lines(body)}\r\n`, 'utf8'),
      messageId
    };
  }
  const boundary = `athanor-${randomUUID()}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const sections = [
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(body)}`,
    ...attachments.map((attachment) => {
      const filename = assertHeaderSafe(attachment.filename, 'attachment filename');
      const contentType = assertHeaderSafe(attachment.contentType, 'attachment content type');
      return [
        `--${boundary}`,
        `Content-Type: ${contentType}`,
        `Content-Disposition: attachment; ${parameterFilename(filename)}`,
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines(attachment.content)
      ].join('\r\n');
    })
  ];
  return {
    raw: Buffer.from(
      `${headers.join('\r\n')}\r\n\r\n${sections.join('\r\n')}\r\n--${boundary}--\r\n`,
      'utf8'
    ),
    messageId
  };
};
