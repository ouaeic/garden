import { useAuthEntry } from './auth-entry';
import { useEffect, useState } from 'react';
import { Check, Theme } from './app/icons';
import Light from './app/Light';
import Wordmark from './app/Wordmark';
import { get } from './client';
import {
  devSignIn,
  enroll,
  recover,
  register,
  signIn,
  passwordSignIn,
  passwordRegister,
  passwordRecover
} from './auth';
import type { AuthResult } from './auth';
import { Button, ErrorNotice, Field } from './ui';
import './login.css';

export default function Login({
  pairingCode,
  onAuthenticated,
  theme,
  toggleTheme
}: {
  pairingCode: string;
  onAuthenticated: () => void;
  theme: string;
  toggleTheme: () => void;
}) {
  const [legal, setLegal] = useState<{ registrationAvailable?: boolean; passkeysUsable?: boolean }>(
    {}
  );
  const [entryFragment] = useAuthEntry();
  const [mode, setMode] = useState<'login' | 'register' | 'recover' | 'enroll'>('login');
  const [method, setMethod] = useState<'password' | 'passkey'>('password');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState(pairingCode);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState('');
  useEffect(() => {
    let alive = true;
    void (async () => {
      const native = await import('./native');
      const token = native.enrollmentCodeFromFragment(entryFragment, location.origin);
      const browserAuthorization = (
        await import('./native-authorization')
      ).browserAuthorizationLocation();
      const resetCode = entryFragment.startsWith('#password-reset=')
        ? decodeURIComponent(entryFragment.slice('#password-reset='.length))
        : '';
      if (resetCode) history.replaceState({}, '', `${location.pathname}${location.search}`);
      if (entryFragment.startsWith('#pair=')) {
        history.replaceState({}, '', `${location.pathname}${location.search}`);
        if (!token)
          throw new Error(
            'This device link is invalid, expired, or belongs to another server. Create a new device link from Settings → Access on your signed-in device.'
          );
      }
      const value = await get<typeof legal>('/v1/legal');
      if (!alive) return;
      setLegal(value);
      if (resetCode) {
        setMethod('password');
        setPassword('');
        setError(null);
        setCode(resetCode);
        setMode('recover');
      } else if (
        browserAuthorization?.onboarding &&
        browserAuthorization.onboarding.mode !== 'passkey'
      ) {
        setMode(browserAuthorization.onboarding.mode);
        setCode(browserAuthorization.onboarding.code);
        setName(browserAuthorization.onboarding.name ?? '');
      } else if (token) {
        setCode(token);
        setMode('enroll');
        history.replaceState({}, '', `${location.pathname}${location.search}`);
      } else if (value.registrationAvailable) setMode('register');
      else if (pairingCode) setMode('enroll');
    })().catch((cause: unknown) => {
      if (alive) setError(cause);
    });
    return () => {
      alive = false;
    };
  }, [pairingCode, entryFragment]);
  async function run(development = false) {
    setBusy(true);
    setError(null);
    try {
      const result: AuthResult = development
        ? await devSignIn()
        : method === 'password' && mode !== 'enroll'
          ? mode === 'register'
            ? await passwordRegister(name || 'Owner', code, password)
            : mode === 'recover'
              ? await passwordRecover(code, password)
              : await passwordSignIn(password)
          : mode === 'register'
            ? await register({ displayName: name || 'Owner', pairingCode: code })
            : mode === 'recover'
              ? await recover(code)
              : mode === 'enroll'
                ? await enroll(code, name || undefined)
                : await signIn();
      setPassword('');
      if (result.recoveryCode) setRecovery(result.recoveryCode);
      else onAuthenticated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="welcome">
      <Light />
      <header className="welcome-top">
        <Wordmark className="brand" />
        <button
          type="button"
          className="icon-btn"
          aria-label={`Switch to ${theme === 'dark' ? 'day' : 'night'}`}
          onClick={toggleTheme}
        >
          <Theme />
        </button>
      </header>
      <section className="welcome-card rise">
        <p className="eyebrow">Your own computer, anywhere</p>
        {recovery ? (
          <div className="recovery-record">
            <h1 className="display">Save your recovery code.</h1>
            <p>
              This is how you regain access if you forget your password or lose your passkeys. It is
              shown once.
            </p>
            <code>{recovery}</code>
            <Button onClick={() => navigator.clipboard.writeText(recovery).catch(setError)}>
              Copy recovery code
            </Button>
            <Button
              className="primary"
              onClick={() => {
                setRecovery('');
                onAuthenticated();
              }}
            >
              <Check />I have saved it
            </Button>
          </div>
        ) : (
          <form
            className="login-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run();
            }}
          >
            <h1 className="display">
              {mode === 'register'
                ? 'Make this space yours.'
                : mode === 'recover'
                  ? 'Recover access.'
                  : mode === 'enroll'
                    ? 'Connect this device.'
                    : 'Welcome back.'}
            </h1>
            {(mode === 'register' || mode === 'enroll') && (
              <Field label="Your name">
                <input
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
            )}
            {mode !== 'login' && (
              <Field
                label={
                  mode === 'recover'
                    ? 'Recovery or setup code'
                    : mode === 'enroll'
                      ? 'Device enrollment token'
                      : 'Installer pairing code'
                }
              >
                <input
                  type="password"
                  autoComplete="off"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  required
                />
              </Field>
            )}
            {method === 'password' && mode !== 'enroll' && (
              <Field label={mode === 'login' ? 'Password' : 'New password'}>
                <input
                  type="password"
                  name="password"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  maxLength={1024}
                />
              </Field>
            )}
            {method === 'password' && mode !== 'login' && mode !== 'enroll' && (
              <p className="muted">Use at least 15 characters. A few words work well.</p>
            )}
            {mode === 'login' && method === 'password' && (
              <p className="muted">
                This device stays signed in until you sign out or revoke it in Settings.
              </p>
            )}
            {mode === 'recover' && method === 'password' && (
              <p className="muted">
                Use your saved recovery code, or run <code>sudo garden password-reset</code> on your
                server for a one-time setup link. Recovery signs out other devices and revokes
                existing passkeys, API tokens and device invitations.
              </p>
            )}
            {mode === 'enroll' && (
              <p className="muted">
                Have a Garden password? Choose Sign in to connect this device directly. An
                invitation adds a passkey.
              </p>
            )}
            <Button
              type="submit"
              className="primary"
              busy={busy}
              disabled={
                (method === 'passkey' || mode === 'enroll') && legal.passkeysUsable === false
              }
            >
              {method === 'password' && mode !== 'enroll'
                ? mode === 'register'
                  ? 'Create your account'
                  : mode === 'recover'
                    ? 'Set password and sign in'
                    : 'Sign in'
                : mode === 'register'
                  ? 'Create your passkey'
                  : mode === 'recover'
                    ? 'Create a replacement passkey'
                    : mode === 'enroll'
                      ? 'Add this device'
                      : 'Continue with your passkey'}
            </Button>
            {(method === 'passkey' || mode === 'enroll') && legal.passkeysUsable === false && (
              <p className="error">
                Open this computer through its configured HTTPS hostname to use passkeys.
              </p>
            )}
            <nav className="welcome-links" aria-label="Other ways in">
              {mode !== 'enroll' && (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    setMethod(method === 'password' ? 'passkey' : 'password');
                    setPassword('');
                    setError(null);
                  }}
                >
                  {method === 'password' ? 'Use a passkey instead' : 'Use a password instead'}
                </button>
              )}
              {mode !== 'login' && (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    setMode('login');
                    setMethod('password');
                    setError(null);
                    setCode('');
                  }}
                >
                  Sign in
                </button>
              )}
              {mode !== 'recover' && (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    setMode('recover');
                    setError(null);
                    setCode('');
                  }}
                >
                  Recover access
                </button>
              )}
              {mode !== 'enroll' && (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    setMode('enroll');
                    setCode('');
                  }}
                >
                  Enroll a device
                </button>
              )}
            </nav>
            {import.meta.env.DEV && (
              <Button onClick={() => run(true)} busy={busy}>
                Development sign-in
              </Button>
            )}
          </form>
        )}
        <ErrorNotice error={error} />
      </section>
      <footer className="welcome-foot">Self-hosted · AGPL · Your credentials, used directly</footer>
    </main>
  );
}
