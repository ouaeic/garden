import { useEffect, useMemo, useRef, useState } from 'react';
import { readAnalysisRecord } from './analysis-record';
import AnalysisRunExplorer from './AnalysisRunExplorer';
import { message } from './format';
import { readWorkspaceFile, saveWorkspaceFile } from './workspace-file';
import type { WorkspaceTextFile } from './workspace-file';
import '../computer.css';

export default function SourceInspector({
  workspaceId,
  path,
  line = 1,
  expectedHash,
  onDirtyChange,
  onSavingChange,
  onSaved
}: {
  workspaceId: string;
  path: string;
  line?: number;
  expectedHash?: string | null | undefined;
  onDirtyChange?: (dirty: boolean) => void;
  onSavingChange?: (saving: boolean) => void;
  onSaved?: () => Promise<void>;
}) {
  const [file, setFile] = useState<WorkspaceTextFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [source, setSource] = useState(false);
  const [showingProducer, setShowingProducer] = useState(false);
  const record = useMemo(
    () =>
      file && !file.truncated && !file.binary && /\.json$/i.test(path)
        ? readAnalysisRecord(file.original)
        : null,
    [file?.original, file?.truncated, file?.binary, path]
  );
  const controller = useRef<AbortController | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const dirty = file !== null && file.text !== file.original;
  const dirtyListener = useRef(onDirtyChange);
  dirtyListener.current = onDirtyChange;
  useEffect(() => dirtyListener.current?.(dirty), [dirty]);
  useEffect(() => {
    const lifetime = new AbortController();
    controller.current = lifetime;
    setFile(null);
    setError('');
    setNotice('');
    setSource(line > 1);
    setShowingProducer(false);
    setBusy(true);
    void readWorkspaceFile(workspaceId, path, {
      start: Math.max(1, line - 12),
      windowed: true,
      signal: lifetime.signal
    })
      .then((value) => {
        if (!lifetime.signal.aborted) setFile(value);
      })
      .catch((cause) => {
        if (!lifetime.signal.aborted) setError(message(cause));
      })
      .finally(() => {
        if (!lifetime.signal.aborted) setBusy(false);
      });
    return () => {
      lifetime.abort();
      dirtyListener.current?.(false);
    };
  }, [workspaceId, path, line]);
  useEffect(() => {
    if (!file || !editor.current || line < file.start) return;
    const lines = file.original.split('\n');
    const index = line - file.start;
    if (index >= lines.length) return;
    const start = lines.slice(0, index).reduce((length, value) => length + value.length + 1, 0);
    editor.current.focus();
    editor.current.setSelectionRange(start, start + lines[index]!.length);
  }, [file?.original, file?.start, line, source]);

  async function operate(action: 'save' | 'reload' | 'next' | 'beginning') {
    if (!file || busy) return;
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    setBusy(true);
    setError('');
    setNotice('');
    if (action === 'save') onSavingChange?.(true);
    try {
      if (action === 'save') await saveWorkspaceFile(workspaceId, file);
      const next = await readWorkspaceFile(workspaceId, path, {
        start:
          action === 'next' ? (file.next ?? file.start) : action === 'beginning' ? 1 : file.start,
        windowed: true,
        signal
      });
      if (signal.aborted) return;
      setFile(next);
      if (action === 'save') {
        await onSaved?.();
        if (!signal.aborted) setNotice('Saved.');
      }
    } catch (cause) {
      if (!signal.aborted) setError(message(cause));
    } finally {
      if (action === 'save') onSavingChange?.(false);
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <section
      className="computer-editor garden-source-inspector stack"
      aria-label={`Source ${path}`}
    >
      <div className="row between">
        <strong className="computer-path">{path}</strong>
        <a
          href={`/v1/workspaces/${workspaceId}/download?path=${encodeURIComponent(path)}`}
          download={path.split('/').at(-1)}
        >
          Download file
        </a>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {busy && (
        <p className="muted" role="status">
          Working…
        </p>
      )}
      {file && (
        <>
          {expectedHash && file.sha && file.sha !== expectedHash && (
            <p role="status">
              This file has changed since the recorded source. The contents below are current.
            </p>
          )}
          {file.truncated && (
            <p className="muted">
              Reading lines {file.start}–{file.end ?? '…'}. A partial file cannot replace the whole
              file.
            </p>
          )}
          {record && (
            <div className="row" role="group" aria-label="Run display">
              <button
                className="button"
                aria-pressed={!source}
                disabled={dirty}
                onClick={() => setSource(false)}
              >
                Run overview
              </button>
              <button className="button" aria-pressed={source} onClick={() => setSource(true)}>
                {showingProducer ? 'Original source JSON' : 'Source JSON'}
              </button>
            </div>
          )}
          {record && !source ? (
            <AnalysisRunExplorer
              key={`${workspaceId}:${path}:${file.sha}`}
              record={record}
              location={{ workspaceId, manifestPath: path }}
              onInspectingChange={setShowingProducer}
            />
          ) : file.binary ? (
            <p>Binary file. Download it to open it in its application.</p>
          ) : (
            <textarea
              ref={editor}
              className="computer-source field"
              aria-label={`Contents of ${path}`}
              rows={Math.min(18, Math.max(5, file.text.split('\n').length))}
              spellCheck={false}
              readOnly={busy || file.truncated || !file.sha}
              value={file.text}
              onChange={(event) => setFile({ ...file, text: event.target.value })}
            />
          )}
          <div className="row">
            {(!record || source) && (
              <button
                className="button primary"
                disabled={busy || !dirty || file.truncated || file.binary || !file.sha}
                onClick={() => void operate('save')}
              >
                Save changes
              </button>
            )}
            {dirty && (
              <button
                className="button"
                disabled={busy}
                onClick={() => setFile({ ...file, text: file.original })}
              >
                Discard edits
              </button>
            )}
            <button
              className="button"
              disabled={busy || dirty}
              onClick={() => void operate('reload')}
            >
              Reload file
            </button>
            {file.start > 1 && (
              <button
                className="button"
                disabled={busy || dirty}
                onClick={() => void operate('beginning')}
              >
                Read from beginning
              </button>
            )}
            {file.next && (
              <button
                className="button"
                disabled={busy || dirty}
                onClick={() => void operate('next')}
              >
                Read next lines
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
