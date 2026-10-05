import { useEffect, useState } from 'react';
import { get, post } from './client';
import { stepUp } from './auth';
import { ApiError } from './client';
import { Button, ErrorNotice, Spinner } from './ui';

interface Permission {
  id: string;
  description: string;
  createdAt: string;
}
export default function TaskPermissions({ taskId }: { taskId: string }) {
  const [permissions, setPermissions] = useState<Permission[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setPermissions(null);
    setError(null);
    setCursor(null);
    setMore(false);
    get<Permission[]>(`/v1/approvals/tasks/${taskId}/permissions`)
      .then((value) => {
        if (active) {
          setPermissions(value);
          setCursor(value.at(-1)?.id ?? null);
          setMore(value.length === 200);
        }
      })
      .catch((err) => {
        if (active) setError(err);
      });
    return () => {
      active = false;
    };
  }, [taskId, refresh]);
  async function loadMore() {
    if (!cursor) return;
    setBusy('page');
    setError(null);
    try {
      const page = await get<Permission[]>(
        `/v1/approvals/tasks/${taskId}/permissions?before=${encodeURIComponent(cursor)}`
      );
      setPermissions((current) => [...(current ?? []), ...page]);
      setCursor(page.at(-1)?.id ?? null);
      setMore(page.length === 200);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }
  async function revoke(id: string) {
    setBusy(id);
    setError(null);
    try {
      const send = () => post(`/v1/approvals/tasks/${taskId}/permissions/${id}/revoke`, {});
      try {
        await send();
      } catch (err) {
        if (
          !(err instanceof ApiError) ||
          !['step_up_required', 'recent_authentication_required'].includes(err.code)
        )
          throw err;
        await stepUp();
        await send();
      }
      setPermissions((current) => current?.filter((item) => item.id !== id) ?? []);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="stack task-permissions" aria-label="Conversation permissions">
      <h3>Conversation permissions</h3>
      <p className="muted">
        What you allowed in this conversation. Revoke stops reuse; actions already approved or
        running can finish.
      </p>
      {permissions === null && !error && <Spinner label="Loading permissions…" />}
      {permissions?.length === 0 && (
        <p className="muted">Nothing allowed in this conversation yet.</p>
      )}
      {permissions?.map((permission) => (
        <div className="task-permission" key={permission.id}>
          <p>{permission.description}</p>
          <Button
            busy={busy === permission.id}
            disabled={busy !== null}
            onClick={() => revoke(permission.id)}
          >
            Revoke
          </Button>
        </div>
      ))}
      {more && (
        <Button busy={busy === 'page'} disabled={busy !== null} onClick={loadMore}>
          More permissions
        </Button>
      )}
      <ErrorNotice error={error} onRetry={() => setRefresh((value) => value + 1)} />
    </section>
  );
}
