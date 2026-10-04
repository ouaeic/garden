import { matchingHostSuffix, reachOfHttpUrl, type NetworkReach } from '@garden/core';
/**
 * Where a request is allowed to go once untrusted content is in the turn.
 *
 * `network-scope.ts` in core answers where an address is - this computer, the estate, or the public
 * internet - which stops SSRF against a metadata service and stops nothing else. The read tools take
 * a complete URL and raise no approval, so an attacker who has landed an instruction has a clean GET
 * channel: put the owner's secret in a path segment and read the attacker's page. That is the third
 * leg of the lethal trifecta, and it survives every fix to the chat client because it is a tool call
 * rather than a rendered image.
 *
 * THE ESTATE IS A DESTINATION. For six waves this file asked core "is this on the internet" and
 * treated no as free, so the owner's NAS, their router and the link-local block the cloud metadata
 * service answers on were charged nought bytes and raised no card in any mode - measured at
 * cd7033f, nine addresses, three modes, both spellings, not one card. A private address is still
 * another computer. It is now charged and judged exactly as a public one is, against the same turn
 * budget; only loopback and this installation's own origin are free, because only those are this
 * process reading its own output.
 *
 * The rule here is deliberately about provenance and volume rather than about reputation. There is
 * no blocklist to keep current and no attempt to recognise a malicious host: a destination is
 * ordinary if the owner named it, a search returned it, or this turn has already read it, and the
 * address itself carries no more material the model chose than a real URL needs. Everything else is
 * shown to the owner before it is fetched, with the host and the byte count computed here rather
 * than taken from anything the model wrote.
 *
 * It only applies while the turn is tainted. A clean research task reads whatever it likes.
 *
 * THE POLICY CHOICE, because it is one and the owner may want a different one: this budget does not
 * try to tell a leak from ordinary egress, because measured against real traffic it cannot - the
 * worst of eight recorded research turns put 915 bytes into thirty addresses and the recorded
 * attack put 1,020 into a hundred and seventy, and no threshold separates those. What it does is
 * make the quantity finite, charged and visible, and hand the judgement to the owner with a card
 * that names the number. `MAX_TURN_NOVEL_BYTES` is therefore a dial, not a floor; `MIN_TOKEN_BYTES`
 * is the floor, and it is the part that must not be turned off, because without it the quantity is
 * not finite at all.
 */

export interface DestinationContext {
  /** Hosts the owner named, a search returned, or a page already read this turn resolved to. */
  readonly knownOrigins: readonly string[];
  /**
   * Whole addresses this turn was handed - by a search, or as the page a read actually landed on.
   *
   * If only the host survived a result, following the third link a search returned would score its
   * whole path as novel material even though the harness itself had just put that path in front of
   * the model. Under a running budget that is the difference between a research pass that costs
   * nothing and one that stops to ask after seventeen pages. These come from the harness's own
   * reading of a tool result, never from what a page said, so an attacker can add addresses the
   * agent has already been to and nothing else.
   */
  readonly knownAddresses?: readonly string[];
  /** The owner's own words this task; material already in them is not novel. */
  readonly ownerText: string;
  /** This installation's own address, which is not somewhere data can be sent to. */
  readonly selfOrigins?: readonly string[];
  /**
   * What this turn has already put into addresses that the owner did not choose, in bytes.
   *
   * Absent means nothing has left yet. The per-address bound below is a bound on one request, and
   * a request is not the unit an attacker is limited to: measured against the shipped classifier,
   * a 2,048-byte secret left in twenty-two addresses that were each individually under it and each
   * individually judged clean, because the count was computed, reported and then added to nothing.
   */
  readonly spentNoveltyBytes?: number;
}

