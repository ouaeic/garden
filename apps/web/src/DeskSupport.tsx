import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowUpRight, File, Folder, RefreshCw } from './icons';
import type { DirectoryPage, Project, ProjectDirectory } from '@garden/contracts';
import { RunRows, useRuns } from './runs';
import { get } from './client';
import { Button, ErrorNotice } from './ui';
import ScrollRegion from './ScrollRegion';
import { setSurfaceLocation, useProjectView } from './surface-location';
import { processMemory } from './process-display';
import { changeSummary, useProjectChanges } from './use-project-changes';

function DeskFiles({
  projectId,
  taskId,
  changed
}: {
  projectId: string;
  taskId?: string;
  changed: string | null;
}) {
  const [data, setData] = useState<{ root: ProjectDirectory; page: DirectoryPage } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    setData(null);
    setError(null);
    setLoaded(false);
    const refresh = async () => {
      if (pending || document.visibilityState !== 'visible') return;
      pending = true;
      try {
        const roots = await get<{ directories: ProjectDirectory[] }>(
          taskId ? `/v1/tasks/${taskId}/directories` : `/v1/projects/${projectId}/directories`,
          { signal: controller.signal }
        );
        const root = roots.directories[0];
        if (!root) {
          if (!controller.signal.aborted) setData(null);
          return;
        }
        const page = await get<DirectoryPage>(
          `/v1/workspaces/${root.workspaceId}/directory?${new URLSearchParams({ path: root.path })}`,
          { signal: controller.signal }
        );
        if (!controller.signal.aborted) {
          setData({ root, page });
          setError(null);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause);
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoaded(true);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [projectId, taskId, revision]);
  return (
    <section className="desk-card desk-files" aria-label="Files card">
      <header className="desk-card-heading">
        <h2>
          <Folder size={16} />
          Files
        </h2>

        <div className="row">
          <Button aria-label="Refresh file card" onClick={() => setRevision((value) => value + 1)}>
            <RefreshCw size={14} />
          </Button>
          <Button onClick={() => setSurfaceLocation({ panel: 'files' })}>
            Open all <ArrowUpRight size={14} />
          </Button>
        </div>
      </header>
      {/* Always present, so the change reader can see it before there is anything to say. */}
      <p className="desk-file-changes" data-task-id={taskId}>
        {changed}
      </p>
      <ScrollRegion
        label="Project file shortcuts"
        className="desk-card-scroll"
        resetKey={`${projectId}/${taskId ?? ''}`}
      >
        <ErrorNotice error={error} />
        {data?.page.entries
          .filter((entry) => !entry.name.startsWith('.'))
          .map((entry) => (
            <button
              className="desk-file-row"
              key={entry.path}
              onClick={() =>
                setSurfaceLocation({
                  panel: 'files',
                  root: data.root.workspaceId,
                  folder: entry.type === 'directory' ? entry.path : data.page.path,
                  file: entry.type === 'file' ? entry.path : null,
                  fileView: 'source'
                })
              }
            >
              {entry.type === 'directory' ? <Folder size={15} /> : <File size={15} />}
              <span>{entry.name}</span>
              <small>
                {entry.type === 'directory' ? 'Folder' : processMemory(entry.sizeBytes)}
              </small>
            </button>
          ))}
        {loaded &&
          (!data || !data.page.entries.some((entry) => !entry.name.startsWith('.'))) &&
          !error && (
            <p className="desk-empty-state muted">Files will appear as the project takes shape.</p>
          )}
        {!loaded && !error && (
          <p className="desk-empty-state muted">Opening the project directory…</p>
        )}
        {data?.page.nextCursor && (
          <Button
            onClick={() =>
              setSurfaceLocation({
                panel: 'files',
                root: data.root.workspaceId,
                folder: data.page.path
              })
            }
          >
            Browse the full directory <ArrowUpRight size={14} />
          </Button>
        )}
      </ScrollRegion>
    </section>
  );
}

/**
 * Beside the conversation: the project's files, with what this conversation changed, and whatever
 * is running for the project - only while something is.
 */
export default function DeskSupport({
  project,
  taskId,
  onProcesses
}: {
  project: Project;
  taskId?: string;
  onProcesses: () => void;
}) {
  const marker = useRef<HTMLDivElement>(null);
  const changes = useProjectChanges(project.id, marker, Boolean(taskId), taskId ?? '');
  const changed = taskId ? changeSummary(changes[taskId]) : null;
  // An open panel shows these runs itself; one reader per screen is enough.
  const [view] = useProjectView();
  const runs = useRuns(view === 'work' ? `/v1/projects/${project.id}/processes` : null);
  // This conversation's own runs are shown in the conversation; these are the others'.
  const elsewhere = runs.active.filter((process) => !taskId || process.ownerTaskId !== taskId);
  return (
    <aside className="desk-support" aria-label="Project cards" ref={marker}>
      <DeskFiles projectId={project.id} changed={changed} {...(taskId ? { taskId } : {})} />
      {elsewhere.length > 0 && (
        <section className="desk-card desk-runs" aria-label="Runs card">
          <header className="desk-card-heading">
            <h2>
              <Activity size={16} />
              {taskId ? 'Also running' : 'Running'} · {elsewhere.length}
            </h2>
            <Button onClick={onProcesses}>
              All <ArrowUpRight size={14} />
            </Button>
          </header>
          <ScrollRegion label="Project runs" className="desk-card-scroll">
            <RunRows
              processes={elsewhere}
              observedAt={runs.list?.observedAt}
              onOpen={onProcesses}
            />
          </ScrollRegion>
        </section>
      )}
    </aside>
  );
}
