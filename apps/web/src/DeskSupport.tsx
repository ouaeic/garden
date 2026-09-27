import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, File, Folder, RefreshCw } from 'lucide-react';
import type { DirectoryPage, Project, ProjectDirectory, Task } from '@athanor/contracts';
import { get } from './client';
import { Button, ErrorNotice, Spinner } from './ui';
import ScrollRegion from './ScrollRegion';
import { setSurfaceLocation } from './surface-location';
import { processMemory } from './process-display';
import { taskStatusLabel } from './model';
import { changeSummary, useProjectChanges } from './use-project-changes';

const ProcessPanel = lazy(() => import('./ProcessPanel'));

function DeskFiles({ projectId, taskId }: { projectId: string; taskId?: string }) {
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

export default function DeskSupport({
  project,
  taskId,
  tasks,
  onTask,
  onProcesses
}: {
  project: Project;
  taskId?: string;
  tasks: Task[];
  onTask: (id: string) => void;
  onProcesses: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const recent = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
  const changes = useProjectChanges(project.id, container, true, taskId ?? '');
  return (
    <aside className="desk-support" aria-label="Project cards">
      <DeskFiles projectId={project.id} {...(taskId ? { taskId } : {})} />
      <Suspense
        fallback={
          <div className="desk-card">
            <Spinner label="Opening processes" />
          </div>
        }
      >
        <ProcessPanel
          workspaceId={project.workspaceId}
          projectId={project.id}
          compact
          onOpen={onProcesses}
        />
      </Suspense>
      <section className="desk-card desk-updates" aria-label="Updates card">
        <header className="desk-card-heading">
          <h2>Latest updates</h2>
          <Button onClick={() => setSurfaceLocation({ panel: 'activity' })}>
            All <ArrowUpRight size={14} />
          </Button>
        </header>
        <ScrollRegion label="Project update summaries" className="desk-card-scroll">
          <div ref={container}>
            {recent.map((task) => (
              <button
                className="desk-update-row"
                key={task.id}
                data-task-id={task.id === taskId ? task.id : undefined}
                onClick={() => {
                  onTask(task.id);
                  setSurfaceLocation({ panel: 'activity' }, true);
                }}
              >
                <time>
                  {new Date(task.updatedAt).toLocaleTimeString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </time>
                <span>
                  <strong>{task.title}</strong>
                  <small>{task.activity?.latest ?? taskStatusLabel(task)}</small>
                  {task.id === taskId && changeSummary(changes[task.id]) && (
                    <small>{changeSummary(changes[task.id])}</small>
                  )}
                </span>
              </button>
            ))}
            {!recent.length && (
              <p className="desk-empty-state muted">Recorded progress will appear here.</p>
            )}
          </div>
        </ScrollRegion>
      </section>
    </aside>
  );
}
