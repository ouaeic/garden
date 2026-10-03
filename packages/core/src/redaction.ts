/**
 * The last thing between a secret and somewhere it can be read - a log line, an error that crosses
 * a process boundary, a stored audit record. It is a net, not a policy: the policy is that these
 * surfaces carry identifiers and codes only, and this catches the cases where a value turns out to
 * have been something else.
 *
 * What it catches matters. Security events are written on every taint transition and every refused
 * destination, and those records carry addresses the agent chose while reading somebody else's
 * page - so this net is on the path of exactly the values an attacker is trying to move.
 */
const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'secret',
  'token',
  'api_key',
  'apikey',
  'prompt',
  'messages',
  'content',
  'screenshot',
  'terminal_output',
  'dom'
]);

/**
 * Credential shapes, each one a prefix a person can recognise in the output.
 *
 * Schemes are separated out from the prefixes. In the same alternation, followed by a character
 * class with no space in it, `Bearer` would match nothing in `Authorization: Bearer eyJhbGci…`, the
 * way the header is actually written, and fire only on the malformed no-space form. What follows a
 * scheme is a delimiter, not more of the same token.
 */
const SECRET_PATTERNS: RegExp[] = [
  // First, so that `Bearer sk-live-…` collapses to one marker rather than to `Bearer [REDACTED]`.
  /\b(?:Bearer|Basic|Token)\s+[-_A-Za-z0-9+/=.]{10,}/gi,
  /\b(?:sk|pk|ghp|gho|ghu|ghs|ghr|github_pat|xox[baprs]|glpat|dop_v1|rk_live|sq0csp)[-_A-Za-z0-9.]{10,}\b/gi,
  // AWS access key identifiers, which are fixed-length and unmistakable.
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // Any JSON web token, whichever provider issued it.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // A private key block, which is worth catching whole rather than by its base64 body.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /*
   * A share link, whole. The path segment is a capability - anyone holding it can read the
   * snapshot - and the fragment after it is the key that opens the snapshot, so a pasted link in
   * an error message or a log line is both halves of a secret at once. The fixed 22-character
   * segment is the recognisable prefix; the lookahead keeps an owner-side route naming a UUID
   * (`/v1/shares/<36 characters>`) from being cut in half and half-leaked.
   */
  /\/v1\/shares\/[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])(?:#\S*)?/g
];

/**
 * A password written into a URL, which no other rule here can see.
 *
 * `https://jo:app-password@cloud.example/dav/` is a complete credential, and it reaches these
 * surfaces as an ordinary address: a connector error naming the URL it failed on, an audit record
 * of a refused destination. The host is kept, because the host is the part of the record that is
 * worth having.
 */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;

export const redactText = (value: string): string => {
  let redacted = value.replace(URL_CREDENTIALS, '$1[REDACTED]@');
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replaceAll(pattern, '[REDACTED]');
  return redacted;
};

export const redactObject = (value: unknown, depth = 0): unknown => {
  if (depth > 8) return '[MAX_DEPTH]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactObject(item, depth + 1));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redactObject(item, depth + 1)
    ])
  );
};
