/**
 * IMAP and SMTP submission, spoken directly.
 *
 * The decision behind this file: garden talks to the owner's own mail server over open protocols
 * rather than through a provider's HTTP API, and it does so without adding a dependency. IMAP is a
 * line protocol with literals and SMTP submission is a line protocol with multi-line replies; the
 * subset needed to list, search, read, append and send is small enough to read in one sitting, and
 * every byte of it crosses a boundary where the other side is not trusted. A pinned library would
 * have been defensible, but it would also put a parser we do not read in front of the owner's mail
 * and put an unpinnable transitive tree into a one-command install.
 *
 * Transport security is not negotiable and not configurable: TLS from the first byte, ports 993
 * and 465 by default. STARTTLS is not implemented, because a cleartext greeting is exactly where
 * an on-path attacker strips the upgrade and the client never notices.
 */
import { connect as tlsConnect } from 'node:tls';
import { lookup as resolveDns } from 'node:dns/promises';
import type { Duplex } from 'node:stream';
import { GardenError } from './errors.js';
import { decodeEncodedWords, type MimeAddress } from './mime.js';
import { isPublicInternetAddress } from './network-scope.js';

export interface MailEndpoint {
  host: string;
  port: number;
}

export interface MailAccountSecret {
  version: 1;
  username: string;
  password: string;
  /** The address mail is sent as; also the identity matched against an invitation's attendees. */
  fromAddress: string;
  fromName?: string;
  smtpHost: string;
  smtpPort: number;
}

export interface CalendarAccountSecret {
  version: 1;
  username: string;
  password: string;
  /** The address other people invite the owner by; how garden finds them among an event's attendees. */
  address: string;
}

export type MailSocketFactory = (
  endpoint: MailEndpoint,
  timeoutMs: number
) => Promise<Duplex> | Duplex;

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The per-read timeout above bounds silence; it does not bound the session. Every byte that
 * arrives clears the timer and arms a fresh one, so a server that answers one byte every
 * twenty-nine seconds is never late by that measure and the session runs forever - holding a
 * worker slot open while the lease keeps renewing, which is the shape of the stall that ate a
 * turn. Five minutes is far longer than any mailbox operation garden performs (the largest
 * fetch it will ask for is 25 MB) and far shorter than the fifteen-minute model-request deadline
 * it sits underneath, so a session that trips this is stuck rather than slow.
 */
const DEFAULT_DEADLINE_MS = 5 * 60 * 1000;

/**
 * The endpoint the owner typed is a name they control, so it gets the same treatment as any other
 * address the agent is pointed at: every answer has to be on the public internet, and the socket
 * is opened against the address that was checked rather than a second lookup that could differ.
 */
export const secureMailSocket: MailSocketFactory = async (endpoint, timeoutMs) => {
  const addresses = await resolveDns(endpoint.host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => !isPublicInternetAddress(entry.address)))
    throw new GardenError(
      'mail_address_not_allowed',
      'The mail host did not resolve exclusively to public internet addresses'
    );
  const target = addresses[0]!;
  return new Promise<Duplex>((resolve, reject) => {
    const socket = tlsConnect(
      {
        host: target.address,
        port: endpoint.port,
        servername: endpoint.host,
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true
      },
      () => {
        socket.setTimeout(0);
        resolve(socket);
      }
    );
    socket.setTimeout(timeoutMs, () =>
      socket.destroy(new GardenError('mail_timeout', 'The mail server did not answer in time'))
    );
    socket.once('error', reject);
  });
};

/**
 * A pull-shaped reader over a socket: IMAP needs "the next line" and "exactly N bytes" and gets
 * neither from a stream of arbitrary chunks. Chunks are kept whole and copied once on the way out
 * so that reading a five-megabyte message does not cost twenty-five megabytes of concatenation.
 */
class ByteChannel {
  #chunks: Buffer[] = [];
  #length = 0;
  #failure: Error | null = null;
  #ended = false;
  #notify: (() => void) | null = null;
  #read = 0;
  #written = 0;

