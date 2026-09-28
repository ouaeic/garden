import type {
  NativeAuthorization,
  NativeAuthorizationProof,
  NativeAuthorizationPurpose
} from '@garden/contracts';
import { post, waitForRetry } from './client';
import { nativeCapabilities, openAuthorizationBrowser } from './native';
import type { AuthResult } from './auth';

export type NativeOnboarding = {
  mode: 'register' | 'enroll' | 'recover' | 'passkey';
  code: string;
  name?: string;
};
export interface AuthorizationView {
  authorization: NativeAuthorization;
  verificationUri: string;
  openingError: unknown;
  cancel: () => void;
}
let current: AuthorizationView | null = null;
let inFlight = false;
const listeners = new Set<() => void>();
export const authorizationSnapshot = () => current;
export const subscribeAuthorization = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function publish(value: AuthorizationView | null) {
  current = value;
  for (const listener of listeners) listener();
}
const b64 = (value: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...(value instanceof Uint8Array ? value : new Uint8Array(value))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
export const prefersBrowserAuthorization = async () =>
  Boolean((await nativeCapabilities())?.browserAuthorization);

export function authorizationFragment(
  fragment: string
): { id: string; onboarding: NativeOnboarding | null } | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  const id = params.get('native-auth');
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    return null;
  let onboarding: NativeOnboarding | null = null;
  try {
    const encoded = params.get('native-onboard');
    if (encoded && encoded.length <= 4096 && /^[A-Za-z0-9_-]+$/.test(encoded)) {
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')), (char) =>
            char.charCodeAt(0)
          )
        )
      );
      if (
        value &&
        typeof value === 'object' &&
        'mode' in value &&
        'code' in value &&
        ['register', 'enroll', 'recover', 'passkey'].includes(String(value.mode)) &&
        typeof value.code === 'string' &&
        value.code.length <= 512
      )
        onboarding = {
          mode: value.mode as NativeOnboarding['mode'],
          code: value.code,
          ...('name' in value && typeof value.name === 'string' && value.name.length <= 80
            ? { name: value.name }
            : {})
        };
    }
  } catch {
    /* Invalid onboarding data leaves the ordinary browser sign-in available. */
  }
  return { id, onboarding };
}
let locationRequest: ReturnType<typeof authorizationFragment> | undefined;
export function browserAuthorizationLocation() {
  if (locationRequest === undefined) {
    locationRequest = authorizationFragment(location.hash);
    if (locationRequest)
      history.replaceState(
        {},
        '',
        `${location.pathname}${location.search}#native-auth=${locationRequest.id}`
      );
  }
  return locationRequest;
}

export async function authorizeNative(
  purpose: NativeAuthorizationPurpose,
  onboarding?: NativeOnboarding
): Promise<AuthResult> {
  if (inFlight) throw new Error('Finish the current device authorization first.');
  inFlight = true;
  try {
    return await runAuthorization(purpose, onboarding);
  } finally {
    inFlight = false;
  }
}

async function runAuthorization(
  purpose: NativeAuthorizationPurpose,
  onboarding?: NativeOnboarding
): Promise<AuthResult> {
  const controller = new AbortController();
  const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify'
  ]);
  const nativeOrigin = location.origin;
  const authorization = await post<
    NativeAuthorization & { verificationUri: string; pollIntervalMs: number }
  >('/v1/auth/native/start', {
    purpose,
    nativeOrigin,
    challenge,
    devicePublicKey: b64(await crypto.subtle.exportKey('spki', keys.publicKey))
  });
  const destination = new URL(authorization.verificationUri);
  if (
    destination.origin !== authorization.serverOrigin ||
    destination.protocol !== 'https:' ||
    destination.pathname !== '/' ||
    destination.search ||
    destination.username ||
    destination.password ||
    destination.hash !== `#native-auth=${authorization.id}`
  )
    throw new Error('The server returned an invalid device authorization address.');
  if (onboarding)
    destination.hash += `&native-onboard=${b64(new TextEncoder().encode(JSON.stringify(onboarding)))}`;
  async function proof(action: 'redeem' | 'cancel'): Promise<NativeAuthorizationProof> {
    const message = [
      'garden-native-authorization-v1',
      authorization.serverOrigin,
      authorization.id,
      nativeOrigin,
      purpose,
      challenge,
      action
    ].join('\n');
    return {
      id: authorization.id,
      verifier,
      nativeOrigin,
      action,
      signature: b64(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          keys.privateKey,
          new TextEncoder().encode(message)
        )
      )
    };
  }
  const cancel = () => {
    controller.abort(new DOMException('Device authorization cancelled', 'AbortError'));
  };
  let authorized = false;
  publish({ authorization, verificationUri: destination.toString(), openingError: null, cancel });
  try {
    try {
      await openAuthorizationBrowser(destination.toString());
    } catch (cause) {
      publish({
        authorization,
        verificationUri: destination.toString(),
        openingError: cause,
        cancel
      });
    }
    while (Date.now() < Date.parse(authorization.expiresAt)) {
      controller.signal.throwIfAborted();
      const result = await post<{
        status: 'pending' | 'denied' | 'authorized';
        user?: AuthResult['user'];
      }>('/v1/auth/native/redeem', await proof('redeem'), { signal: controller.signal });
      if (result.status === 'authorized' && result.user) {
        authorized = true;
        return { user: result.user };
      }
      if (result.status === 'denied') throw new Error('Device authorization was declined.');
      await waitForRetry(Math.max(5000, authorization.pollIntervalMs), controller.signal);
    }
    throw new Error('Device authorization expired. Start again.');
  } finally {
    publish(null);
    if (!authorized)
      await post('/v1/auth/native/redeem', await proof('cancel'), {
        signal: AbortSignal.timeout(5000)
      }).catch(() => undefined);
  }
}
