import { useEffect, useState } from 'react';
import { GitBranch } from './icons';
import type { Task, TaskEvent, TaskRewindPreview, RewindScope } from '@garden/contracts';
import { get, post } from './client';
import { data, eventText } from './model';
import MessageAttachmentList from './MessageAttachmentList';
import { Button, ErrorNotice, Field } from './ui';

export default function Trajectory({
  task,
  event,
  onCreated
}: {
  task: Task;
  event: TaskEvent;
  onCreated: (task: Task) => void;
}) {
  const [preview, setPreview] = useState<TaskRewindPreview | null>(null);
  const [operation, setOperation] = useState<'branch' | 'edit' | 'retry'>('branch');
  const [rewind, setRewind] = useState<RewindScope>('conversation');
  const [prompt, setPrompt] = useState(eventText(event));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    void get<TaskRewindPreview>(`/v1/tasks/${task.id}/rewind-preview?eventId=${event.id}`)
      .then(setPreview)
      .catch(setError);
  }, [task.id, event.id]);
  async function create() {
    setBusy(true);
    setError(null);
    try {
      const result = await post<Task>(`/v1/tasks/${task.id}/trajectory`, {
        operation,
        eventId: event.id,
        rewind,
        ...(rewind !== 'conversation' && preview?.checkpoint
          ? { checkpointId: preview.checkpoint.id }
          : {}),
        ...(operation === 'edit' ? { prompt } : {}),
        ...(operation !== 'branch' ? { stopSource: true } : {})
      });
      onCreated(result);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <p>{event.summary}</p>
      <MessageAttachmentList
        workspaceId={task.workspaceId}
        paths={data(event.payload).attachments}
      />
      <Field label="Continue with">
        <select
          value={operation}
          onChange={(e) => setOperation(e.target.value as typeof operation)}
        >
          <option value="branch">Branch into separate work</option>
          {event.kind === 'user_message' && (
            <option value="edit">Edit this direction and retry</option>
          )}
          <option value="retry">Retry from this point</option>
        </select>
      </Field>
      {operation === 'edit' && (
        <Field label="Revised direction">
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} />
        </Field>
      )}
      <Field label="Restore">
        <select value={rewind} onChange={(e) => setRewind(e.target.value as RewindScope)}>
          <option value="conversation">Conversation only · leave files as they are</option>
          <option value="computer" disabled={!preview?.checkpoint}>
            Computer only
          </option>
          <option value="both" disabled={!preview?.checkpoint}>
            Conversation and computer
          </option>
        </select>
      </Field>
      {preview && (
        <p>
          {preview.droppedEventCount} later events stay in the source work.{' '}
          {operation !== 'branch' && 'The source run will stop when this retry begins.'}
        </p>
      )}
      {rewind !== 'conversation' && preview?.computer && (
        <details open>
          <summary>Changes to your computer</summary>
          <pre>{JSON.stringify(preview.computer, null, 2)}</pre>
        </details>
      )}
      <ErrorNotice error={error} />
      <Button
        className="primary"
        disabled={!preview || (operation === 'edit' && !prompt.trim())}
        busy={busy}
        onClick={create}
      >
        Create {operation === 'branch' ? 'branch' : 'retry'}
        <GitBranch size={16} />
      </Button>
    </div>
  );
}
