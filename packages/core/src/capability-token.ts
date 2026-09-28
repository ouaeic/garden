import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CapabilityTokenClaims {
  sub: string;
  workspaceId: string;
  role: 'control' | 'agent' | 'user';
  scopes: string[];
  /**
   * The request or requests this token was minted for, each as `METHOD /path`. It answers replay -
   * a token observed on a file read cannot be turned against `exec` - which is a different
   * question from forgery, since anyone holding the signing secret can mint whatever they like
   * regardless.
   *
   * Still optional in the type, because a token minted by a control plane one release behind this
   * runner is on the wire during a rolling deploy and has to be *refused* rather than crash the
   * parse. It is no longer optional in effect: `verifyCapabilityToken` requires an audience and
   * compares it, so a token that names no request is now refused everywhere. It used to be skipped
   * whenever the claim was absent, and nine of the worker's ten signing sites never set one - which
   * made the whole scheme advisory, and made every capability a bearer token for everything its
   * scopes admitted.
   *
   * A list, for the two credentials a client uses for several calls in a row: a browser or desktop
   * takeover is a stream, an action and a holder change, and one audience would break the flow
   * rather than secure it. Naming all three is still a bound - it is what keeps such a token off
   * `browser/read-many`, which fetches an arbitrary address, and off `browser/search` - and it is
   * the narrowest binding available while the client asks for one credential and uses it three
   * ways.
   */
  aud?: string | string[];
  iat: number;
  exp: number;
  nonce: string;
}

/**
 * No legitimate holder needs a capability for longer than a stream setup takes, and the longest any
 * signer in this repository asks for is two minutes. Capping the lifetime in the verifier - rather
 * than trusting each signer to pass a small number - is what keeps a leaked signing secret from
 * minting a token that outlives the leak.
 */
export const MAX_CAPABILITY_TTL_SECONDS = 900;

/** A token stamped in the future would otherwise buy itself extra life against the cap above. */
const MAX_CLOCK_SKEW_SECONDS = 60;

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

const signature = (input: string, secret: string): Buffer =>
  createHmac('sha256', secret).update(input).digest();

/**
 * The audience is the method and the path without its query string. The query carries the
 * arguments of a call, not its identity - `?path=a` and `?path=b` are the same capability - and
 * including it would only make every token unreusable in ways the scope set already covers.
 */
export const capabilityAudience = (method: string, path: string): string =>
  `${method.toUpperCase()} ${path.split('?')[0]}`;

/** The same, for a credential a client legitimately spends on more than one route. */
export const capabilityAudiences = (
  requests: ReadonlyArray<{ method: string; path: string }>
): string[] => requests.map((request) => capabilityAudience(request.method, request.path));

export const signCapabilityToken = (
  claims: Omit<CapabilityTokenClaims, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds = 60
): string => {
  if (secret.length < 32) throw new Error('Runner shared secret must be at least 32 characters');
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_CAPABILITY_TTL_SECONDS)
    throw new Error(`Capability lifetime must be 1-${MAX_CAPABILITY_TTL_SECONDS} seconds`);
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'HS256', typ: 'OCAP', v: 1 });
  const payload = encode({ ...claims, iat: now, exp: now + ttlSeconds });
  const input = `${header}.${payload}`;
  return `${input}.${signature(input, secret).toString('base64url')}`;
};

export interface CapabilityExpectation {
  method: string;
  path: string;
}

/**
 * `expected` is required, and that is the whole of the repair.
 *
 * It was optional, and the comparison was additionally skipped whenever the token itself named no
 * audience - two escapes, either of which turned a capability back into a bearer token. A caller
 * that cannot say which request it is verifying does not know enough to verify one.
 */
export const verifyCapabilityToken = (
  token: string,
  secret: string,
  expected: CapabilityExpectation
): CapabilityTokenClaims => {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed capability token');
  const [header, payload, encodedSignature] = parts as [string, string, string];
  const expectedSignature = signature(`${header}.${payload}`, secret);
  const actual = Buffer.from(encodedSignature, 'base64url');
  if (actual.length !== expectedSignature.length || !timingSafeEqual(actual, expectedSignature)) {
    throw new Error('Invalid capability token signature');
  }
  const claims = JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8')
  ) as CapabilityTokenClaims;
  if (!claims.workspaceId || !claims.sub || !Array.isArray(claims.scopes)) {
    throw new Error('Invalid capability claims');
  }
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp))
    throw new Error('Invalid capability lifetime');
  if (claims.iat > now + MAX_CLOCK_SKEW_SECONDS)
    throw new Error('Capability token is not yet valid');
  if (claims.exp - claims.iat > MAX_CAPABILITY_TTL_SECONDS)
    throw new Error('Capability lifetime exceeds the maximum');
  if (claims.exp <= now) throw new Error('Capability token expired');
  const named =
    claims.aud === undefined ? [] : Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!named.includes(capabilityAudience(expected.method, expected.path)))
    throw new Error('Capability token was minted for a different request');
  return claims;
};

export const requireCapability = (claims: CapabilityTokenClaims, scope: string): void => {
  if (!claims.scopes.includes(scope)) {
    throw new Error(`Capability ${scope} is required`);
  }
};

/**
 * A fixed-length, secret-keyed name for one capability, for a ledger that has to remember it.
 *
 * SECURITY.md's invariant list says capability tokens are single-use, and the HTTP path keeps that
 * promise in `authenticateRunnerRequest`'s nonce ledger. The terminal socket's renewal frame did
 * not go through that hook, so a renewal was replayable for its whole lifetime - to that socket and
 * to every other terminal the same owner had open. The runner now keeps its own ledger of the
 * renewals it has spent, and keys it through here.
 *
 * Derived rather than stored raw for a reason the ledger cares about: `nonce` is an arbitrary
 * string carried inside a signed token, so a bounded-*count* ledger holding raw nonces is still
 * unbounded in bytes. This is always 43 characters, and it names the capability without holding the
 * value that would let anyone re-present it.
 */
export const deriveCapabilityNonce = (parentNonce: string, secret: string): string => {
  if (!parentNonce) throw new Error('Parent capability nonce is required');
  if (secret.length < 32) throw new Error('Runner shared secret must be at least 32 characters');
  return createHmac('sha256', secret)
    .update(`garden-derived-capability:${parentNonce}`)
    .digest('base64url');
};
