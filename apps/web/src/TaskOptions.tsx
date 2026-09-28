import { useState } from 'react';
import type { Task } from '@garden/contracts';
import { patch } from './client';
import { money } from './model';
import { Button, ErrorNotice, Field } from './ui';
import TaskPermissions from './TaskPermissions';

export default function TaskOptions({
  task,
  onTask,
  onRefresh
}: {
  task: Task;
  onTask: (task: Task) => void;
  onRefresh: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function change(body: Record<string, unknown>, suffix = '') {
    setBusy(true);
    setError(null);
    try {
      onTask(await patch<Task>(`/v1/tasks/${task.id}${suffix}`, body));
      onRefresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          void change({ title });
        }}
      >
        <Field label="Work title">
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Button type="submit" busy={busy}>
          Rename
        </Button>
      </form>
      <dl className="facts">
        <div>
          <dt>Model</dt>
          <dd>{task.modelId}</dd>
        </div>
        <div>
          <dt>Privacy</dt>
          <dd>
            {task.privacyRoute === 'provider_zdr' ? 'Zero data retention' : 'External provider'}
          </dd>
        </div>
        <div>
          <dt>Spend</dt>
          <dd>{money(task.spentUsd)}</dd>
        </div>
      </dl>
      <div className="row">
        <Button disabled={busy} onClick={() => change({ pinned: !task.pinned })}>
          {task.pinned ? 'Unpin' : 'Pin this work'}
        </Button>
        <Button disabled={busy} onClick={() => change({ archived: !task.archivedAt })}>
          {task.archivedAt ? 'Restore to work' : 'Archive'}
        </Button>
      </div>
      <ErrorNotice error={error} />
      <TaskPermissions taskId={task.id} />
    </div>
  );
}