  constructor(
    private readonly stream: Duplex,
    private readonly timeoutMs: number,
    private readonly maxBytes: number,
    /** Absolute wall-clock instant the whole session must be finished by. */
    private readonly deadlineAt: number
  ) {
    stream.on('data', (chunk: Buffer) => {
      this.#chunks.push(chunk);
      this.#length += chunk.byteLength;
      this.#read += chunk.byteLength;
      if (this.#read > this.maxBytes)
        this.#fail(
          new GardenError('mail_response_too_large', 'The mail server sent more than was asked for')
        );
      this.#wake();
    });
    stream.on('error', (error: Error) => this.#fail(error));
    stream.on('end', () => {
      this.#ended = true;
      this.#wake();
    });
    stream.on('close', () => {
      this.#ended = true;
      this.#wake();
    });
  }

  #fail(error: Error): void {
    this.#failure ??= error;
    this.#wake();
  }

  #wake(): void {
    const notify = this.#notify;
    this.#notify = null;
    notify?.();
  }

  #expired(): GardenError {
    this.#notify = null;
    this.stream.destroy();
    return new GardenError(
      'mail_timeout',
      // Deliberately the same code as the per-read timeout: both mean "the server did not finish",
      // both are answered by checking the host and port, and the owner-facing copy that routes on
      // this code is already right about what to do next.
      'The mail server did not finish within the time allowed for one session'
    );
  }

  async #waitForData(): Promise<void> {
    const pending = this.#failure;
    if (pending) throw pending;
    if (this.#ended)
      throw new GardenError('mail_connection_closed', 'The mail server closed the connection');
    // Checked before waiting rather than only inside the timer, because the drip case never
    // reaches a timer expiry: the wait always ends in data, and it is the accumulation of waits
    // that has to be refused.
    const remaining = this.deadlineAt - Date.now();
    if (remaining <= 0) throw this.#expired();
    /*
     * Which of the two bounds armed the timer, decided here rather than re-derived when it fires.
     *
     * Re-reading the clock inside the callback made the *reported* bound a race. Node's timers run
     * off libuv's own millisecond clock, not `Date.now()`, and the two disagree by up to a
     * millisecond - so a timer armed to the session deadline could fire with `deadlineAt -
     * Date.now()` still reading 1, take the per-read arm, and tell the owner the server "did not
     * answer in time" when what actually ran out was the session. Both carry `mail_timeout` and both
     * are answered the same way, so nothing about the failure changed; the sentence did, in a
     * one-millisecond window, under load. It surfaced as an intermittent red in this package's own
     * drip test, which is the only place the distinction is observable at all.
     *
     * `Math.min` has already made the decision. Recording it is what makes the sentence follow the
     * bound that was actually spent.
     */
    const deadlineIsTheBound = remaining <= this.timeoutMs;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          if (deadlineIsTheBound || this.deadlineAt - Date.now() <= 0) {
            reject(this.#expired());
            return;
          }
          this.#notify = null;
          this.stream.destroy();
          reject(new GardenError('mail_timeout', 'The mail server did not answer in time'));
        },
        Math.min(this.timeoutMs, remaining)
      );
      this.#notify = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    // A drip that lands a microsecond before the deadline must not buy another whole read budget.
    if (this.deadlineAt - Date.now() <= 0) throw this.#expired();
    const failure = this.#failure;
    if (failure) throw failure;
  }

  #take(count: number): Buffer {
    const out = Buffer.allocUnsafe(count);
    let filled = 0;
    while (filled < count) {
      const chunk = this.#chunks[0]!;
      const need = count - filled;
      if (chunk.byteLength <= need) {
        chunk.copy(out, filled);
        filled += chunk.byteLength;
        this.#chunks.shift();
      } else {
        chunk.copy(out, filled, 0, need);
        this.#chunks[0] = chunk.subarray(need);
        filled += need;
      }
    }
    this.#length -= count;
    return out;
  }

  #indexOfLineFeed(): number {
    let base = 0;
    for (const chunk of this.#chunks) {
      const at = chunk.indexOf(0x0a);
      if (at >= 0) return base + at;
      base += chunk.byteLength;
    }
    return -1;
  }

  async readLine(): Promise<string> {
    for (;;) {
      const at = this.#indexOfLineFeed();
      if (at >= 0)
        return this.#take(at + 1)
          .toString('binary')
          .replace(/\r?\n$/, '');
      if (this.#length > 200_000)
        throw new GardenError('mail_response_invalid', 'The mail server sent an unbounded line');
      await this.#waitForData();
    }
  }

  async readExact(count: number): Promise<Buffer> {
    while (this.#length < count) await this.#waitForData();
    return this.#take(count);
  }

  write(data: Buffer | string): void {
    this.#written += Buffer.byteLength(data);
    this.stream.write(data);
  }

  get bytesRead(): number {
    return this.#read;
  }

  get bytesWritten(): number {
    return this.#written;
  }

  destroy(): void {
    this.stream.destroy();
  }
}

const utf7Encode = (name: string): string => {
  let out = '';
  let buffer = '';
  const flush = () => {
    if (!buffer) return;
    const bytes = Buffer.from(buffer, 'utf16le').swap16();
    out += `&${bytes.toString('base64').replaceAll('=', '').replaceAll('/', ',')}-`;
    buffer = '';
  };
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) {
      flush();
      out += character === '&' ? '&-' : character;
    } else buffer += character;
  }
  flush();
  return out;
};

