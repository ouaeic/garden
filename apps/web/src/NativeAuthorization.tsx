import { observeVisiblePoll } from './visible-poll';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { NativeAuthorization } from '@garden/contracts';
import {
  authorizationSnapshot,
  browserAuthorizationLocation,
  subscribeAuthorization
} from './native-authorization';
import { openAuthorizationBrowser } from './native';
import { get, post, ApiError, isNativeClient } from './client';
import { stepUp, addPasskey } from './auth';
import { Button, Dialog, ErrorNotice } from './ui';

export default function NativeAuthorizationPortal() {
  const waiting = useSyncExternalStore(subscribeAuthorization, authorizationSnapshot, () => null);
  const [browserRequest] = useState(() =>
    isNativeClient() ? null : browserAuthorizationLocation()
  );
  const [request, setRequest] = useState<NativeAuthorization | null>(null);
  const [matches, setMatches] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [complete, setComplete] = useState(false);
  useEffect(() => {
    if (!browserRequest || complete) return;
    return observeVisiblePoll(
      async (signal) => {
        const value = await get<NativeAuthorization>(`/v1/auth/native/${browserRequest.id}`, {
          signal,
          retry: 0
        });
        if (!signal.aborted) setRequest(value);
      },
      5000,
      (cause) => {
        if (!(cause instanceof ApiError && [401, 403].includes(cause.status))) setError(cause);
      }
    );
  }, [browserRequest, complete]);
  async function decide(approve: boolean) {
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      if (approve) {
        await stepUp(true);
        if (browserRequest?.onboarding?.mode === 'passkey') await addPasskey();
      }
      const value = await post<NativeAuthorization>(`/v1/auth/native/${request.id}/decision`, {
        userCode: request.userCode,
        approve
      });
      setRequest(value);
      setComplete(true);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  if (waiting)
    return (
      <Dialog title="Finish in your browser" onClose={waiting.cancel}>
        <p>
          Authorize this garden app at{' '}
          <strong>{new URL(waiting.authorization.serverOrigin).hostname}</strong>. Your passkey
          stays in your browser.
        </p>
        <p
          className="garden-device-code"
          aria-label={`Device code ${waiting.authorization.userCode}`}
        >
          {waiting.authorization.userCode}
        </p>
        <p className="muted">
          Check that the browser shows this same code. This request expires{' '}
          {new Date(waiting.authorization.expiresAt).toLocaleTimeString()}.
        </p>
        <ErrorNotice error={waiting.openingError || error} />
        <div className="row">
          <Button
            onClick={() => void openAuthorizationBrowser(waiting.verificationUri).catch(setError)}
          >
            Open browser
          </Button>
          <Button
            onClick={() =>
              void navigator.clipboard.writeText(waiting.verificationUri).catch(setError)
            }
          >
            Copy browser link
          </Button>
          <Button onClick={waiting.cancel}>Cancel authorization</Button>
        </div>
      </Dialog>
    );
  if (!request) {
    if (!browserRequest || !error || complete) return null;
    return (
      <Dialog
        title="Device authorization unavailable"
        onClose={() => {
          setComplete(true);
          history.replaceState({}, '', location.pathname + location.search);
        }}
      >
        <ErrorNotice error={error} />
        <p>Return to your garden app and start a new authorization.</p>
      </Dialog>
    );
  }
  return (
    <Dialog
      title={complete ? 'Device authorization recorded' : 'Authorize your garden app'}
      onClose={() => {
        setRequest(null);
        setComplete(true);
        history.replaceState({}, '', location.pathname + location.search);
      }}
    >
      <ErrorNotice error={error} />
      {request.status === 'pending' ? (
        <>
          <p>
            <strong>{request.deviceLabel}</strong> is asking to{' '}
            {browserRequest?.onboarding?.mode === 'passkey'
              ? 'add a browser passkey and verify its existing session'
              : request.purpose === 'step_up'
                ? 'verify its existing session for a sensitive action'
                : 'sign in to this garden'}
            .
          </p>
          <p className="garden-device-code">{request.userCode}</p>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={matches}
              onChange={(event) => setMatches(event.target.checked)}
            />{' '}
            This code matches the garden app I opened.
          </label>
          <p className="muted">
            Authorize only a device you are using. Your identity is confirmed before access is
            granted.
          </p>
          <div className="row">
            <Button
              busy={busy}
              disabled={!matches}
              className="primary"
              onClick={() => void decide(true)}
            >
              Confirm and authorize
            </Button>
            <Button busy={busy} onClick={() => void decide(false)}>
              Decline
            </Button>
          </div>
        </>
      ) : (
        <p>
          {request.status === 'approved' || request.status === 'consumed'
            ? 'Your garden app can now continue. Return to it on your device.'
            : request.status === 'expired'
              ? 'This request expired. Start a new authorization from your garden app.'
              : 'The device was not authorized.'}
        </p>
      )}
    </Dialog>
  );
}
