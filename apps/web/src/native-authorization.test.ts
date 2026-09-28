import { createHash, createPublicKey, verify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  nativeAuthorizationMessage,
  type NativeAuthorizationProof,
  type NativeAuthorizationStart
} from '@garden/contracts';
const mocks = vi.hoisted(() => ({ post: vi.fn(), open: vi.fn(), wait: vi.fn() }));
vi.mock('./client', () => ({ post: mocks.post, waitForRetry: mocks.wait }));
vi.mock('./native', () => ({
  nativeCapabilities: async () => ({ browserAuthorization: true }),
  openAuthorizationBrowser: mocks.open
}));
import {
  authorizationFragment,
  authorizationSnapshot,
  authorizeNative,
  browserAuthorizationLocation
} from './native-authorization';
const serverOrigin = 'https://garden.example',
  nativeOrigin = 'http://localhost:49152';
const id = '11111111-1111-4111-8111-111111111111';
const owner = { id: 'owner', username: 'owner', displayName: 'Owner' };
const proofCalls = () =>
  mocks.post.mock.calls as unknown as Array<[string, { action?: string; signature?: string }]>;
const response = () => ({
  id,
  serverOrigin,
  purpose: 'sign_in',
  status: 'pending',
  userCode: 'ABCD-2345',
  deviceLabel: 'garden app on Android',
  verificationUri: `${serverOrigin}/#native-auth=${id}`,
  pollIntervalMs: 5000,
  expiresAt: new Date(Date.now() + 600000).toISOString()
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function location() {
  vi.stubGlobal('location', { origin: nativeOrigin });
}
describe('native browser authorization client', () => {
  it('produces a WebCrypto proof the server verifies without putting secrets in browser navigation', async () => {
    location();
    let start: NativeAuthorizationStart | undefined;
    mocks.open.mockResolvedValue(undefined);
    mocks.post.mockImplementation(
      async (path: string, payload: NativeAuthorizationStart | NativeAuthorizationProof) => {
        if (path.endsWith('/start')) {
          start = payload as NativeAuthorizationStart;
          return response();
        }
        const proof = payload as NativeAuthorizationProof;
        expect(start).toBeDefined();
        expect(createHash('sha256').update(proof.verifier).digest('base64url')).toBe(
          start!.challenge
        );
        expect(
          verify(
            'sha256',
            Buffer.from(
              nativeAuthorizationMessage({
                id,
                serverOrigin,
                nativeOrigin,
                purpose: 'sign_in',
                challenge: start!.challenge,
                action: proof.action
              })
            ),
            {
              key: createPublicKey({
                key: Buffer.from(start!.devicePublicKey, 'base64url'),
                format: 'der',
                type: 'spki'
              }),
              dsaEncoding: 'ieee-p1363'
            },
            Buffer.from(proof.signature, 'base64url')
          )
        ).toBe(true);
        expect(proof.action).toBe('redeem');
        expect(mocks.open).toHaveBeenCalledExactlyOnceWith(`${serverOrigin}/#native-auth=${id}`);
        return { status: 'authorized', user: owner };
      }
    );
    expect(await authorizeNative('sign_in')).toEqual({ user: owner });
    expect(authorizationSnapshot()).toBeNull();
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });
  it('blocks concurrent starts while generating keys and cancels failed requests with device proof', async () => {
    location();
    mocks.open.mockResolvedValue(undefined);
    mocks.post.mockImplementation(async (path: string, payload: NativeAuthorizationProof) => {
      if (path.endsWith('/start')) return response();
      if (payload.action === 'cancel') return { status: 'denied' };
      throw new Error('Connection interrupted');
    });
    const first = authorizeNative('sign_in');
    const failure = expect(first).rejects.toThrow('Connection interrupted');
    await expect(authorizeNative('sign_in')).rejects.toThrow('Finish the current');
    await failure;
    const cancellations = proofCalls().filter(
      ([path, body]) => path.endsWith('/redeem') && body.action === 'cancel'
    );
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]?.[1].signature).toHaveLength(86);
    expect(authorizationSnapshot()).toBeNull();
  });
  it('keeps browser opener failures recoverable and respects cancellation before redemption', async () => {
    location();
    const openerError = new Error('Browser unavailable');
    mocks.open.mockRejectedValue(openerError);
    mocks.post.mockImplementation(async (path: string, payload: NativeAuthorizationProof) => {
      if (path.endsWith('/start')) return response();
      if (payload.action === 'cancel') return { status: 'denied' };
      expect(authorizationSnapshot()?.openingError).toBe(openerError);
      authorizationSnapshot()!.cancel();
      return { status: 'pending' };
    });
    mocks.wait.mockImplementation(async (_milliseconds: number, signal: AbortSignal) =>
      signal.throwIfAborted()
    );
    await expect(authorizeNative('sign_in')).rejects.toThrow('cancelled');
    expect(proofCalls().filter(([, body]) => body.action === 'redeem')).toHaveLength(1);
    expect(proofCalls().filter(([, body]) => body.action === 'cancel')).toHaveLength(1);
  });
  it('rejects a destination outside the server flow before invoking the system browser', async () => {
    location();
    const invalid = [
      'https://outside.example/',
      `${serverOrigin}/callback#native-auth=${id}`,
      `${serverOrigin}/?token=secret#native-auth=${id}`,
      `${serverOrigin}/#native-auth=22222222-2222-4222-8222-222222222222`
    ];
    expect(invalid.length).toBeGreaterThan(0);
    for (const verificationUri of invalid) {
      mocks.post.mockResolvedValue({ ...response(), verificationUri });
      await expect(authorizeNative('sign_in')).rejects.toThrow(
        'invalid device authorization address'
      );
    }
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it('moves onboarding only through the fragment and removes it from browser history on arrival', () => {
    const onboarding = {
      mode: 'enroll',
      code: 'one-time-device-enrollment-token',
      name: 'My phone'
    };
    const fragment = `#native-auth=${id}&native-onboard=${Buffer.from(JSON.stringify(onboarding)).toString('base64url')}`;
    expect(authorizationFragment(fragment)).toEqual({ id, onboarding });
    const replaceState = vi.fn();
    vi.stubGlobal('history', { replaceState });
    vi.stubGlobal('location', { hash: fragment, pathname: '/', search: '' });
    expect(browserAuthorizationLocation()).toEqual({ id, onboarding });
    expect(replaceState).toHaveBeenCalledExactlyOnceWith({}, '', `/#native-auth=${id}`);
    expect(authorizationFragment('#native-auth=invalid')).toBeNull();
    expect(
      authorizationFragment(`#native-auth=${id}&native-onboard=broken`)?.onboarding
    ).toBeNull();
  });
});
