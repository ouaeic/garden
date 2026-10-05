import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, RefreshCw } from './icons';
import Wordmark from './app/Wordmark';
import { nativeBootstrap, nativeStatus, pairNative, previewConnectionTicket } from './native.js';
import type { NativeBootstrap, NativeStatus, NetworkPreference } from './native.js';
import { Button, ErrorNotice, Field } from './ui.js';
import ServerInstall from './ServerInstall.js';
import './native.css';

export default function NativeSetup({
  initialStatus,
  onConnected
}: {
  initialStatus?: NativeStatus | null;
  onConnected: (bootstrap: NativeBootstrap) => void;
}) {
  const [status, setStatus] = useState(initialStatus ?? null);
  const [bootstrap, setBootstrap] = useState<NativeBootstrap | null>(null);
  const [ticket, setTicket] = useState('');
  const [preference, setPreference] = useState<NetworkPreference>(
    initialStatus?.networkPreference ?? 'unknown'
  );
  const [error, setError] = useState<unknown>(initialStatus?.error ?? null);
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => {
    if (!ticket.trim()) return null;
    try {
      return previewConnectionTicket(ticket);
    } catch {
      return null;
    }
  }, [ticket]);
  useEffect(() => {
    const controller = new AbortController();
    void nativeBootstrap(controller.signal)
      .then(setBootstrap)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause);
      });
    return () => controller.abort();
  }, []);
  const reconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const current = await nativeStatus();
      setStatus(current);
      if (current?.connected) onConnected(await nativeBootstrap());
      else
        setError(
          current?.error || 'Your server is not reachable yet. Check its connection and try again.'
        );
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };
  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const connected = await pairNative(ticket, preference);
      setTicket('');
      onConnected(connected);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="native-setup">
      <header>
        <Wordmark className="brand" />
        <span className="muted">Your computer, anywhere</span>
      </header>
      <div className="native-setup-columns">
        <section className="native-connect">
          <p className="eyebrow">WELCOME HOME</p>
          <h1>{status?.configured ? 'Let’s reconnect.' : 'A place for your next idea.'}</h1>
          <p>
            {status?.configured
              ? 'Your saved server is currently out of reach. Reconnect when it is ready, or enter a new connection ticket.'
              : 'Connect to the garden server you control. Your work continues there, even when you close this app.'}
          </p>
          {status?.configured && (
            <div className="native-saved">
              {status.endpoints.map((endpoint) => (
                <p key={endpoint}>{endpoint}</p>
              ))}
              <Button onClick={() => void reconnect()} busy={busy}>
                <RefreshCw size={15} />
                Reconnect
              </Button>
            </div>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void connect();
            }}
          >
            <Field
              label="Connection ticket"
              hint="Copy the garden://pair/ link from your server or an already connected device."
            >
              <textarea
                value={ticket}
                onChange={(event) => setTicket(event.target.value)}
                placeholder="garden://pair/…"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
                rows={3}
                required
              />
            </Field>
            {preview && (
              <div className="native-ticket-preview">
                <strong>{preview.endpoints[0]}</strong>
                <span className="muted">Server identity</span>
                <code>{preview.identity}</code>
              </div>
            )}
            <Field
              label="Server connection"
              hint="This helps the app find your server after its address changes."
            >
              <select
                value={preference}
                onChange={(event) => setPreference(event.target.value as NetworkPreference)}
              >
                <option value="unknown">Choose automatically</option>
                <option value="dynamic">Home or changing address</option>
                <option value="fixed">Fixed server address</option>
              </select>
            </Field>
            <ErrorNotice error={error} />
            <Button type="submit" className="primary" busy={busy} disabled={!ticket.trim()}>
              Connect my server <ArrowUpRight size={17} />
            </Button>
          </form>
        </section>
        <ServerInstall installerUrl={bootstrap?.installerUrl ?? null} />
      </div>
    </main>
  );
}