export interface DestinationVerdict {
  /** Permits source verification as an alternative proposal; never authorizes the request. */
  unfamiliarPublicHost?: boolean;
  readonly sink: boolean;
  readonly host: string;
  /**
   * What this address costs the turn: the bytes of it the model chose rather than was handed.
   *
   * Shown to the owner on the card beside the running total, because a number that decides an
   * answer and is never displayed is a number nobody can check.
   */
  readonly noveltyBytes: number;
  /** Why it is a sink, in the words the approval card uses. Empty when it is not one. */
  readonly reason: string;
  /**
   * Where this address is, relative to this computer: `self`, `estate`, or `internet`.
   *
   * Carried on the verdict rather than re-derived by each reader, because the two questions the
   * floor asks about a destination are not the same question and had been sharing one boolean. The
   * ordinary arm asks "does this leave for the internet", where the LAN is out of scope by design;
   * the provenance arm asks "does this reach a computer that is not this one", where it is the
   * whole of the gap. A reader that wants the narrower question says so by naming this field.
   */
  readonly reach: NetworkReach;
}
/**
 * How much material an address may carry that appears nowhere the owner put it, in two parts.
 *
 * `MAX_NOVEL_TOKEN_CHARS` is the part that turns "exfiltrate a mailbox" into "exfiltrate a bit
 * at a time": a base64 payload is one long token and trips it immediately, while a real deep
 * link - a docs path, a slug, a tracking parameter - is comfortably under it. It is measured on
 * ONE piece of the address, because the pieces are where a payload lives: a composed query is
 * many short pieces and pays for its structure at the request bound instead.
 *
 * `MAX_NOVEL_URL_BYTES` is the second part, and the one the first replaced at 96: the total a
 * single request may charge. At 96 it also bounded one composed query, and the measured failure
 * was the owner's own research turn - the REST reads a research task composes (a cursorMark, a
 * boolean query, a field list) carry 120-131 novel bytes with no piece over 64 characters, and
 * every such read stopped the turn in autonomous. The card reported a payload shape for what is
 * query structure: "111 bytes the model chose rather than was handed, past the 96 a real link
 * needs". So the total bound moves to 192 - a real API request needs room a real link does not
 * - and the payload half is held by the token bound instead, which is the part that made the
 * numbers finite at all.
 *
 * Fragmentation is unchanged: the cheapest shape per byte is still one short token per request,
 * each priced at `MIN_TOKEN_BYTES`, and the turn budget stops it after exactly
 * `MAX_TURN_NOVEL_BYTES / MIN_TOKEN_BYTES` requests.
 */
export const MAX_NOVEL_TOKEN_CHARS = 64;

export const MAX_NOVEL_URL_BYTES = 192;

/**
 * How much material the *name* may carry beyond the part that was already allowed.
 *
 * The bound above was measured on the path, the query and the fragment only, so the one part of an
 * address that needs no cooperation from the destination at all was not measured: with
 * `docs.example.com` already read, `https://<32 hex characters>.docs.example.com/` scored zero
 * novel bytes and left without a card - a working exfiltration channel out of a host the turn was
 * legitimately sent to, needing nothing but a wildcard DNS record and a log.
 *
 * Small on purpose, because a subdomain is a word. `support`, `blog`, `cdn`, `eu-west-1.api` are
 * all comfortably under it; sixteen bytes of hex are not, and the ones short enough to slip under
 * are charged to the turn budget like everything else.
 */
export const MAX_NOVEL_HOST_BYTES = 24;

/**
 * How much novel material may leave in total while untrusted content is in the turn.
 *
 * This is what makes the per-address bound mean anything: without it the bound was a bound on the
 * size of a chunk rather than on the size of what leaves. It is charged only while the turn is
 * tainted, and an address a search handed the model costs nothing at all, so the five of eight
 * recorded research turns that only read what they were given spend zero of it.
 *
 * The three that followed links off the pages they read spent 345, 419 and 915 at the budget this
 * replaced - and the owner's own deep research turn spent 1,393 before its tenth composed read,
 * eleven cards in autonomous for REST reads on hosts the turn had legitimately been sent to. The
 * owner's ruling on autonomous is that it runs the research, and the leak this bound prices is
 * bounded by the per-token floor either way: `MIN_TOKEN_BYTES` per request at minimum,
 * `MAX_NOVEL_TOKEN_CHARS` for any single piece. Four times the allowance is still a fraction of
 * one path-segment payload per request over a whole turn, and a real deep research pass fits.
 *
 * Exceeding it is a card, not a refusal. The owner can still say yes; the point is that they are
 * asked once the material leaving stops looking like addresses.
 */
export const MAX_TURN_NOVEL_BYTES = 4_096;