const utf7Decode = (name: string): string => {
  let out = '';
  let index = 0;
  while (index < name.length) {
    if (name[index] !== '&') {
      out += name[index];
      index += 1;
      continue;
    }
    const end = name.indexOf('-', index + 1);
    if (end < 0) return out + name.slice(index);
    const encoded = name.slice(index + 1, end);
    if (!encoded) out += '&';
    else {
      const bytes = Buffer.from(encoded.replaceAll(',', '/'), 'base64');
      // An odd byte count is not modified UTF-7; leaving the run as written beats throwing while
      // listing mailboxes, and the owner still sees a name they can match by eye.
      out += bytes.byteLength % 2 === 0 ? bytes.swap16().toString('utf16le') : encoded;
    }
    index = end + 1;
  }
  return out;
};

type Segment = { text: string } | { literal: Buffer };
type ImapValue = string | Buffer | null | ImapValue[];

interface LogicalLine {
  segments: Segment[];
  text: string;
}

const tokenize = (segments: Segment[]): ImapValue[] => {
  const root: ImapValue[] = [];
  const stack: ImapValue[][] = [root];
  const push = (value: ImapValue) => stack[stack.length - 1]!.push(value);
  for (const segment of segments) {
    if ('literal' in segment) {
      push(segment.literal);
      continue;
    }
    const text = segment.text;
    let index = 0;
    while (index < text.length) {
      const character = text[index]!;
      if (character === ' ') {
        index += 1;
        continue;
      }
      if (character === '(') {
        const child: ImapValue[] = [];
        push(child);
        stack.push(child);
        index += 1;
        continue;
      }
      if (character === ')') {
        if (stack.length > 1) stack.pop();
        index += 1;
        continue;
      }
      if (character === '"') {
        let value = '';
        index += 1;
        while (index < text.length && text[index] !== '"') {
          if (text[index] === '\\') index += 1;
          value += text[index] ?? '';
          index += 1;
        }
        index += 1;
        push(value);
        continue;
      }
      let value = '';
      while (index < text.length && !' ()"'.includes(text[index]!)) {
        value += text[index];
        index += 1;
      }
      push(value === 'NIL' ? null : value);
    }
  }
  return root;
};

const pairs = (list: ImapValue[]): Map<string, ImapValue> => {
  const map = new Map<string, ImapValue>();
  for (let index = 0; index + 1 < list.length; index += 2) {
    const key = list[index];
    if (typeof key === 'string') map.set(key.toUpperCase().split('<')[0] ?? key, list[index + 1]!);
  }
  return map;
};

const asText = (value: ImapValue): string => {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
};

const envelopeAddresses = (value: ImapValue): MimeAddress[] => {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 100)
    .map((entry) => {
      if (!Array.isArray(entry)) return null;
      const [name, , mailbox, host] = entry;
      const address = `${asText(mailbox ?? null)}@${asText(host ?? null)}`;
      if (!/^[^\s@]+@[^\s@]+$/.test(address)) return null;
      const label = decodeEncodedWords(asText(name ?? null));
      return { name: label || null, address };
    })
    .filter((entry): entry is MimeAddress => entry !== null);
};

