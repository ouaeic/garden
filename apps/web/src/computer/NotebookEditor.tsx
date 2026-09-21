import { useEffect, useId, useRef, useState } from 'react';
import { Button, ErrorNotice, Spinner } from '../ui';
import { useFileNavigationGuard } from '../file-navigation';
import { requireDownloadSupport } from '../download-support';
import { NotebookCell } from './NotebookPreview';
import { notebookObject, notebookText } from './notebook';
import {
  applyNotebookEdit,
  cellEditable,
  moveNotebookHistory,
  notebookHistory,
  type CellKind,
  type NotebookEdit,
  type NotebookFile,
  type NotebookHistory
} from './notebook-edit';
import { loadNotebookFile, saveNotebookFile, serializeNotebook } from './notebook-file';

const PAGE_SIZE = 20;

export default function NotebookEditor({
  workspaceId,
  path,
  name,
  onDirtyChange,
  onClose
}: {
  workspaceId: string;
  path: string;
  name: string;
  onDirtyChange?: (dirty: boolean) => void;
  onClose: () => void;
}) {
  const editorId = useId();
  const focusCell = useRef<number | null>(null);
  const [saved, setSaved] = useState<{ document: NotebookFile; sha: string } | null>(null);
  const [history, setHistory] = useState<NotebookHistory | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [kind, setKind] = useState<CellKind>('code');
  const dirty = !!history && history.document !== saved?.document;
  const listener = useRef(onDirtyChange);
  listener.current = onDirtyChange;
  const alive = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      listener.current?.(false);
    };
  }, []);
  useEffect(() => listener.current?.(dirty || busy), [dirty, busy]);
  useFileNavigationGuard(dirty || busy, () => {
    setNotice(
      busy
        ? 'Wait for this notebook to finish saving before leaving.'
        : 'Save or discard notebook edits before leaving.'
    );
    heading.current?.focus();
  });
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setSaved(null);
    setHistory(null);
    void loadNotebookFile(
      workspaceId,
      path,
      AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])
    )
      .then((file) => {
        if (controller.signal.aborted) return;
        setSaved(file);
        setHistory(notebookHistory(file.document));
        setSelected(null);
        setPage(0);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      });
    return () => controller.abort();
  }, [workspaceId, path, revision]);

  useEffect(() => {
    if (focusCell.current === null) return;
    document.getElementById(`${editorId}-cell-${focusCell.current}`)?.focus();
    focusCell.current = null;
  }, [selected, page, editorId]);
  function change(edit: NotebookEdit) {
    setHistory((current) => (current ? applyNotebookEdit(current, edit) : current));
    setNotice('');
  }
  async function save() {
    if (!history || !saved || busy || !dirty) return;
    const document = history.document;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const sha = await saveNotebookFile(workspaceId, path, saved.sha, document);
      if (!alive.current) return;
      setSaved({ document, sha });
      // A new edit must not coalesce across the persisted version.
      setHistory((current) => (current ? { ...current, coalesce: null } : current));
      setNotice('Notebook saved. Code has not been run.');
    } catch (cause) {
      if (alive.current) setError(cause);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function downloadEdits() {
    if (!history) return;
    try {
      await requireDownloadSupport();
      const url = URL.createObjectURL(
        new Blob([serializeNotebook(history.document)], { type: 'application/x-ipynb+json' })
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(cause);
    }
  }
  const cells = history?.document.cells ?? [];
  const currentPage = Math.min(page, Math.max(0, Math.ceil(cells.length / PAGE_SIZE) - 1));
  function travel(direction: 'undo' | 'redo') {
    setHistory((current) => (current ? moveNotebookHistory(current, direction) : current));
    setSelected(null);
    setNotice('');
  }
  return (
    <section className="notebook-preview notebook-editor" aria-label={`Edit notebook ${name}`}>
      <div className="notebook-toolbar">
        <h3 ref={heading} tabIndex={-1}>
          Edit notebook
        </h3>
        <div className="row">
          <Button className="primary" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save notebook'}
          </Button>
          <Button disabled={dirty || busy} onClick={onClose}>
            Done editing
          </Button>
        </div>
      </div>
      <p className="muted notebook-note">
        Edits keep notebook metadata and attachments. Changing code or its order marks recorded
        outputs as stale. Saving does not execute code.
      </p>
      <ErrorNotice
        error={error}
        {...(!history ? { onRetry: () => setRevision((value) => value + 1) } : {})}
      />
      {notice && <p role="status">{notice}</p>}
      {!history && !error && <Spinner label="Opening editable notebook…" />}
      {history && (
        <>
          <div className="notebook-toolbar" role="group" aria-label="Notebook changes">
            <div className="row">
              <Button disabled={busy || !history.undo.length} onClick={() => travel('undo')}>
                Undo
              </Button>
              <Button disabled={busy || !history.redo.length} onClick={() => travel('redo')}>
                Redo
              </Button>
              <Button
                disabled={
                  busy ||
                  !cells.some((value) => {
                    const cell = notebookObject(value);
                    return (
                      cell?.cell_type === 'code' &&
                      Array.isArray(cell.outputs) &&
                      cell.outputs.length > 0
                    );
                  })
                }
                onClick={() => change({ type: 'clear_outputs' })}
              >
                Clear outputs
              </Button>
            </div>
            <div className="row">
              <Button disabled={busy} onClick={() => void downloadEdits()}>
                Download current copy
              </Button>
              {dirty && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    if (!saved) return;
                    setHistory(notebookHistory(saved.document));
                    setSelected(null);
                    setError(null);
                    setNotice('Edits discarded.');
                  }}
                >
                  Discard edits
                </Button>
              )}
              <Button disabled={busy || dirty} onClick={() => setRevision((value) => value + 1)}>
                Reload file
              </Button>
            </div>
          </div>
          <p className="muted" role="status">
            {cells.length.toLocaleString()} cells · {dirty ? 'Unsaved changes' : 'Saved'}
          </p>
          {cells
            .slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
            .map((value, offset) => {
              const index = currentPage * PAGE_SIZE + offset;
              const cell = notebookObject(value);
              const editable = cellEditable(value);
              return (
                <NotebookCell
                  key={index}
                  value={value}
                  index={index}
                  controls={
                    <div className="row notebook-cell-actions">
                      <Button
                        disabled={busy || !editable}
                        aria-expanded={selected === index}
                        onClick={() => {
                          if (selected !== index) focusCell.current = index;
                          setSelected(selected === index ? null : index);
                        }}
                      >
                        {selected === index ? 'Preview cell' : 'Edit cell'}
                        <span className="sr-only"> {index + 1}</span>
                      </Button>
                      {selected === index && (
                        <>
                          <Button
                            disabled={busy || index === 0}
                            onClick={() => {
                              change({ type: 'move', index, to: index - 1 });
                              focusCell.current = index - 1;
                              setSelected(index - 1);
                              setPage(Math.floor((index - 1) / PAGE_SIZE));
                            }}
                          >
                            Move up<span className="sr-only"> cell {index + 1}</span>
                          </Button>
                          <Button
                            disabled={busy || index + 1 === cells.length}
                            onClick={() => {
                              change({ type: 'move', index, to: index + 1 });
                              focusCell.current = index + 1;
                              setSelected(index + 1);
                              setPage(Math.floor((index + 1) / PAGE_SIZE));
                            }}
                          >
                            Move down<span className="sr-only"> cell {index + 1}</span>
                          </Button>
                          <Button
                            disabled={busy}
                            onClick={() => {
                              change({ type: 'remove', index });
                              setSelected(null);
                            }}
                          >
                            Delete<span className="sr-only"> cell {index + 1}</span>
                          </Button>
                        </>
                      )}
                    </div>
                  }
                  editor={
                    selected === index && editable ? (
                      <div className="stack notebook-cell-editor">
                        <label>
                          Cell {index + 1} type
                          <select
                            className="field"
                            value={String(cell!.cell_type)}
                            disabled={busy}
                            onChange={(event) =>
                              change({ type: 'kind', index, kind: event.target.value as CellKind })
                            }
                          >
                            <option value="code">Code</option>
                            <option value="markdown">Markdown</option>
                            <option value="raw">Raw text</option>
                          </select>
                        </label>
                        <textarea
                          id={`${editorId}-cell-${index}`}
                          className="field notebook-source"
                          aria-label={`Cell ${index + 1} source`}
                          value={notebookText(cell!.source) ?? ''}
                          disabled={busy}
                          spellCheck={false}
                          onKeyDown={(event) => {
                            if (
                              (event.ctrlKey || event.metaKey) &&
                              event.key.toLowerCase() === 's'
                            ) {
                              event.preventDefault();
                              void save();
                            }
                          }}
                          rows={Math.min(
                            22,
                            Math.max(6, (notebookText(cell!.source) ?? '').split('\n').length)
                          )}
                          onChange={(event) =>
                            change({ type: 'source', index, source: event.target.value })
                          }
                          onBlur={() =>
                            setHistory((current) =>
                              current ? { ...current, coalesce: null } : current
                            )
                          }
                        />
                      </div>
                    ) : undefined
                  }
                />
              );
            })}
          <div className="notebook-toolbar">
            <div className="row">
              <label className="notebook-add-kind">
                New cell
                <select
                  className="field"
                  value={kind}
                  disabled={busy}
                  onChange={(event) => setKind(event.target.value as CellKind)}
                >
                  <option value="code">Code</option>
                  <option value="markdown">Markdown</option>
                  <option value="raw">Raw text</option>
                </select>
              </label>
              <Button
                disabled={busy}
                onClick={() => {
                  const index = selected === null ? cells.length : selected + 1;
                  change({ type: 'insert', index, kind, id: crypto.randomUUID() });
                  focusCell.current = index;
                  setSelected(index);
                  setPage(Math.floor(index / PAGE_SIZE));
                }}
              >
                {selected === null ? 'Add cell' : 'Insert after selected cell'}
              </Button>
            </div>
            {cells.length > PAGE_SIZE && (
              <nav className="row" aria-label="Editable notebook pages">
                <Button
                  disabled={currentPage === 0}
                  onClick={() => {
                    setPage(currentPage - 1);
                    setSelected(null);
                    heading.current?.focus();
                  }}
                >
                  Previous cells
                </Button>
                <span>
                  Page {currentPage + 1} of {Math.ceil(cells.length / PAGE_SIZE)}
                </span>
                <Button
                  disabled={(currentPage + 1) * PAGE_SIZE >= cells.length}
                  onClick={() => {
                    setPage(currentPage + 1);
                    setSelected(null);
                    heading.current?.focus();
                  }}
                >
                  Next cells
                </Button>
              </nav>
            )}
          </div>
        </>
      )}
    </section>
  );
}