/**
 * What one piece of an address costs when the corpus already contains it.
 *
 * This is the number that makes every bound above mean anything, and it is the whole of the fix
 * for what was measured here: the charge asked whether a token's exact string appeared anywhere in
 * up to forty kilobytes of the owner's own words, and answered zero when it did. A single character
 * is a token, and a single character is a substring of almost any corpus. So the payload was never
 * novel: 65,536 path segments of one corpus character each - 24 KiB of material at three bits a
 * segment - left a tainted turn through a host it had legitimately read, were charged 0, and raised
 * no card. Every bound in this file was in force and none of them was reached, because the quantity
 * they bound had been driven to zero.
 *
 * A corpus says which pieces are available. It does not say in what order, and the order is the
 * payload: choosing one of thirteen characters carries 3.7 bits whether or not the owner wrote all
 * thirteen. So no piece of an address is free. A piece the corpus contains costs this, the price of
 * saying which piece; a piece it does not costs its own length, which is never less than this.
 *
 * Two, measured. Against eight recorded research turns it costs the most expensive of them 68
 * bytes - 6.6% of the turn budget, 0 extra cards over 136 real reads - and it brings that 24 KiB
 * down to at most 192 bytes. Four would halve the leak again and leave that same turn at 983 of
 * 1,024, which is not headroom anyone would leave switched on.
 */
export const MIN_TOKEN_BYTES = 2;

/**
 * The longest piece of an address that can still be charged as a choice rather than as material.
 *
 * `MIN_TOKEN_BYTES` prices the act of saying which piece, on the reasoning that a corpus says which
 * pieces exist and the order is what costs. That reasoning holds while a piece is short enough to
 * be an index into the corpus. It stops holding when the piece IS the corpus: the entire owner
 * context - thirty thousand characters of it, key ids, a database password - fits in one path
 * segment, is trivially a substring of itself, and left a tainted turn for two bytes with no card
 * in balanced or in strict. The recipient is the attacker's server, which has never seen a word of
 * the corpus, so nothing about the piece was an index into anything it held.
 *
 * Thirty-two, measured against every address this repository commits: 501 distinct URLs, 721 path
 * and query segments, median 5, ninetieth percentile 15, ninety-ninth 40, longest 82. The 1.39%
 * above this cap are article slugs and disclosure-log titles - the shape a search hands over, and a
 * handed address is credited entire and costs nothing at all. What has to fit under the cap is a
 * piece the model composed itself, and those are short.
 *
 * This bounds the channel; it does not close it. A piece at exactly the cap still buys thirty-two
 * characters for two bytes, so a turn's whole budget still moves about sixteen kilobytes rather
 * than the hundred and nine it moved before. That is the trade this file is honest about above: the
 * quantity is finite, charged and visible, and the owner decides.
 */
export const MAX_CREDITED_TOKEN_CHARS = 32;

const MAX_KNOWN_ORIGINS = 64;

/**
 * Bounded the same way and for the same reason as the hosts, but deep enough to outlast a search.
 *
 * `web_search` hands back twelve addresses by default and may be asked for fifty, so a bound of
 * thirty-two was spent inside three searches: the fourth evicted the first, and reading a page the
 * harness had itself put in front of the model then scored its whole path as novel material. The
 * budget below is a kilobyte and a real documentation path costs forty to sixty bytes of it, so
 * that eviction was worth roughly twenty pages of the budget - it would have turned the deep
 * unattended research turn this product exists for into a turn that stops to ask. Sixteen searches
 * deep, and at worst a few tens of kilobytes of the trajectory.
 */
const MAX_KNOWN_ADDRESSES = 192;

/**
 * Long enough that a real address is remembered whole, because a truncated one is a different
 * address.
 *
 * The credit below is an identity test, so clipping the tail costs the whole credit: at 256 a real
 * 301-character NHS disclosure-log URL that a search had just handed the model would be charged as
 * 94 bytes of material the model chose, two under the per-address bound, on a turn where nothing
 * had been composed at all. Measured over 136 recorded addresses one exceeds 256 and none exceeds
 * 512; the median is 54. The cost of the headroom is bounded and small - 192 addresses at 512 is
 * 98 KB of turn state in the worst case, against the 40 KB of the owner's words already beside it.
 */
const MAX_ADDRESS_CHARS = 512;

export const originOf = (value: string): string => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** Adds a host to the known set, newest last, bounded so a long task cannot grow it forever. */
export const rememberOrigin = (known: string[], value: string): string[] => {
  const host = originOf(value);
  if (!host || known.includes(host)) return known;
  const next = [...known, host];
  return next.length > MAX_KNOWN_ORIGINS ? next.slice(next.length - MAX_KNOWN_ORIGINS) : next;
};

