import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { Download, Folder, FolderOpen, File, RefreshCw } from 'lucide-react';
import type { DirectoryEntry, DirectoryPage, ProjectDirectory } from '@athanor/contracts';
import { get, isNativeClient } from './client';
import { requireDownloadSupport } from './download-support';
import { Button, ErrorNotice, Spinner } from './ui';
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
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (openRequest) setExpanded(true);
  }, [openRequest]);
  const [roots, setRoots] = useState<ProjectDirectory[]>([]);
  const [rootId, setRootId] = useState('');
  const [folder, setFolder] = useState('workspace');
  const [listing, setListing] = useState<DirectoryPage | null>(null);
  const [file, setFile] = useState<DirectoryEntry | null>(null);
  const [fileView, setFileView] = useState<'source' | 'table' | 'notebook'>('source');
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [rootsRevision, setRootsRevision] = useState(0);
  const request = useRef<AbortController | null>(null);
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
            : (result.directories[0]?.workspaceId ?? '')
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
      try {
        const query = new URLSearchParams({ path: folder });
        if (cursor) query.set('cursor', cursor);
        const result = await get<DirectoryPage>(`${base}/directory?${query}`, {
          signal: controller.signal
        });
        if (!controller.signal.aborted)
          setListing((previous) =>
            cursor && previous
              ? { ...result, entries: [...previous.entries, ...result.entries] }
              : result
          );
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
  const navigate = (next: string, workspace = rootId) => {
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
              : 'Scripts, data and results in your project’s execution directories.'}
          </p>
        </div>
        <Button
          disabled={dirty}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Hide files' : 'Browse files'}
        </Button>
      </div>
      {expanded && (
        <>
          <ErrorNotice
            error={error}
            onRetry={() => (rootId ? void load() : setRootsRevision((value) => value + 1))}
          />
          {root && (
            <>
              <div className="directory-toolbar">
                <label className="directory-root">
                  {readOnlyRoot ? 'File source' : 'Execution directory'}
                  <select
                    className="field"
                    value={rootId}
                    disabled={dirty}
                    onChange={(event) => navigate('workspace', event.target.value)}
                  >
                    {roots.map((item) => (
                      <option key={item.workspaceId} value={item.workspaceId}>
                        {item.name}
                        {item.current ? ' · current' : ' · ' + item.workspaceId.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  aria-label="Refresh directory"
                  disabled={loading}
                  onClick={() => void load()}
                >
                  <RefreshCw size={14} aria-hidden="true" /> Refresh
                </Button>
                <a className="button" href={zipUrl(root.path)} download onClick={downloadClick}>
                  <Download size={14} aria-hidden="true" /> Download directory ZIP
                </a>
              </div>
              <nav className="directory-breadcrumbs" aria-label="Project directory path">
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
                    <ul className="directory-list" aria-label="Directory contents">
                      {listing.entries.map((entry) => (
                        <li key={entry.path}>
                          <span className="directory-entry-icon" aria-hidden="true">
                            {entry.type === 'directory' ? <Folder size={17} /> : <File size={17} />}
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
                                  setFileView('notebook');
                                  setFile(entry);
                                }}
                              >
                                Open notebook<span className="sr-only"> {entry.name}</span>
                              </Button>
                            )}
                            {entry.type === 'file' && tableFile.test(entry.name) && (
                              <Button
                                disabled={dirty}
                                onClick={() => {
                                  setFileView('table');
                                  setFile(entry);
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
                                    setFileView('source');
                                    setFile(entry);
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
                  ) : (
                    <p className="muted">This directory is empty.</p>
                  )}
                  {listing.nextCursor && (
                    <Button disabled={loading} onClick={() => void load(listing.nextCursor!)}>
                      Load more files
                    </Button>
                  )}
                </>
              )}
              <p className="directory-note muted">
                Downloads stream directly to your device. ZIPs include hidden files and empty
                folders. Finish writing files before downloading a consistent copy. Files may be
                shared with other projects using this execution directory.
              </p>
            </>
          )}
          {loading && <Spinner label="Loading directory…" />}
          {!loading && !error && roots.length === 0 && (
            <p className="muted">No execution directory is available yet.</p>
          )}
          {file && (
            <div className="directory-inspector">
              <div className="directory-heading">
                <strong>{file.path}</strong>
                <Button disabled={dirty} onClick={() => setFile(null)}>
                  Close file
                </Button>
              </div>
              {dirty && (
                <p className="muted" role="status">
                  Save or reload this file before leaving it.
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
    </section>
  );
}
