import { isNativeClient, post } from './client.js';
import type {
  startAuthentication as browserAuthentication,
  startRegistration as browserRegistration
} from '@simplewebauthn/browser';

type AuthenticationOptions = Parameters<typeof browserAuthentication>[0]['optionsJSON'];
type RegistrationOptions = Parameters<typeof browserRegistration>[0]['optionsJSON'];
interface Ceremony<T> {
  challengeId: string;
  options: T;
}
export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
}
export interface AuthResult {
  user: AuthUser;
  recoveryCode?: string;
}

const nativeContext = (): { nativeOrigin?: string } =>
  isNativeClient() && typeof window !== 'undefined' ? { nativeOrigin: window.location.origin } : {};

export async function signIn(username?: string): Promise<AuthResult> {
  if (isNativeClient()) {
    const native = await import('./native-authorization');
    if (await native.prefersBrowserAuthorization()) return native.authorizeNative('sign_in');
  }
  const ceremony = await post<Ceremony<AuthenticationOptions>>('/v1/auth/login/options', {
    ...(username ? { username } : {}),
    ...nativeContext()
  });
  const { startAuthentication } = await import('@simplewebauthn/browser');
  const response = await startAuthentication({ optionsJSON: ceremony.options });
  return post<AuthResult>('/v1/auth/login/verify', { challengeId: ceremony.challengeId, response });
}

export async function register(input: {
  displayName: string;
  pairingCode: string;
  username?: string;
}): Promise<AuthResult> {
  if (isNativeClient()) {
    const native = await import('./native-authorization');
    if (await native.prefersBrowserAuthorization())
      return native.authorizeNative('sign_in', {
        mode: 'register',
        code: input.pairingCode,
        name: input.displayName
      });
  }
  const ceremony = await post<Ceremony<RegistrationOptions>>('/v1/auth/register/options', {
    ...input,
    ...nativeContext()
  });
  const { startRegistration } = await import('@simplewebauthn/browser');
  const response = await startRegistration({ optionsJSON: ceremony.options });
  return post<AuthResult>('/v1/auth/register/verify', {
    ...input,
    challengeId: ceremony.challengeId,
    response
  });
}

let pendingStepUp: Promise<void> | undefined;

/** Concurrent sensitive actions share one ceremony; the server decides whether one is needed. */
export function stepUp(force = false): Promise<void> {
  if (pendingStepUp) {
    if (!force) return pendingStepUp;
    // A device request requires a fresh ceremony even if an earlier action reused its window.
    return pendingStepUp.then(() => stepUp(true));
  }
  pendingStepUp = (async () => {
    const ceremony = await post<
      Ceremony<AuthenticationOptions> | { verified: true } | { method: 'password' }
    >('/v1/auth/step-up/options', { ...nativeContext(), ...(force ? { force: true } : {}) });
    if ('verified' in ceremony && ceremony.verified) return;
    if ('method' in ceremony && ceremony.method === 'password') {
      await (await import('./PasswordConfirmation')).confirmPassword();
      return;
    }
    if (isNativeClient()) {
      const native = await import('./native-authorization');
      if (await native.prefersBrowserAuthorization()) {
        await native.authorizeNative('step_up');
        return;
      }
    }

    if (!('options' in ceremony)) throw new Error('The server returned no passkey challenge');
    const { startAuthentication } = await import('@simplewebauthn/browser');
    const response = await startAuthentication({ optionsJSON: ceremony.options });
    await post('/v1/auth/step-up/verify', { challengeId: ceremony.challengeId, response });
  })().finally(() => {
    pendingStepUp = undefined;
  });
  return pendingStepUp;
}

export async function enroll(token: string, deviceLabel?: string): Promise<AuthResult> {
  if (isNativeClient()) {
    const native = await import('./native-authorization');
    if (await native.prefersBrowserAuthorization())
      return native.authorizeNative('sign_in', {
        mode: 'enroll',
        code: token,
        ...(deviceLabel ? { name: deviceLabel } : {})
      });
  }
  const ceremony = await post<Ceremony<RegistrationOptions>>('/v1/auth/enroll/options', {
    token,
    ...nativeContext()
  });
  const { startRegistration } = await import('@simplewebauthn/browser');
  const response = await startRegistration({ optionsJSON: ceremony.options });
  return post<AuthResult>('/v1/auth/enroll/verify', {
    token,
    ...(deviceLabel ? { deviceLabel } : {}),
    challengeId: ceremony.challengeId,
    response
  });
}

export async function recover(recoveryCode: string, username = ''): Promise<AuthResult> {
  if (isNativeClient()) {
    const native = await import('./native-authorization');
    if (await native.prefersBrowserAuthorization())
      return native.authorizeNative('sign_in', { mode: 'recover', code: recoveryCode });
  }
  const ceremony = await post<Ceremony<RegistrationOptions>>('/v1/auth/recover/options', {
    username,
    recoveryCode,
    ...nativeContext()
  });
  const { startRegistration } = await import('@simplewebauthn/browser');
  const response = await startRegistration({ optionsJSON: ceremony.options });
  return post<AuthResult>('/v1/auth/recover/verify', {
    recoveryCode,
    challengeId: ceremony.challengeId,
    response
  });
}

export async function addPasskey(): Promise<unknown> {
  if (isNativeClient()) {
    const native = await import('./native-authorization');
    if (await native.prefersBrowserAuthorization())
      return native.authorizeNative('step_up', { mode: 'passkey', code: '' });
  }
  await stepUp();
  const ceremony = await post<Ceremony<RegistrationOptions>>(
    '/v1/auth/passkeys/options',
    nativeContext()
  );
  const { startRegistration } = await import('@simplewebauthn/browser');
  const response = await startRegistration({ optionsJSON: ceremony.options });
  return post('/v1/auth/passkeys/verify', { challengeId: ceremony.challengeId, response });
}

export const devSignIn = (displayName = 'Local User'): Promise<AuthResult> =>
  post<AuthResult>('/v1/auth/dev', { displayName });
export const signOut = (): Promise<{ ok: boolean }> => post('/v1/auth/logout');

export const passwordSignIn = (password: string): Promise<AuthResult> =>
  post('/v1/auth/password/login', { password });
export const passwordRegister = (
  displayName: string,
  pairingCode: string,
  password: string
): Promise<AuthResult> =>
  post('/v1/auth/password/register', { displayName, pairingCode, password });
export const passwordRecover = (code: string, password: string): Promise<AuthResult> =>
  post('/v1/auth/password/recover', { code, password });
