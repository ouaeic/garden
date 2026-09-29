import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, Moon, Sun } from './icons';
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
import Brand from './Brand';

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
      const token = native.enrollmentCodeFromFragment(location.hash, location.origin);
      const browserAuthorization = (
        await import('./native-authorization')
      ).browserAuthorizationLocation();
      const resetCode = location.hash.startsWith('#password-reset=')
        ? decodeURIComponent(location.hash.slice('#password-reset='.length))
        : '';
      if (resetCode) history.replaceState({}, '', `${location.pathname}${location.search}`);
      if (location.hash.startsWith('#pair=')) {
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
  }, [pairingCode]);
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
      <div className="welcome-top">
        <Brand />
        <Button
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </Button>
      </div>
      <section className="welcome-content">
        <div className="eyebrow">Your own space to think and make</div>
        <h1>
          Good things
          <br />
          begin here.
        </h1>
        <p>A persistent computer for your ideas, your questions, and the work you want done.</p>
        {recovery ? (
          <div className="recovery-record">
            <h2>Save your recovery code.</h2>
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
              <Check size={16} />I have saved it
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
            <h2>
              {mode === 'register'
                ? 'Make this space yours.'
                : mode === 'recover'
                  ? 'Recover access.'
                  : mode === 'enroll'
                    ? 'Connect this device.'
                    : 'Welcome back.'}
            </h2>
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
              <ArrowUpRight size={18} />
            </Button>
            {(method === 'passkey' || mode === 'enroll') && legal.passkeysUsable === false && (
              <p className="error">
                Open this computer through its configured HTTPS hostname to use passkeys.
              </p>
            )}
            <div className="row login-links">
              {mode !== 'enroll' && (
                <Button
                  onClick={() => {
                    setMethod(method === 'password' ? 'passkey' : 'password');
                    setPassword('');
                    setError(null);
                  }}
                >
                  {method === 'password' ? 'Use a passkey instead' : 'Use a password instead'}
                </Button>
              )}
              {mode !== 'login' && (
                <Button
                  onClick={() => {
                    setMode('login');
                    setMethod('password');
                    setError(null);
                    setCode('');
                  }}
                >
                  Sign in
                </Button>
              )}
              {mode !== 'recover' && (
                <Button
                  onClick={() => {
                    setMode('recover');
                    setError(null);
                    setCode('');
                  }}
                >
                  Recover access
                </Button>
              )}
              {mode !== 'enroll' && (
                <Button
                  onClick={() => {
                    setMode('enroll');
                    setCode('');
                  }}
                >
                  Enroll a device
                </Button>
              )}
            </div>
            {import.meta.env.DEV && (
              <Button onClick={() => run(true)} busy={busy}>
                Development sign-in
              </Button>
            )}
          </form>
        )}
        <ErrorNotice error={error} />
      </section>
      <footer>Self-hosted · AGPL · Your credentials, used directly</footer>
    </main>
  );
}