/** Adds a whole address the turn was handed, newest last, so following it later is not novel. */
export const rememberAddress = (known: string[], value: string): string[] => {
  const address = value.trim().slice(0, MAX_ADDRESS_CHARS);
  if (!originOf(address) || known.includes(address)) return known;
  const next = [...known, address];
  return next.length > MAX_KNOWN_ADDRESSES ? next.slice(next.length - MAX_KNOWN_ADDRESSES) : next;
};

/**
 * The parts of an address that could carry a payload: path segments, query names and query values,
 * and the fragment. The host is judged separately, and the scheme carries nothing.
 */
const addressTokens = (url: URL): string[] => {
  const raw = [
    ...url.pathname.split('/'),
    ...[...url.searchParams].flatMap(([name, value]) => [name, value]),
    url.hash.replace(/^#/, '')
  ];
  return raw
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .map((part) => part.trim())
    .filter(Boolean);
};

/** The labels a name adds in front of the part that was already allowed. */
const labelsBeyond = (host: string, suffix: string): string[] =>
  (host === suffix ? '' : host.slice(0, host.length - suffix.length - 1))
    .split('.')
    .filter(Boolean);

/**
 * What these pieces of an address cost: the price of choosing each one, and the length of any the
 * corpus cannot account for.
 *
 * Never zero for a piece that is present, which is the property the whole file rests on. The
 * previous rule was a filter, and a filter can be emptied.
 */
const chosenBytes = (tokens: readonly string[], corpus: string): number =>
  tokens.reduce(
    (total, token) =>
      total +
      (token.length <= MAX_CREDITED_TOKEN_CHARS && corpus.includes(token.toLowerCase())
        ? MIN_TOKEN_BYTES
        : Math.max(MIN_TOKEN_BYTES, token.length)),
    0
  );

/**
 * The identity of an address: the request it would make, and nothing looser.
 *
 * `href` after parsing, which lowercases the scheme and the host - the two parts a server cannot
 * tell apart - and leaves the path, the query and the fragment exactly as written. Anything looser
 * is a channel, and both of the obvious loosenings were measured to be one before this said `href`:
 * lowercasing the whole address made `/GuIDe/PrIciNG-and-plans-for-teams` the same address as the
 * one the search handed over, which is a free bit per letter - 4,096 requests, 12 bits each, charged
 * 0 - and trimming trailing slashes made `/guide/pricing/` and `/guide/pricing//` the same, which is
 * another few bits a request for as many requests as anyone likes. A credit is only safe if the
 * thing it credits could not have been chosen.
 */
const sameAddress = (value: string): string => {
  try {
    return new URL(value.trim()).href;
  } catch {
    return value.trim();
  }
};

/**
 * Whether this exact address is one the model was handed rather than one it composed.
 *
 * Charging by the piece would otherwise put a price on following a search result, and following a
 * search result is what a research turn is: six addresses a search returned cost 0 under the old
 * filter, and would cost a couple of bytes a segment under the new charge for no reason anybody
 * could defend - the harness put those addresses in front of the model itself.
 *
 * Whole addresses only, and only from the two sources an attacker cannot write into: `ownerText` is
 * the owner's own messages, and `knownAddresses` is the harness's own reading of a search result or
 * of where a read landed, never what a page said. A prefix would not do - handed
 * `https://docs.example.com/a/b` would then pay nothing for `/a/b/<the mailbox>` - so it is the
 * whole address or nothing.
 */
const wasHanded = (value: string, context: DestinationContext): boolean => {
  const target = sameAddress(value);
  return (
    (context.knownAddresses ?? []).some((address) => sameAddress(address) === target) ||
    (context.ownerText.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? []).some(
      (address) => sameAddress(address) === target
    )
  );
};

/**
 * Adds what one address carried to what this turn has already sent.
 *
 * Charged where the request is judged rather than where it is written, so the two can never
 * disagree about what a call reaches: an address the classifier did not see is an address the
 * budget does not know about.
 */
export const chargeNovelty = (spent: number, verdicts: readonly DestinationVerdict[]): number =>
  verdicts.reduce((total, verdict) => total + verdict.noveltyBytes, spent);

export const classifyDestination = (
  value: string,
  context: DestinationContext
): DestinationVerdict => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      sink: true,
      host: 'unparseable address',
      noveltyBytes: value.length,
      reason: 'this address could not be parsed',
      reach: 'estate'
    };
  }
  if (!['http:', 'https:'].includes(url.protocol))
    return {
      sink: true,
      host: url.protocol.replace(':', ''),
      noveltyBytes: value.length,
      reason: `the ${url.protocol.replace(':', '')} scheme is not a web read`,
      reach: 'estate'
    };
  /*
   * A name that ends in the DNS root label is the same name.
   *
   * `getaddrinfo` accepts `docs.example.com.` and answers for `docs.example.com` - measured on this
   * box, `localhost.` resolves to 127.0.0.1 - so the two spellings reach one host and everything
   * below has to be looking at the same one. Normalised here, once, before anything judges it,
   * because this host is read by four separate rules and the trailing dot broke all four in the
   * same direction: `isPublicHttpUrl` saw a name that was not loopback, `matchingHostSuffix` saw a
   * host the owner had not named, `chosenBytes` priced the extra label, and the card printed a name
   * with a dot on the end. `https://docs.example.com./guide` to the owner's own host was a card at
   * 10 bytes, and a card in front of ordinary work is how a floor gets switched off.
   *
   * Guarded on length so a hostname that is only the root label is left exactly as written: it
   * names nothing, and the empty string this would otherwise assign is a value `URL` discards
   * silently, which would leave the host as the last thing anybody expected.
   */
  if (url.hostname.length > 1 && url.hostname.endsWith('.'))
    url.hostname = url.hostname.slice(0, -1);
  const host = url.hostname.toLowerCase();
  /*
   * Somewhere data cannot go is not somewhere data can be sent - and neither of those is "the LAN".
   *
   * Asking the owner to approve the agent reading its own web server would raise a card at every
   * step of a "build a page and serve it" run, each one garden talking to itself -
   * `localhost:8080`, its own preview URL on its own domain - with nothing leaving the machine, and
   * the owner would learn to click Approve without reading - which is the only way this rule can
   * actually fail.
   *
   * "Is this out on the internet" is not the answer to that: it is false for loopback and equally
   * false for 192.168.0.0/16, 10.0.0.0/8, the link-local block where the cloud metadata service
   * lives, and every `*.internal`, `*.local` and `*.home.arpa` name. Asked alone, it gives the
   * whole of the owner's own network the same verdict as this process talking to itself:
   * `sink: false`, nought bytes charged, no card in any mode on a clean turn or a hostile one, so
   * `curl http://192.168.1.50/notes` and `curl http://169.254.169.254/latest/meta-data/` are free.
   *
   * That is one question answered where two were asked, and the two differ in exactly the way this
   * file's whole argument turns on: an address is how data leaves this computer, and the owner's
   * NAS, their router and the metadata service are all not this computer. So the question asked
   * here is `reachOfHttpUrl`, which has three answers, and only the first of them is free.
   *
   * `self` is what the loopback case is actually about: the health check the owner's own scenario
   * ends on stays at nought bytes and no card.
   * `estate` is charged and judged exactly like the internet below, differing only in the words on
   * the card - and it is the ORDINARY floor, not this one, that is entitled to treat the LAN as out
   * of scope, which it says by reading `verdict.reach` rather than by being handed a verdict that
   * lies to it. Publishing something to the internet is still gated where it is decided:
   * `publish_preview` with `reach: 'public'` raises its own external_consequential card in every
   * security mode, on a clean turn and on a tainted one, and this is not a way round it. The floor
   * reads the reach - `publishReachOfCall` in approval-policy.ts - which is what keeps the public
   * half of the one publishing tool behind its card.
   */
  const reach = (context.selfOrigins ?? []).some(
    (origin) => origin && host === origin.toLowerCase()
  )
    ? // This installation's own published address is this installation, whatever the DNS says about
      // where the name points. A read of it is the box reading itself.
      'self'
    : reachOfHttpUrl(url.toString());
  if (reach === 'self') return { sink: false, host, noveltyBytes: 0, reason: '', reach };
  // An address the harness handed the model is an address the model did not compose, so there is
  // nothing of the owner's in it to charge for however long it is.
  if (wasHanded(value, context)) return { sink: false, host, noveltyBytes: 0, reason: '', reach };
  // Compared case-insensitively and without the separators a URL adds, so a path segment that the
  // owner wrote as two words still counts as theirs.
  const corpus =
    `${context.ownerText}\n${context.knownOrigins.join('\n')}\n${(context.knownAddresses ?? []).join('\n')}`.toLowerCase();
  const addressNovelty = chosenBytes(addressTokens(url), corpus);
  const matched = matchingHostSuffix(host, context.knownOrigins);
  if (!matched)
    return {
      sink: true,
      host,
      ...(reach === 'internet' ? { unfamiliarPublicHost: true } : {}),
      noveltyBytes: addressNovelty + chosenBytes(host.split('.'), corpus),
      /*
       * Named separately for the estate, because "not a host the user named" is a true sentence
       * that reads as an accusation about the internet, and the owner answering this card needs to
       * know which of their own machines is being talked to. A search never returns a LAN address
       * and the read tools refuse to open one, so the only way a host gets on this list is the
       * owner writing it down - which is exactly the distinction the card should draw.
       */
      reason:
        reach === 'estate'
          ? `${host} is another computer on this network, and not one the user named`
          : `${host} is not a host the user named, a search returned, or this turn has already read`,
      reach
    };
  /*
   * The name is measured too, against the part of it that was already allowed.
   *
   * `isKnownOrigin` answered yes for anything ending in an allowed suffix and nothing then looked
   * at what came in front of it, so every host already read this turn was also a wildcard channel
   * out. Held to its own, much smaller bound rather than folded into the address one: a real
   * subdomain is a word and cannot use the room a long legitimate path needs.
   */
  const hostNovelty = chosenBytes(labelsBeyond(host, matched), corpus);
  /*
   * At least the price of one piece, even when the address has no pieces at all.
   *
   * `https://a-host-already-read/` tokenises to nothing, so without this it is a free request - and
   * which of the hosts a turn has read gets asked next is itself a choice, so a free request is a
   * channel that repeats without limit. It is the same defect as the zero-rated token wearing a
   * different address.
   */
  const noveltyBytes = Math.max(MIN_TOKEN_BYTES, addressNovelty + hostNovelty);
  if (hostNovelty > MAX_NOVEL_HOST_BYTES)
    return {
      sink: true,
      host,
      noveltyBytes,
      reason: `the name ${host} puts ${hostNovelty} bytes in front of ${matched} that the user's request and the pages already read do not account for`,
      reach
    };
  /*
   * The payload bound, on ONE piece rather than on the sum of them.
   *
   * The two bounds above it hold apart what a single per-address bound would have to. A composed
   * query - the boolean a research task writes into a REST read, a cursorMark, a field list - is
   * many short pieces totalling well over 96 bytes, and under one per-address bound at 96 a
   * research turn in autonomous would ask after every such read with a card reporting a payload
   * shape. The payload itself is one long opaque piece, and
   * that is the shape this catches - a base64 blob in one path segment trips it immediately,
   * while any piece of a real link or a real query is comfortably under it.
   *
   * The sum keeps its own bound below, raised to give the structure room.
   */
  const longestToken = addressTokens(url).reduce(
    (longest, token) => Math.max(longest, token.length),
    0
  );
  if (longestToken > MAX_NOVEL_TOKEN_CHARS)
    return {
      sink: true,
      host,
      noveltyBytes,
      reason: `one piece of this address is ${longestToken} characters the model chose rather than was handed, past the ${MAX_NOVEL_TOKEN_CHARS} a real piece of a link needs`,
      reach
    };
  if (noveltyBytes > MAX_NOVEL_URL_BYTES)
    return {
      sink: true,
      host,
      noveltyBytes,
      reason: `this address carries ${noveltyBytes} bytes the model chose rather than was handed, past the ${MAX_NOVEL_URL_BYTES} a real request needs`,
      reach
    };
  const spent = Math.max(0, context.spentNoveltyBytes ?? 0);
  if (spent + noveltyBytes > MAX_TURN_NOVEL_BYTES)
    return {
      sink: true,
      host,
      noveltyBytes,
      reason: `this turn has already put ${spent} bytes into addresses that the user's request does not account for, and ${noveltyBytes} more here is past the ${MAX_TURN_NOVEL_BYTES} allowed while untrusted content is in the turn`,
      reach
    };
  return { sink: false, host, noveltyBytes, reason: '', reach };
};