export interface ImapMailbox {
  name: string;
  delimiter: string;
  flags: string[];
  /** \Sent, \Drafts, \Trash and friends when the server advertises SPECIAL-USE. */
  specialUse: string | null;
}

export interface ImapSummary {
  uid: number;
  flags: string[];
  internalDate: string | null;
  size: number;
  subject: string;
  from: MimeAddress[];
  to: MimeAddress[];
  cc: MimeAddress[];
  date: string | null;
  messageId: string | null;
}

export interface ImapSearchCriteria {
  unseen?: boolean;
  seen?: boolean;
  flagged?: boolean;
  answered?: boolean;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: string;
  before?: string;
  largerThanBytes?: number;
}

type CommandPart = string | { literal: Buffer };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const imapDate = (iso: string): string => {
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime()))
    throw new GardenError('mail_search_invalid', `"${iso}" is not a date`);
  return `${parsed.getUTCDate()}-${MONTHS[parsed.getUTCMonth()]!}-${parsed.getUTCFullYear()}`;
};

export interface ImapSessionOptions {
  endpoint: MailEndpoint;
  username: string;
  password: string;
  socketFactory?: MailSocketFactory;
  timeoutMs?: number;
  /** Total budget for the whole session, connect included. See DEFAULT_DEADLINE_MS. */
  deadlineMs?: number;
  maxBytes?: number;
}

export class ImapSession {
  #tag = 0;
  #selected: { mailbox: string; readOnly: boolean } | null = null;

  private constructor(
    private readonly channel: ByteChannel,
    readonly capabilities: Set<string>
  ) {}

