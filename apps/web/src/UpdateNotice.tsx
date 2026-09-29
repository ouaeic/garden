import { useEffect, useState } from 'react';
import { get, isNativeClient } from './client.js';
import type { NativeStatus } from './native.js';
import { Button } from './ui.js';
import { fileNavigationBlocked } from './file-navigation.js';

export interface UpdateReport {
  checkedAt: string;
  server: { status: 'current' | 'available' | 'unknown'; revision: string | null };
  client: { version: string; revision: string | null; url: string } | null;
}

export const newerVersion = (candidate: string, installed: string): boolean => {
  if (!/^\d+\.\d+\.\d+$/.test(candidate) || !/^\d+\.\d+\.\d+$/.test(installed)) return false;
  const left = candidate.split('.').map(Number);
  const right = installed.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  }
  return false;
};

const refreshApp = async () => {
  if (fileNavigationBlocked()) return;
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration?.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  } catch {
    // A failed worker lookup must not prevent an explicit refresh.
  }
  location.reload();
};

export default function UpdateNotice({ onSettings }: { onSettings: () => void }) {
  const [report, setReport] = useState<UpdateReport | null>(null);
  const [client, setClient] = useState<NativeStatus | null>(null);
  const [webChanged, setWebChanged] = useState(false);
  const [dismissed, setDismissed] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let lastCheck = 0;
    const check = async () => {
      if (document.visibilityState === 'hidden' || !navigator.onLine) return;
      if (Date.now() - lastCheck < 60_000) return;
      lastCheck = Date.now();
      const options = { signal: controller.signal };
      await Promise.allSettled([
        get<UpdateReport>('/v1/instance/updates', options).then((value) => {
          if (!controller.signal.aborted) setReport(value);
        }),
        isNativeClient()
          ? get<NativeStatus>('/__garden/client/status', options).then((value) => {
              if (!controller.signal.aborted) setClient(value);
            })
          : Promise.resolve(),
        import.meta.env.PROD
          ? fetch('/build.json', { ...options, cache: 'no-store' }).then(async (response) => {
              if (!response.ok) return;
              const value = (await response.json()) as { id?: unknown };
              if (
                !controller.signal.aborted &&
                typeof value.id === 'string' &&
                /^[a-f0-9]{64}$/.test(value.id)
              )
                setWebChanged(value.id !== __GARDEN_WEB_BUILD_ID__);
            })
          : Promise.resolve()
      ]);
    };
    void check();
    const timer = window.setInterval(() => void check(), 5 * 60_000);
    const visible = () => void check();
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', visible);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('online', visible);
    };
  }, []);
  const release = report?.client;
  const clientChanged = release && client && newerVersion(release.version, client.appVersion);
  const kind = webChanged
    ? 'web'
    : clientChanged
      ? `client:${release.version}`
      : report?.server.status === 'available'
        ? `server:${report.server.revision}`
        : '';
  if (!kind || dismissed === kind) return null;
  return (
    <div className="update-notice" role="status">
      <span>
        {webChanged
          ? 'A fresh version of garden is ready.'
          : clientChanged
            ? `garden ${release.version} is available for this app.`
            : 'Your garden server can be updated.'}
      </span>
      {webChanged ? (
        <Button onClick={() => void refreshApp()}>Refresh</Button>
      ) : clientChanged ? (
        <a className="button" href={release.url} target="_blank" rel="noreferrer">
          Download update
        </a>
      ) : (
        <Button onClick={onSettings}>View update</Button>
      )}
      <Button aria-label="Dismiss update notice" onClick={() => setDismissed(kind)}>
        Later
      </Button>
    </div>
  );
}
