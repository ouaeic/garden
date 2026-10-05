import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { applyTheme, isDark, toggleTheme } from './appearance';
import { isNativeClient } from './client';
import type { NativeStatus } from './native';
import { createTaskNotifier } from './native-notices';
import { subscribeWorkerNavigation } from './worker-navigation';
import { useAuthEntry } from './auth-entry';
import { openGoal } from './app/route';
import { refresh, signedIn, startGarden, useGarden } from './app/store';
import Shell from './app/Shell';
import Light from './app/Light';
import './styles/foundation.css';
import './styles/kept.css';
import './app/shell.css';

const Login = lazy(() => import('./Login'));
const NativeSetup = lazy(() => import('./NativeSetup'));
const NativeAuthorizationPortal = lazy(() => import('./NativeAuthorization'));

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    return this.state.error ? (
      <Gate title="This view needs to reopen.">
        <p>Your work carries on on your computer.</p>
        <p className="error-line">{this.state.error.message}</p>
        <button type="button" className="btn primary" onClick={() => location.reload()}>
          Reopen garden
        </button>
      </Gate>
    ) : (
      this.props.children
    );
  }
}

/** A full-screen moment before the desk: opening, signing in, or a fault worth saying plainly. */
function Gate({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="gate">
      <Light />
      <div className="gate-card">
        <div className="brand">garden</div>
        <h1 className="display">{title}</h1>
        {children}
      </div>
    </main>
  );
}

export default function App() {
  return (
    <Boundary>
      <Garden />
      <Suspense fallback={null}>
        <NativeAuthorizationPortal />
      </Suspense>
    </Boundary>
  );
}

function Garden() {
  const { bootstrap, signedOut, error } = useGarden();
  const [native, setNative] = useState<NativeStatus | null>(null);
  const [pairingCode, setPairingCode] = useState('');
  const [entry, setEntry] = useAuthEntry();
  const [notifier] = useState(createTaskNotifier);

  useEffect(() => {
    applyTheme();
    void (async () => {
      if (isNativeClient()) {
        const client = await import('./native');
        const status = await client.nativeStatus();
        setNative(status);
        if (status && !status.connected) return;
        setPairingCode((await client.nativeBootstrap()).pairingCode ?? '');
      }
      startGarden();
    })();
  }, []);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    return subscribeWorkerNavigation(
      navigator.serviceWorker,
      location.origin,
      (taskId) => taskId && openGoal(taskId),
      () => void refresh()
    );
  }, []);

  useEffect(() => {
    if (bootstrap && isNativeClient()) void notifier.update(bootstrap.tasks);
  }, [bootstrap, notifier]);

  if (native && !native.connected)
    return (
      <Suspense fallback={<Gate title="Opening connection setup…" />}>
        <NativeSetup
          initialStatus={native}
          onConnected={(details) => {
            setPairingCode(details.pairingCode ?? '');
            setNative({ ...native, connected: true });
            startGarden();
          }}
        />
      </Suspense>
    );
  if (signedOut || entry.startsWith('#password-reset='))
    return (
      <Suspense fallback={<Gate title="Opening sign-in…" />}>
        <Login
          pairingCode={pairingCode}
          theme={isDark() ? 'dark' : 'light'}
          toggleTheme={toggleTheme}
          onAuthenticated={() => {
            setEntry('');
            setPairingCode('');
            signedIn();
            void refresh();
          }}
        />
      </Suspense>
    );
  if (!bootstrap)
    return error ? (
      <Gate title="Your computer did not answer.">
        <p className="muted">
          {error instanceof Error ? error.message : 'The connection to garden was interrupted.'}
        </p>
        <button
          type="button"
          className="btn primary"
          onClick={() => (isNativeClient() ? location.reload() : void refresh())}
        >
          Try again
        </button>
      </Gate>
    ) : (
      <Gate title="Opening your garden…" />
    );
  return <Shell />;
}