  static async open(options: ImapSessionOptions): Promise<ImapSession> {
    // Started before the connect so that DNS, TLS and the handshake are inside the budget rather
    // than an unbounded prelude to it.
    const deadlineAt = Date.now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);
    const socket = await (options.socketFactory ?? secureMailSocket)(
      options.endpoint,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    const channel = new ByteChannel(
      socket,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      options.maxBytes ?? 32 * 1024 * 1024,
      deadlineAt
    );
    const greeting = await channel.readLine();
    if (!/^\* (OK|PREAUTH)/i.test(greeting)) {
      channel.destroy();
      throw new GardenError('mail_greeting_invalid', 'The IMAP server refused the connection');
    }
    const session = new ImapSession(channel, new Set());
    for (const entry of (/\[CAPABILITY ([^\]]*)\]/i.exec(greeting)?.[1] ?? '').split(' '))
      if (entry) session.capabilities.add(entry.toUpperCase());
    if (!session.capabilities.size) await session.#refreshCapabilities();
    try {
      await session.#authenticate(options.username, options.password);
    } catch (error) {
      channel.destroy();
      throw error;
    }
    // Capabilities routinely change on login - a server advertises far less before it knows who is
    // asking - so the post-login set is the one every later command is allowed to reason about.
    await session.#refreshCapabilities();
    return session;
  }

  get bytesRead(): number {
    return this.channel.bytesRead;
  }

  get bytesWritten(): number {
    return this.channel.bytesWritten;
  }

  #nextTag(): string {
    this.#tag += 1;
    return `A${String(this.#tag).padStart(4, '0')}`;
  }

  async #readLogicalLine(): Promise<LogicalLine> {
    const segments: Segment[] = [];
    let text = '';
    for (;;) {
      const line = await this.channel.readLine();
      const literal = /\{(\d+)\+?\}$/.exec(line);
      if (!literal) {
        segments.push({ text: line });
        text += line;
        return { segments, text };
      }
      const head = line.slice(0, literal.index);
      segments.push({ text: head });
      text += head;
      segments.push({ literal: await this.channel.readExact(Number(literal[1])) });
    }
  }

  async #awaitContinuation(tag: string, untagged: LogicalLine[]): Promise<void> {
    for (;;) {
      const line = await this.#readLogicalLine();
      if (line.text.startsWith('+')) return;
      if (line.text.startsWith(`${tag} `))
        throw new GardenError(
          'mail_command_failed',
          `The IMAP server refused the command: ${line.text.slice(tag.length + 1, tag.length + 301)}`
        );
      untagged.push(line);
    }
  }

  async #awaitTagged(
    tag: string,
    untagged: LogicalLine[]
  ): Promise<{ untagged: LogicalLine[]; tagged: string }> {
    for (;;) {
      const line = await this.#readLogicalLine();
      if (!line.text.startsWith(`${tag} `)) {
        untagged.push(line);
        continue;
      }
      const status = line.text.slice(tag.length + 1);
      if (!/^OK\b/i.test(status))
        throw new GardenError(
          'mail_command_failed',
          `The IMAP server refused the command: ${status.slice(0, 300)}`
        );
      return { untagged, tagged: status };
    }
  }

  /**
   * Every value that came from outside garden - a search term, a mailbox name, a password, a
   * whole draft - is sent as a literal rather than interpolated into the command line. A literal
   * carries its own length, so there is no quoting to get wrong and no way for a newline in an
   * argument to become a second IMAP command.
   */
  async #execute(parts: CommandPart[]): Promise<{ untagged: LogicalLine[]; tagged: string }> {
    const tag = this.#nextTag();
    const untagged: LogicalLine[] = [];
    let written = `${tag} `;
    for (const part of parts) {
      if (typeof part === 'string') {
        written += part;
        continue;
      }
      this.channel.write(`${written}{${part.literal.byteLength}}\r\n`);
      written = '';
      await this.#awaitContinuation(tag, untagged);
      this.channel.write(part.literal);
    }
    this.channel.write(`${written}\r\n`);
    return this.#awaitTagged(tag, untagged);
  }

  async #saslExchange(command: string, responses: string[]): Promise<void> {
    const tag = this.#nextTag();
    const untagged: LogicalLine[] = [];
    this.channel.write(`${tag} ${command}\r\n`);
    for (const response of responses) {
      await this.#awaitContinuation(tag, untagged);
      this.channel.write(`${response}\r\n`);
    }
    await this.#awaitTagged(tag, untagged);
  }

  async #refreshCapabilities(): Promise<void> {
    const response = await this.#execute(['CAPABILITY']);
    this.capabilities.clear();
    for (const line of response.untagged)
      if (/^\* CAPABILITY /i.test(line.text))
        for (const entry of line.text.slice(13).trim().split(' '))
          if (entry) this.capabilities.add(entry.toUpperCase());
  }

  async #authenticate(username: string, password: string): Promise<void> {
    const secret = Buffer.from(`\u0000${username}\u0000${password}`, 'utf8').toString('base64');
    if (this.capabilities.has('AUTH=PLAIN')) {
      if (this.capabilities.has('SASL-IR')) await this.#execute([`AUTHENTICATE PLAIN ${secret}`]);
      else await this.#saslExchange('AUTHENTICATE PLAIN', [secret]);
      return;
    }
    if (this.capabilities.has('LOGINDISABLED'))
      throw new GardenError(
        'mail_authentication_unsupported',
        'The IMAP server offers no password authentication garden can use'
      );
    await this.#execute([
      'LOGIN ',
      { literal: Buffer.from(username, 'utf8') },
      ' ',
      { literal: Buffer.from(password, 'utf8') }
    ]);
  }

  async listMailboxes(): Promise<ImapMailbox[]> {
    const response = await this.#execute(['LIST "" "*"']);
    const mailboxes: ImapMailbox[] = [];
    for (const line of response.untagged) {
      if (!/^\* LIST /i.test(line.text)) continue;
      const tokens = tokenize(line.segments);
      const flags = Array.isArray(tokens[2]) ? tokens[2].map((flag) => asText(flag)) : [];
      const name = asText(tokens[4] ?? null);
      if (!name || flags.some((flag) => flag.toLowerCase() === '\\noselect')) continue;
      mailboxes.push({
        name: utf7Decode(name),
        delimiter: asText(tokens[3] ?? null) || '/',
        flags,
        specialUse:
          flags.find((flag) =>
            ['\\sent', '\\drafts', '\\trash', '\\junk', '\\archive', '\\all'].includes(
              flag.toLowerCase()
            )
          ) ?? null
      });
      if (mailboxes.length >= 500) break;
    }
    return mailboxes;
  }

  async select(mailbox: string, readOnly = true): Promise<{ exists: number; uidValidity: number }> {
    const response = await this.#execute([
      `${readOnly ? 'EXAMINE' : 'SELECT'} `,
      { literal: Buffer.from(utf7Encode(mailbox), 'utf8') }
    ]);
    this.#selected = { mailbox, readOnly };
    const joined = response.untagged.map((line) => line.text).join('\n');
    return {
      exists: Number(/\* (\d+) EXISTS/i.exec(joined)?.[1] ?? '0'),
      uidValidity: Number(/\[UIDVALIDITY (\d+)\]/i.exec(joined)?.[1] ?? '0')
    };
  }

  async #ensureSelected(mailbox: string, readOnly: boolean): Promise<void> {
    const current = this.#selected;
    if (current?.mailbox === mailbox && (readOnly || !current.readOnly)) return;
    await this.select(mailbox, readOnly);
  }

  async search(mailbox: string, criteria: ImapSearchCriteria, limit: number): Promise<number[]> {
    await this.#ensureSelected(mailbox, true);
    const terms: CommandPart[] = [];
    const keyword = (key: string, value: string) => {
      terms.push(` ${key} `, { literal: Buffer.from(value, 'utf8') });
    };
    if (criteria.unseen) terms.push(' UNSEEN');
    if (criteria.seen) terms.push(' SEEN');
    if (criteria.flagged) terms.push(' FLAGGED');
    if (criteria.answered) terms.push(' ANSWERED');
    if (criteria.from) keyword('FROM', criteria.from);
    if (criteria.to) keyword('TO', criteria.to);
    if (criteria.subject) keyword('SUBJECT', criteria.subject);
    if (criteria.text) keyword('TEXT', criteria.text);
    if (criteria.since) terms.push(` SINCE ${imapDate(criteria.since)}`);
    if (criteria.before) terms.push(` BEFORE ${imapDate(criteria.before)}`);
    if (criteria.largerThanBytes) terms.push(` LARGER ${Math.trunc(criteria.largerThanBytes)}`);
    if (!terms.length) terms.push(' ALL');
    const nonAscii = terms.some(
      (term) => typeof term !== 'string' && term.literal.some((byte) => byte > 0x7f)
    );
    const response = await this.#searchOnce(terms, nonAscii);
    const uids: number[] = [];
    for (const line of response) {
      if (!/^\* SEARCH/i.test(line.text)) continue;
      for (const token of line.text.slice(8).trim().split(/\s+/)) {
        const uid = Number(token);
        if (Number.isInteger(uid) && uid > 0) uids.push(uid);
      }
    }
    // Newest first is the order a person reads a mailbox in, so the limit keeps the newest.
    return uids.sort((a, b) => b - a).slice(0, limit);
  }

  /**
   * CHARSET UTF-8 is the correct way to ask, and a handful of servers answer BAD to it and then
   * search the same bytes happily without it. One retry, only for the non-ASCII case that needed
   * the announcement in the first place.
   */
  async #searchOnce(terms: CommandPart[], announceCharset: boolean): Promise<LogicalLine[]> {
    try {
      const response = await this.#execute([
        `UID SEARCH${announceCharset ? ' CHARSET UTF-8' : ''}`,
        ...terms
      ]);
      return response.untagged;
    } catch (error) {
      if (!announceCharset) throw error;
      return (await this.#execute(['UID SEARCH', ...terms])).untagged;
    }
  }

  async fetchSummaries(mailbox: string, uids: number[]): Promise<ImapSummary[]> {
    if (!uids.length) return [];
    await this.#ensureSelected(mailbox, true);
    const response = await this.#execute([
      `UID FETCH ${uids.join(',')} (UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE)`
    ]);
    const summaries: ImapSummary[] = [];
    for (const line of response.untagged) {
      if (!/^\* \d+ FETCH /i.test(line.text)) continue;
      const tokens = tokenize(line.segments);
      const fields = pairs(Array.isArray(tokens[3]) ? tokens[3] : []);
      const envelope = fields.get('ENVELOPE');
      const parts = Array.isArray(envelope) ? envelope : [];
      const flags = fields.get('FLAGS');
      const internalDate = asText(fields.get('INTERNALDATE') ?? null);
      const stamp = Date.parse(asText(parts[0] ?? null) || internalDate);
      summaries.push({
        uid: Number(asText(fields.get('UID') ?? null)),
        flags: Array.isArray(flags) ? flags.map((flag) => asText(flag)) : [],
        internalDate: internalDate || null,
        size: Number(asText(fields.get('RFC822.SIZE') ?? null)) || 0,
        subject: decodeEncodedWords(asText(parts[1] ?? null)),
        from: envelopeAddresses(parts[2] ?? null),
        to: envelopeAddresses(parts[5] ?? null),
        cc: envelopeAddresses(parts[6] ?? null),
        date: Number.isFinite(stamp) ? new Date(stamp).toISOString() : null,
        messageId: asText(parts[9] ?? null) || null
      });
    }
    return summaries.filter((summary) => Number.isInteger(summary.uid) && summary.uid > 0);
  }

  /**
   * BODY.PEEK rather than BODY: reading a message on the owner's behalf must not silently mark it
   * read, because the unread count is how the owner knows what they still have to look at. The
   * partial range is what keeps a forwarded video from becoming the agent's memory footprint.
   */
  async fetchMessage(
    mailbox: string,
    uid: number,
    maxBytes: number
  ): Promise<{ raw: Buffer; size: number; truncated: boolean }> {
    await this.#ensureSelected(mailbox, true);
    const response = await this.#execute([
      `UID FETCH ${uid} (RFC822.SIZE BODY.PEEK[]<0.${Math.trunc(maxBytes)}>)`
    ]);
    for (const line of response.untagged) {
      if (!/^\* \d+ FETCH /i.test(line.text)) continue;
      const tokens = tokenize(line.segments);
      const fields = pairs(Array.isArray(tokens[3]) ? tokens[3] : []);
      const body = [...fields.entries()].find(([key]) => key.startsWith('BODY['))?.[1];
      if (body === undefined || body === null) continue;
      const raw = Buffer.isBuffer(body) ? body : Buffer.from(asText(body), 'utf8');
      const size = Number(asText(fields.get('RFC822.SIZE') ?? null)) || raw.byteLength;
      return { raw, size, truncated: size > raw.byteLength };
    }
    throw new GardenError('mail_message_not_found', `Message ${uid} is not in ${mailbox}`);
  }

  async storeFlags(mailbox: string, uids: number[], add: boolean, flags: string[]): Promise<void> {
    if (!uids.length || !flags.length) return;
    await this.#ensureSelected(mailbox, false);
    await this.#execute([
      `UID STORE ${uids.join(',')} ${add ? '+' : '-'}FLAGS.SILENT (${flags.join(' ')})`
    ]);
  }

  async append(mailbox: string, flags: string[], raw: Buffer): Promise<void> {
    await this.#execute([
      'APPEND ',
      { literal: Buffer.from(utf7Encode(mailbox), 'utf8') },
      ` (${flags.join(' ')}) `,
      { literal: raw }
    ]);
  }

  async close(): Promise<void> {
    try {
      await this.#execute(['LOGOUT']);
    } catch {
      // A server that hangs up on LOGOUT is behaving normally enough; the socket goes either way.
    } finally {
      this.channel.destroy();
    }
  }
}

