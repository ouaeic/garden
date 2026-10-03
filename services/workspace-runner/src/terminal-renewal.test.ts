import { describe, expect, it } from 'vitest';
import {
  MAX_CAPABILITY_TTL_SECONDS,
  capabilityAudience,
  signCapabilityToken,
  verifyCapabilityToken
} from '@garden/core';
// The branch itself, not a restatement of it: against a local copy of the predicate, removing a
// clause from the runner would leave every one of these cases green.
import { renewalExtendsSession } from './server.js';

/**
 * The check the terminal socket applies to a renewal.
 *
 * A terminal may not outlive the capability that opened it - a shell on the box has to stay
 * revocable - but capabilities are capped at fifteen minutes, so without renewal that rule meant
 * the session died on a timer while the owner was typing. The renewal frame extends the deadline
 * without widening anything, which is only true if the new claim is checked against the one that
 * opened the socket rather than merely being well-signed.
 */
const SECRET = 'runner-shared-secret-for-tests-at-least-32-chars-long';
const AUDIENCE = { method: 'GET', path: '/v1/workspaces/w1/terminal' };

const token = (
  over: Partial<{
    sub: string;
    workspaceId: string;
    role: 'control' | 'agent' | 'user';
    scopes: string[];
    aud: string;
  }> = {},
  ttlSeconds = MAX_CAPABILITY_TTL_SECONDS
): string =>
  signCapabilityToken(
    {
      sub: 'user-1',
      workspaceId: 'w1',
      role: 'user',
      scopes: ['terminal'],
      nonce: `nonce-${Math.floor(Math.random() * 1e9)}`,
      aud: capabilityAudience(AUDIENCE.method, AUDIENCE.path),
      ...over
    },
    SECRET,
    ttlSeconds
  );

describe('renewing a terminal capability', () => {
  const opened = verifyCapabilityToken(token(), SECRET, AUDIENCE);

  it('accepts a fresh capability for the same session, and it buys real time', () => {
    const renewed = verifyCapabilityToken(token(), SECRET, AUDIENCE);
    expect(renewalExtendsSession(renewed, opened)).toBe(true);
    // The point of the exercise: the deadline actually moves out.
    expect(renewed.exp).toBeGreaterThanOrEqual(opened.exp);
  });

  it('refuses one minted for another owner, workspace, role or scope', () => {
    const cases = [
      token({ sub: 'user-2' }),
      token({ workspaceId: 'w2' }),
      token({ role: 'agent' }),
      token({ scopes: ['files'] })
    ];
    for (const other of cases) {
      // `w2` is bound to a different path, so some of these fail at the audience and the rest at
      // the predicate. Either way the renewal must not extend this session.
      let matched = false;
      try {
        matched = renewalExtendsSession(verifyCapabilityToken(other, SECRET, AUDIENCE), opened);
      } catch {
        matched = false;
      }
      expect(matched).toBe(false);
    }
  });

  it('refuses one minted for a different request, so a token seen elsewhere cannot extend a shell', () => {
    const elsewhere = token({ aud: capabilityAudience('POST', '/v1/workspaces/w1/exec') });
    expect(() => verifyCapabilityToken(elsewhere, SECRET, AUDIENCE)).toThrow();
  });

  it('cannot be used to buy more than the cap allows', () => {
    expect(() => token({}, MAX_CAPABILITY_TTL_SECONDS + 1)).toThrow();
  });
});
