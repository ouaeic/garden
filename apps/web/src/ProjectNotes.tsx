import ScrollRegion from './ScrollRegion';
import { useEffect, useState } from 'react';
import type { ConversationSource, ProjectNote } from '@garden/contracts';
import { get, post, request } from './client';
import { Button, Dialog, ErrorNotice, Field, Spinner } from './ui';

export function ProjectNoteEditor({
  projectId,
  source,
  note,
  onSaved,
  onClose
}: {
  projectId: string;
  source?: ConversationSource;
  note?: ProjectNote;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [body, setBody] = useState(note?.body ?? ''),
    [kind, setKind] = useState<ProjectNote['kind']>(note?.kind ?? 'finding'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  async function save() {
    if (busy || !body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await post(`/v1/projects/${projectId}/notes`, {
        body,
        kind,
        ...((source ?? note?.source) ? { source: source ?? note?.source } : {}),
        ...(note ? { replacesId: note.id } : {})
      });
      onSaved();
      onClose();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={note ? 'Correct project note' : 'Keep a project note'} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field label="Type">
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as ProjectNote['kind'])}
          >
            <option value="finding">Finding</option>
            <option value="decision">Decision</option>
            <option value="question">Open question</option>
          </select>
        </Field>
        <Field label="Note">
          <textarea
            rows={7}
            maxLength={8000}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Keep the useful finding, decision or correction…"
          />
        </Field>
        <p className="muted">
          {source || note?.source ? 'The source conversation stays linked. ' : ''}
          {note ? 'The previous wording remains in history. ' : ''}Conversations can use this as
          context.
        </p>
        <ErrorNotice error={error} />
        <Button type="submit" className="primary" busy={busy} disabled={!body.trim()}>
          Save note
        </Button>
      </form>
    </Dialog>
  );
}

export default function ProjectNotes({
  projectId,
  revision,
  onTask
}: {
  projectId: string;
  revision: string;
  onTask: (id: string) => void;
}) {
  const [notes, setNotes] = useState<ProjectNote[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [history, setHistory] = useState(false),
    [refresh, setRefresh] = useState(0),
    [editor, setEditor] = useState<ProjectNote | 'new' | null>(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void get<{ notes: ProjectNote[]; nextCursor: string | null }>(
      `/v1/projects/${projectId}/notes?history=${history}`,
      { signal: controller.signal }
    )
      .then((page) => {
        if (!controller.signal.aborted) {
          setNotes(page.notes);
          setCursor(page.nextCursor);
          setError(null);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, history, refresh, revision]);
  async function more() {
    if (!cursor || busy) return;
    setBusy(true);
    try {
      const page = await get<{ notes: ProjectNote[]; nextCursor: string | null }>(
        `/v1/projects/${projectId}/notes?history=${history}&before=${cursor}`
      );
      setNotes((rows) => [...rows, ...page.notes]);
      setCursor(page.nextCursor);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  async function remove(note: ProjectNote) {
    if (busy) return;
    setBusy(true);
    try {
      await request(`/v1/projects/${projectId}/notes/${note.id}`, { method: 'DELETE' });
      setRefresh((n) => n + 1);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="project-notes" aria-label="Project notes">
      <div className="project-section-heading">
        <h2>Project notes</h2>
        <div className="row">
          <label>
            <input
              type="checkbox"
              checked={history}
              onChange={(event) => setHistory(event.target.checked)}
            />{' '}
            History
          </label>
          <Button onClick={() => setEditor('new')}>Add note</Button>
        </div>
      </div>
      <p className="muted">Findings, decisions and open questions shared across conversations.</p>
      {loading && <Spinner />}
      <ScrollRegion label="Project note entries" resetKey={projectId}>
        {notes.map((note) => (
          <article
            key={note.id}
            className={`project-note${note.supersededBy ? ' superseded' : ''}`}
          >
            <div className="row between">
              <small>
                {note.kind}
                {note.supersededBy ? ' · corrected' : ''} ·{' '}
                {new Date(note.createdAt).toLocaleDateString()}
              </small>
              {note.source && (
                <Button onClick={() => onTask(note.source!.taskId)}>Source conversation</Button>
              )}
            </div>
            <p>{note.body}</p>
            <div className="row">
              {!note.supersededBy && <Button onClick={() => setEditor(note)}>Correct</Button>}
              <Button busy={busy} onClick={() => void remove(note)}>
                Remove
              </Button>
            </div>
          </article>
        ))}
      </ScrollRegion>
      {!loading && !notes.length && (
        <p className="muted">Keep a note here when a finding should inform other conversations.</p>
      )}
      {cursor && (
        <Button busy={busy} onClick={() => void more()}>
          More notes
        </Button>
      )}
      <ErrorNotice error={error} />
      {editor && (
        <ProjectNoteEditor
          projectId={projectId}
          {...(editor !== 'new' ? { note: editor } : {})}
          onSaved={() => setRefresh((n) => n + 1)}
          onClose={() => setEditor(null)}
        />
      )}
    </section>
  );
}
