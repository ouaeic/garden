import ScrollRegion from './ScrollRegion';
import { setSurfaceLocation, useSurfaceLocation } from './surface-location';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { Download, Folder, FolderOpen, File, RefreshCw } from 'lucide-react';
import type { DirectoryEntry, DirectoryPage, ProjectDirectory } from '@athanor/contracts';
import { get, post, request as writeRequest, isNativeClient } from './client';
import { requireDownloadSupport } from './download-support';
import { Button, Dialog, ErrorNotice, Field, Spinner } from './ui';
import { processMemory } from './process-display';
import './directories.css';
import type { AnalysisSelection } from './computer/analysis-selection';

const SourceInspector = lazy(() => import('./computer/SourceInspector'));
const TablePreview = lazy(() => import('./computer/TablePreview'));
const NotebookPreview = lazy(() => import('./computer/NotebookPreview'));
const tableFile = /\.(?:csv|tsv|jsonl|ndjson)$/i;
const textFile =
  /\.(?:txt|md|log|csv|tsv|json|jsonl|ya?ml|toml|ini|py|r|sh|js|ts|tsx|jsx|html|css|sql|fa|fasta|fq|fastq|vcf|bed|gff3?|gtf)$/i;

export default function DirectoryPanel({
  taskId,
  projectId,
  openRequest = 0,
  readOnlyRoot,
  rerunWorkspaceId,
  onRerunAnalysis
}: {
  taskId?: string;
  rerunWorkspaceId?: string;
  onRerunAnalysis?: (selection: AnalysisSelection) => void;
  projectId?: string;
  openRequest?: number;
  readOnlyRoot?: { base: string; id: string; name: string; description: string };
}) {
  const readOnlyId = readOnlyRoot?.id,
    readOnlyName = readOnlyRoot?.name;
  const [creating, setCreating] = useState(false);
  const [newKind, setNewKind] = useState<'file' | 'folder'>('file');
  const [newName, setNewName] = useState('');
  const [writing, setWriting] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [expanded, setExpanded] = useState(Boolean(openRequest));
  useEffect(() => {
    if (openRequest) setExpanded(true);
  }, [openRequest]);
  const [roots, setRoots] = useState<ProjectDirectory[]>([]);
  const [rootId, setRootId] = useState('');
  const [locationFolder] = useSurfaceLocation('folder', 'workspace');
  const [locationRoot] = useSurfaceLocation('root', '');
  const [locationFile] = useSurfaceLocation('file', '');
  const [locationFileView] = useSurfaceLocation('fileView', 'source');
  const [folder, setFolder] = useState(!readOnlyRoot ? locationFolder : 'workspace');
  const [listing, setListing] = useState<DirectoryPage | null>(null);
  const [file, setFile] = useState<DirectoryEntry | null>(null);
  const [fileView, setFileView] = useState<'source' | 'table' | 'notebook'>('source');
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [paged, setPaged] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [rootsRevision, setRootsRevision] = useState(0);
  const request = useRef<AbortController | null>(null);
  const directoryPath = useRef<HTMLElement | null>(null);
  const focusPath = useRef(false);
  useEffect(() => {
    if (!focusPath.current) return;
    focusPath.current = false;
    directoryPath.current?.focus();
  }, [folder, rootId]);
  useEffect(() => {
    if (!expanded) return;
    if (readOnlyId && readOnlyName) {
      setRoots([{ workspaceId: readOnlyId, name: readOnlyName, path: 'workspace', current: true }]);
      setRootId(readOnlyId);
      setFolder('workspace');
      return;
    }
    const controller = new AbortController();
    setError(null);
    setLoading(true);
    void get<{ directories: ProjectDirectory[] }>(
      projectId ? `/v1/projects/${projectId}/directories` : `/v1/tasks/${taskId}/directories`,
      {
        signal: controller.signal
      }
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setRoots(result.directories);
        setRootId((previous) =>
          result.directories.some((root) => root.workspaceId === previous)
            ? previous
            : (result.directories.find((root) => !readOnlyRoot && root.workspaceId === locationRoot)
                ?.workspaceId ??
              result.directories[0]?.workspaceId ??
              '')
        );
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [taskId, projectId, expanded, rootsRevision, readOnlyId, readOnlyName]);
  const base = readOnlyRoot ? readOnlyRoot.base : `/v1/workspaces/${rootId}`;
  const root = roots.find((item) => item.workspaceId === rootId);
  const load = useCallback(
    async (cursor?: string) => {
      if (!rootId) return;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setError(null);
      if (!cursor) setPaged(false);
      try {
        const query = new URLSearchParams({ path: folder });
        if (cursor) query.set('cursor', cursor);
        const result = await get<DirectoryPage>(`${base}/directory?${query}`, {
          signal: controller.signal
        });
        if (!controller.signal.aborted) {
          if (cursor) setPaged(true);
          setListing((previous) =>
            cursor && previous
              ? { ...result, entries: [...previous.entries, ...result.entries] }
              : result
          );
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [base, rootId, folder]
  );
  useEffect(() => {
    setListing(null);
    if (expanded) void load();
    return () => request.current?.abort();
  }, [load, expanded]);
  useEffect(() => {
    if (readOnlyRoot || dirty) return;
    setFolder(locationFolder);
    if (roots.some((root) => root.workspaceId === locationRoot)) setRootId(locationRoot);
    if (!locationFile) setFile(null);
    else if (listing?.path === locationFolder) {
      const entry = listing.entries.find(
        (entry) => entry.path === locationFile && entry.type === 'file'
      );
      if (entry) {
        setFile(entry);
        setFileView(
          locationFileView === 'table'
            ? 'table'
            : locationFileView === 'notebook'
              ? 'notebook'
              : 'source'
        );
      } else if (listing.nextCursor && !loading && !error) {
        void load(listing.nextCursor);
      }
    }
  }, [
    load,
    loading,
    error,
    locationFolder,
    locationRoot,
    locationFile,
    locationFileView,
    roots,
    listing,
    readOnlyRoot,
    dirty
  ]);
  function chooseFile(entry: DirectoryEntry, view: 'source' | 'table' | 'notebook') {
    setFileView(view);
    setFile(entry);
    if (!readOnlyRoot)
      setSurfaceLocation({ root: rootId, folder, file: entry.path, fileView: view }, true);
  }
  const navigate = (next: string, workspace = rootId, focus = true) => {
    if (next === folder && workspace === rootId) return;
    if (!readOnlyRoot && !setSurfaceLocation({ root: workspace, folder: next, file: null })) return;
    focusPath.current = focus;
    setFile(null);
    setRootId(workspace);
    setFolder(next);
  };
  const zipUrl = (path: string) => `${base}/directory.zip?${new URLSearchParams({ path })}`;
  const downloadClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isNativeClient()) return;
    event.preventDefault();
    const href = event.currentTarget.href;
    void requireDownloadSupport()
      .then(() => {
        const link = document.createElement('a');
        link.href = href;
        link.download = '';
        link.click();
      })
      .catch(setError);
  };
  async function createEntry(files?: File[]) {
    if (writing || !rootId || readOnlyRoot) return;
    setWriting(true);
    setError(null);
    try {
      const existing = new Set((listing?.entries ?? []).map((entry) => entry.path));
      for (const name of files ? files.map((file) => file.name) : [newName.trim()]) {
        if (!name || name === '.' || name === '..' || /[\\/]/.test(name))
          throw new Error('Use a file name without a directory path.');
        if (existing.has(`${folder}/${name}`))
          throw new Error(`${name} already exists. Choose a different name.`);
        const path = `${folder}/${name}`;
        if (!files && newKind === 'folder') await post(`${base}/files/folder`, { path });
        else
          await writeRequest(`${base}/file?${new URLSearchParams({ path, createOnly: 'true' })}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: files?.find((file) => file.name === name) ?? ''
          });
        existing.add(path);
      }
      setCreating(false);
      setNewName('');
      await load();
    } catch (cause) {
      setError(cause);
    } finally {
      setWriting(false);
    }
  }
  return (
    <section className="project-directories" aria-label="Project files">
      <div className="directory-heading">
        <div>
          <h3>
            <FolderOpen size={17} aria-hidden="true" /> Project files
          </h3>
          <p className="muted">
            {readOnlyRoot
              ? readOnlyRoot.description
              : 'Browse working copies, scripts, data and results. Edits apply to the selected copy.'}
          </p>
        </div>
        {!openRequest && (
          <Button
            disabled={dirty}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? 'Hide files' : 'Browse files'}
          </Button>
        )}
      </div>
      {expanded && (
        <>
          <ErrorNotice
            context="Could not refresh files."
            error={error}
            onRetry={() => (rootId ? void load() : setRootsRevision((value) => value + 1))}
          />
          {root && (
            <>
              <div className="directory-toolbar">
                <label className="directory-root">
                  {readOnlyRoot ? 'File source' : 'Working copy'}
                  <select
                    className="field"
                    value={rootId}
                    disabled={dirty}
                    onChange={(event) => navigate('workspace', event.target.value, false)}
                  >
                    {roots.map((item) => (
                      <option key={item.workspaceId} value={item.workspaceId}>
                        {item.name === 'Project execution' ? 'This conversation' : item.name}
                        {item.current ? ' · current' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                {!readOnlyRoot && (
                  <>
                    <Button disabled={dirty || writing} onClick={() => setCreating(true)}>
                      New
                    </Button>
                    <label className="button computer-upload">
                      Upload
                      <input
                        type="file"
                        multiple
                        disabled={dirty || writing}
                        onChange={(event) => {
                          const files = Array.from(event.target.files ?? []);
                          event.target.value = '';
                          if (files.length) void createEntry(files);
                        }}
                      />
                    </label>
                  </>
                )}
                <label className="directory-hidden-toggle">
                  <input
                    type="checkbox"
                    checked={showHidden}
                    onChange={(event) => setShowHidden(event.target.checked)}
                  />{' '}
                  Hidden files
                </label>
                <Button
                  aria-label="Refresh directory"
                  aria-disabled={loading}
                  onClick={() => {
                    if (!loading) void load();
                  }}
                >
                  <RefreshCw size={14} aria-hidden="true" /> Refresh
                </Button>
                <a className="button" href={zipUrl(root.path)} download onClick={downloadClick}>
                  <Download size={14} aria-hidden="true" /> Download directory ZIP
                </a>
              </div>
              <nav
                ref={directoryPath}
                tabIndex={-1}
                className="directory-breadcrumbs"
                aria-label="Project directory path"
              >
                {folder.split('/').map((part, index, parts) => (
                  <span key={index}>
                    {index > 0 && <span aria-hidden="true"> / </span>}
                    <button
                      disabled={dirty || index === parts.length - 1}
                      aria-current={index === parts.length - 1 ? 'location' : undefined}
                      onClick={() => navigate(parts.slice(0, index + 1).join('/'))}
                    >
                      {part}
                    </button>
                  </span>
                ))}
              </nav>
              {folder !== root.path && (
                <a
                  className="button directory-folder-download"
                  href={zipUrl(folder)}
                  download
                  onClick={downloadClick}
                >
                  <Download size={14} aria-hidden="true" /> Download this folder ZIP
                </a>
              )}
              {Boolean(error) && listing && (
                <p className="muted" role="status">
                  Showing the last received file list. Refresh before relying on it.
                </p>
              )}
              {listing && (
                <>
                  {listing.entries.length ? (
                    <ScrollRegion label="Project directory files" resetKey={`${rootId}/${folder}`}>
                      <ul className="directory-list" aria-label="Directory contents">
                        {listing.entries
                          .filter(
                            (entry) => showHidden || !entry.path.split('/').at(-1)?.startsWith('.')
                          )
                          .map((entry) => (
                            <li key={entry.path}>
                              <span className="directory-entry-icon" aria-hidden="true">
                                {entry.type === 'directory' ? (
                                  <Folder size={17} />
                                ) : (
                                  <File size={17} />
                                )}
                              </span>
                              <div className="directory-entry-name">
                                {entry.type === 'directory' ? (
                                  <button disabled={dirty} onClick={() => navigate(entry.path)}>
                                    {entry.name}
                                  </button>
                                ) : (
                                  <span>{entry.name}</span>
                                )}
                                <small className="muted">
                                  {entry.type === 'file'
                                    ? processMemory(entry.sizeBytes)
                                    : entry.type === 'symlink'
                                      ? 'Symbolic link · preserved in ZIP'
                                      : entry.type === 'special'
                                        ? 'Special file'
                                        : 'Folder'}
                                </small>
                              </div>
                              <div className="directory-entry-actions">
                                {entry.type === 'file' && /\.ipynb$/i.test(entry.name) && (
                                  <Button
                                    disabled={dirty}
                                    onClick={() => {
                                      chooseFile(entry, 'notebook');
                                    }}
                                  >
                                    Open notebook<span className="sr-only"> {entry.name}</span>
                                  </Button>
                                )}
                                {entry.type === 'file' && tableFile.test(entry.name) && (
                                  <Button
                                    disabled={dirty}
                                    onClick={() => {
                                      chooseFile(entry, 'table');
                                    }}
                                  >
                                    View table<span className="sr-only"> {entry.name}</span>
                                  </Button>
                                )}
                                {entry.type === 'file' &&
                                  !readOnlyRoot &&
                                  textFile.test(entry.name) && (
                                    <Button
                                      disabled={dirty}
                                      onClick={() => {
                                        chooseFile(entry, 'source');
                                      }}
                                    >
                                      Inspect<span className="sr-only"> {entry.name}</span>
                                    </Button>
                                  )}
                                {(entry.type === 'file' || entry.type === 'directory') && (
                                  <a
                                    className="button"
                                    href={
                                      entry.type === 'directory'
                                        ? zipUrl(entry.path)
                                        : `${base}/download?${new URLSearchParams({ path: entry.path })}`
                                    }
                                    download
                                    onClick={downloadClick}
                                    aria-label={`Download ${entry.name}${entry.type === 'directory' ? ' as ZIP' : ''}`}
                                  >
                                    <Download size={14} aria-hidden="true" />
                                    <span>{entry.type === 'directory' ? 'ZIP' : 'Download'}</span>
                                  </a>
                                )}
                              </div>
                            </li>
                          ))}
                      </ul>
                    </ScrollRegion>
                  ) : (
                    <p className="muted">This directory is empty.</p>
                  )}
                  {(listing.nextCursor || paged) && (
                    <Button
                      aria-disabled={loading || !listing.nextCursor}
                      aria-busy={loading}
                      onClick={() => {
                        if (!loading && listing.nextCursor) void load(listing.nextCursor);
                      }}
                    >
                      {loading
                        ? 'Loading more files…'
                        : listing.nextCursor
                          ? 'Load more files'
                          : 'All files loaded'}
                    </Button>
                  )}
                </>
              )}
              <p className="directory-note muted">
                Downloads stream directly to your device. ZIPs include hidden files and empty
                folders. Finish writing files before downloading a consistent copy. Downloads use
                the selected working copy; running jobs keep their original inputs.
              </p>
            </>
          )}
          {loading && <Spinner label="Loading directory…" />}
          {!loading && !error && roots.length === 0 && (
            <p className="muted">A working copy will appear here when the conversation starts.</p>
          )}
          {file && (
            <div className="directory-inspector">
              <div className="directory-heading">
                <strong>{file.path}</strong>
                <Button
                  disabled={dirty}
                  onClick={() => {
                    if (!readOnlyRoot) setSurfaceLocation({ file: null }, true);
                    setFile(null);
                  }}
                >
                  Close file
                </Button>
              </div>
              {dirty && (
                <p className="muted" role="status">
                  Save or discard your edits before leaving this file.
                </p>
              )}
              <Suspense fallback={<Spinner label="Opening file…" />}>
                {fileView === 'table' ? (
                  <TablePreview key={`${base}:${file.path}`} base={base} path={file.path} />
                ) : fileView === 'notebook' ? (
                  <NotebookPreview
                    key={`${base}:${file.path}`}
                    url={`${base}/download?${new URLSearchParams({ path: file.path })}`}
                    name={file.name}
                    {...(!readOnlyRoot
                      ? {
                          editable: {
                            workspaceId: rootId,
                            path: file.path,
                            onDirtyChange: setDirty
                          }
                        }
                      : {})}
                  />
                ) : (
                  <SourceInspector
                    key={`${rootId}:${file.path}`}
                    workspaceId={rootId}
                    path={file.path}
                    onDirtyChange={setDirty}
                    {...(!readOnlyRoot && rootId === rerunWorkspaceId && onRerunAnalysis
                      ? { onRerunAnalysis }
                      : {})}
                  />
                )}
              </Suspense>
            </div>
          )}
        </>
      )}
      {creating && (
        <Dialog
          title="New file or folder"
          onClose={() => {
            if (!writing) setCreating(false);
          }}
        >
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void createEntry();
            }}
          >
            <p className="muted">
              In {root?.name} · {folder}
            </p>
            <Field label="Kind">
              <select
                value={newKind}
                onChange={(event) => setNewKind(event.target.value as 'file' | 'folder')}
              >
                <option value="file">Text file</option>
                <option value="folder">Folder</option>
              </select>
            </Field>
            <Field label="Name">
              <input
                required
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
              />
            </Field>
            <Button type="submit" className="primary" busy={writing} disabled={!newName.trim()}>
              Create {newKind}
            </Button>
            <ErrorNotice error={error} />
          </form>
        </Dialog>
      )}
    </section>
  );
}
