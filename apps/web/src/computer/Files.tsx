import { useCallback, useEffect, useRef, useState } from 'react';
import type { Artifact, Workspace } from '@athanor/contracts';
import { del, get, post, request } from '../client.js';
import { download } from '../management.js';
import { readWorkspaceFile, saveWorkspaceFile } from './workspace-file';
import type { WorkspaceTextFile } from './workspace-file';
import { ResultPreview } from './ResultPreview.js';
import { artifactRequest, bytes, message } from './format.js';

interface Entry {
  name: string;
  path: string;
  type: 'directory' | 'file' | 'symlink';
  sizeBytes: number;
  modifiedAt: string;
}
export function Files({
  workspace,
  taskId = null,
  onChange
}: {
  workspace: Workspace;
  taskId?: string | null;
  onChange: () => void;
}) {
  const base = `/v1/workspaces/${workspace.id}`;
  const [folder, setFolder] = useState('workspace');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [preview, setPreview] = useState<Artifact | null>(null);
  const [file, setFile] = useState<WorkspaceTextFile | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<'folder' | 'file'>('file');
  const [rename, setRename] = useState('');
  const [remove, setRemove] = useState<string | null>(null);
  const [discard, setDiscard] = useState<(() => void) | null>(null);
  const readSequence = useRef(0);
  const listingSequence = useRef(0);
  const load = useCallback(async () => {
    const sequence = ++listingSequence.current;
    const [tree, saved] = await Promise.all([
      get<{ entries: Entry[] }>(`${base}/files?path=${encodeURIComponent(folder)}`),
      get<Artifact[]>(`${base}/artifacts`)
    ]);
    if (sequence !== listingSequence.current) return;
    setEntries(tree.entries);
    setArtifacts(saved);
  }, [base, folder]);
  useEffect(() => {
    let active = true;
    setError('');
    void load().catch((e) => {
      if (active) setError(message(e));
    });
    return () => {
      active = false;
      readSequence.current += 1;
      listingSequence.current += 1;
    };
  }, [load]);
  const run = async (fn: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
      onChange();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const navigate = (fn: () => void) => {
    if (file && file.text !== file.original) setDiscard(() => fn);
    else fn();
  };
  const read = async (path: string, start = 1, complete = false) => {
    const sequence = ++readSequence.current;
    const windowed =
      !complete &&
      (start > 1 || (entries.find((entry) => entry.path === path)?.sizeBytes ?? 262145) > 262144);
    const result = await readWorkspaceFile(workspace.id, path, { start, windowed });
    if (sequence !== readSequence.current) return;
    setFile(result);
    setRename(path.split('/').at(-1) ?? path);
  };
  const save = async () => {
    if (!file) return;
    await saveWorkspaceFile(workspace.id, file);
    await read(file.path);
    await load();
  };
  const publication = file ? artifactRequest(file, taskId) : null;
  return (
    <div className="stack computer-files">
      <div className="row">
        <button
          className="button"
          disabled={folder === 'workspace'}
          onClick={() =>
            navigate(() => {
              setFile(null);
              setFolder(folder.split('/').slice(0, -1).join('/') || 'workspace');
            })
          }
        >
          ↑ Up
        </button>
        <span className="computer-path">{folder}</span>
        <button className="button" disabled={busy} onClick={() => void run(load)}>
          Refresh
        </button>
        <label className="button computer-upload">
          Upload
          <input
            type="file"
            multiple
            disabled={busy}
            onChange={(e) => {
              const uploads = Array.from(e.currentTarget.files ?? []);
              e.currentTarget.value = '';
              void run(async () => {
                for (const upload of uploads) {
                  if (entries.some((entry) => entry.name === upload.name))
                    throw new Error(
                      `${upload.name} already exists. Rename it before uploading another file with that name.`
                    );
                  await request(
                    `${base}/file?path=${encodeURIComponent(`${folder}/${upload.name}`)}&createOnly=true`,
                    {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/octet-stream' },
                      body: upload
                    }
                  );
                }
                await load();
              });
            }}
          />
        </label>
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            void run(() => download(`${base}/export`, `${workspace.name}.tar.gz`, true))
          }
        >
          Export computer
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="muted">
          Working…
        </p>
      )}
      {discard && (
        <div className="computer-confirm" role="alert">
          <p>This file has unsaved edits.</p>
          <button className="button" onClick={() => setDiscard(null)}>
            Keep editing
          </button>
          <button
            className="button"
            onClick={() => {
              discard();
              setDiscard(null);
            }}
          >
            Discard edits and continue
          </button>
        </div>
      )}
      <details className="file-new">
        <summary>New file or folder</summary>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              if (entries.some((entry) => entry.name === newName))
                throw new Error(`${newName} already exists. Choose another name.`);
              const path = `${folder}/${newName}`;
              if (newKind === 'folder') await post(`${base}/files/folder`, { path });
              else
                await request(`${base}/file?path=${encodeURIComponent(path)}&createOnly=true`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/octet-stream' },
                  body: ''
                });
              setNewName('');
              await load();
              if (newKind === 'file') navigate(() => void run(() => read(path, 1, true)));
            });
          }}
        >
          <input
            className="field"
            aria-label={`New ${newKind} name`}
            placeholder={`New ${newKind} name`}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            required
            pattern="[^/\\]+"
          />
          <select
            className="field"
            aria-label="Create kind"
            value={newKind}
            onChange={(event) => setNewKind(event.target.value as 'folder' | 'file')}
          >
            <option value="folder">Folder</option>
            <option value="file">Text file</option>
          </select>
          <button className="button" disabled={busy || !newName.trim()}>
            Create {newKind}
          </button>
        </form>
      </details>
      <div className={`computer-file-layout ${file ? 'has-file' : 'no-file'}`}>
        <div className="computer-file-list" aria-label="Files">
          {entries.length ? (
            entries.map((entry) => (
              <button
                className={`computer-file-row ${file?.path === entry.path ? 'selected' : ''}`}
                key={entry.path}
                onClick={() =>
                  navigate(() => {
                    if (entry.type === 'directory') {
                      setFile(null);
                      setFolder(entry.path);
                    } else void run(() => read(entry.path));
                  })
                }
              >
                <span aria-hidden="true">{entry.type === 'directory' ? '▱' : '↗'}</span>
                <span>{entry.name}</span>
                <small className="muted">
                  {entry.type === 'directory' ? 'Folder' : bytes(entry.sizeBytes)}
                </small>
              </button>
            ))
          ) : (
            <p className="empty">No files in this folder.</p>
          )}
        </div>
        <div className="computer-editor">
          {file ? (
            <>
              <div className="row">
                <strong className="computer-path">{file.path}</strong>
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      download(
                        `${base}/file?path=${encodeURIComponent(file.path)}`,
                        file.path.split('/').at(-1) || 'workspace-file'
                      )
                    )
                  }
                >
                  Download
                </button>
                <button
                  className="button"
                  onClick={() => navigate(() => void run(() => read(file.path)))}
                >
                  Reload
                </button>
              </div>
              {file.truncated && (
                <p className="muted">
                  Reading a window, lines {file.start}–{file.end ?? '…'}. This view cannot replace
                  the whole file.
                </p>
              )}
              {file.binary ? (
                <p className="empty">Binary file. Download it to open it in its application.</p>
              ) : (
                <textarea
                  className="computer-source field"
                  aria-label={`Contents of ${file.path}`}
                  spellCheck={false}
                  readOnly={file.truncated || !file.sha}
                  value={file.text}
                  onChange={(e) => setFile({ ...file, text: e.target.value })}
                />
              )}
              <div className="row">
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    file.binary ||
                    file.truncated ||
                    !file.sha ||
                    file.text === file.original
                  }
                  onClick={() => void run(save)}
                >
                  Save changes
                </button>
                {file.next && (
                  <button
                    className="button"
                    onClick={() => void run(() => read(file.path, file.next!))}
                  >
                    Read next lines
                  </button>
                )}
                <button
                  className="button"
                  disabled={busy || !publication}
                  onClick={() =>
                    void run(async () => {
                      if (!publication) return;
                      await post(`${base}/artifacts`, publication);
                      await load();
                    })
                  }
                >
                  Save as result
                </button>
                <button className="button" onClick={() => setRemove(file.path)}>
                  Delete file
                </button>
              </div>
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const to = `${folder}/${rename}`;
                    await post(`${base}/files/rename`, { from: file.path, to });
                    setFile(null);
                    await load();
                  });
                }}
              >
                <input
                  className="field"
                  aria-label="Rename file"
                  value={rename}
                  onChange={(e) => setRename(e.target.value)}
                  required
                  pattern="[^/\\]+"
                />
                <button className="button" disabled={busy || file.text !== file.original}>
                  Rename
                </button>
              </form>
              {remove === file.path && (
                <div className="computer-confirm">
                  <p>Delete {file.path}?</p>
                  <button className="button" onClick={() => setRemove(null)}>
                    Cancel
                  </button>
                  <button
                    className="button"
                    onClick={() =>
                      void run(async () => {
                        await del(`${base}/file?path=${encodeURIComponent(file.path)}`);
                        setRemove(null);
                        setFile(null);
                        await load();
                      })
                    }
                  >
                    Delete
                  </button>
                </div>
              )}
            </>
          ) : (
            <p className="empty">Open a file to inspect or edit it.</p>
          )}
        </div>
      </div>
      <section>
        <h3>Saved results</h3>
        {preview && (
          <div className="stack">
            <div className="row">
              <strong>{preview.name}</strong>
              <button className="button" onClick={() => setPreview(null)}>
                Close preview
              </button>
            </div>
            <ResultPreview key={preview.id} artifact={preview} />
          </div>
        )}
        {artifacts.length ? (
          artifacts.map((artifact) => (
            <div className="computer-file-row" key={artifact.id}>
              <button className="text-button" onClick={() => setPreview(artifact)}>
                {artifact.name}
              </button>
              <span className="muted">
                {bytes(artifact.sizeBytes)} · version {artifact.version}
              </span>
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  void run(() => download(`/v1/artifacts/${artifact.id}/content`, artifact.name))
                }
              >
                Download
              </button>
              <button className="button" onClick={() => setPreview(artifact)}>
                Preview
              </button>
              <button className="button" onClick={() => setRemove(artifact.id)}>
                Delete
              </button>
              {remove === artifact.id && (
                <span className="row">
                  <button className="button" onClick={() => setRemove(null)}>
                    Cancel
                  </button>
                  <button
                    className="button"
                    onClick={() =>
                      void run(async () => {
                        await del(`/v1/artifacts/${artifact.id}`);
                        if (preview?.id === artifact.id) setPreview(null);
                        setRemove(null);
                        await load();
                      })
                    }
                  >
                    Confirm delete
                  </button>
                </span>
              )}
            </div>
          ))
        ) : (
          <p className="muted">Results saved by you or your tasks appear here.</p>
        )}
      </section>
    </div>
  );
}