export interface SmtpSessionOptions {
  endpoint: MailEndpoint;
  username: string;
  password: string;
  clientDomain: string;
  socketFactory?: MailSocketFactory;
  timeoutMs?: number;
  /** Total budget for the whole session, connect included. See DEFAULT_DEADLINE_MS. */
  deadlineMs?: number;
}

export class SmtpSession {
  private constructor(
    private readonly channel: ByteChannel,
    private readonly capabilityLines: string[]
  ) {}

  static async open(options: SmtpSessionOptions): Promise<SmtpSession> {
    const deadlineAt = Date.now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);
    const socket = await (options.socketFactory ?? secureMailSocket)(
      options.endpoint,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    const channel = new ByteChannel(
      socket,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      1024 * 1024,
      deadlineAt
    );
    const greeting = await SmtpSession.#reply(channel);
    if (greeting.code !== 220) {
      channel.destroy();
      throw new GardenError('mail_greeting_invalid', 'The SMTP server refused the connection');
    }
    const hello = await SmtpSession.#command(channel, `EHLO ${options.clientDomain}`, [250]);
    const session = new SmtpSession(channel, hello.lines.slice(1));
    try {
      await session.#authenticate(options.username, options.password);
    } catch (error) {
      channel.destroy();
      throw error;
    }
    return session;
  }

  static async #reply(channel: ByteChannel): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    for (;;) {
      const line = await channel.readLine();
      lines.push(line.slice(4));
      if (/^\d{3} /.test(line)) return { code: Number(line.slice(0, 3)), lines };
      if (!/^\d{3}-/.test(line))
        throw new GardenError('mail_response_invalid', 'The SMTP server sent an unreadable reply');
      if (lines.length > 100)
        throw new GardenError('mail_response_invalid', 'The SMTP server sent an unbounded reply');
    }
  }

  static async #command(
    channel: ByteChannel,
    command: string,
    expected: number[]
  ): Promise<{ code: number; lines: string[] }> {
    channel.write(`${command}\r\n`);
    const reply = await SmtpSession.#reply(channel);
    if (!expected.includes(reply.code))
      throw new GardenError(
        'mail_send_failed',
        `The SMTP server answered ${reply.code}: ${(reply.lines[0] ?? '').slice(0, 300)}`
      );
    return reply;
  }

  async #authenticate(username: string, password: string): Promise<void> {
    const advertised = this.capabilityLines.find((line) => /^AUTH\b/i.test(line.trim())) ?? '';
    if (!advertised || /PLAIN/i.test(advertised)) {
      const secret = Buffer.from(`\u0000${username}\u0000${password}`, 'utf8').toString('base64');
      await SmtpSession.#command(this.channel, `AUTH PLAIN ${secret}`, [235]);
      return;
    }
    if (!/LOGIN/i.test(advertised))
      throw new GardenError(
        'mail_authentication_unsupported',
        'The SMTP server offers no password authentication garden can use'
      );
    await SmtpSession.#command(this.channel, 'AUTH LOGIN', [334]);
    await SmtpSession.#command(
      this.channel,
      Buffer.from(username, 'utf8').toString('base64'),
      [334]
    );
    await SmtpSession.#command(
      this.channel,
      Buffer.from(password, 'utf8').toString('base64'),
      [235]
    );
  }

  /**
   * Bcc recipients are envelope-only on purpose: they are named in RCPT TO and never written into
   * the message, which is the difference between a blind copy and an accidental disclosure.
   */
  async send(input: {
    from: string;
    recipients: string[];
    raw: Buffer;
  }): Promise<{ code: number; response: string }> {
    await SmtpSession.#command(this.channel, `MAIL FROM:<${input.from}>`, [250]);
    for (const recipient of input.recipients)
      await SmtpSession.#command(this.channel, `RCPT TO:<${recipient}>`, [250, 251]);
    await SmtpSession.#command(this.channel, 'DATA', [354]);
    const body = input.raw
      .toString('binary')
      .replaceAll(/\r?\n/g, '\r\n')
      .replaceAll(/^\./gm, '..');
    this.channel.write(Buffer.from(`${body}${body.endsWith('\r\n') ? '' : '\r\n'}.\r\n`, 'binary'));
    const reply = await SmtpSession.#reply(this.channel);
    if (reply.code !== 250)
      throw new GardenError(
        'mail_send_failed',
        `The SMTP server refused the message with ${reply.code}: ${(reply.lines[0] ?? '').slice(0, 300)}`
      );
    return { code: reply.code, response: (reply.lines[0] ?? '').slice(0, 300) };
  }

  async close(): Promise<void> {
    try {
      await SmtpSession.#command(this.channel, 'QUIT', [221]);
    } catch {
      // Same as IMAP: the message is already accepted, and QUIT is a courtesy.
    } finally {
      this.channel.destroy();
    }
  }
}
