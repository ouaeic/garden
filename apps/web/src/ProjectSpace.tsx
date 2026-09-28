import ProjectPanel, { ProjectPanelLinks, useDockedPanels } from './ProjectPanel';
import ScrollRegion from './ScrollRegion';
import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, MessageSquarePlus, Settings2 } from './icons';
import type {
  Artifact,
  ConversationSource,
  Project,
  Task,
  TaskPresentation
} from '@garden/contracts';
import { get, patch } from './client';
import {
  money,
  taskStatusLabel,
  conversationResultSource,
  needsAttention,
  hasOngoingWork
} from './model';
import { Button, Dialog, ErrorNotice, Field, Spinner } from './ui';
import { projectStatus } from './ProjectCollection';
import { changeSummary, useProjectChanges } from './use-project-changes';
import { permissionModeSummary } from './asking-rules';
import './projects.css';
import { fileNavigationBlocked } from './file-navigation';
import { useProjectView, setSurfaceLocation } from './surface-location';
import StatusSprite, { stageOf } from './life/StatusSprite';
const DeskSupport = lazy(() => import('./DeskSupport'));
const ProjectJobsLink = lazy(() => import('./ProjectJobsLink'));
const ProjectUpdates = lazy(() => import('./ProjectUpdates'));
const ProjectNotes = lazy(() => import('./ProjectNotes'));
const ProcessPanel = lazy(() => import('./ProcessPanel'));
const DirectoryPanel = lazy(() => import('./DirectoryPanel'));
const ProjectSessions = lazy(() => import('./ProjectSessions'));
const ProjectModels = lazy(() => import('./ProjectModels'));
const ResultPreview = lazy(() =>
  import('./computer/ResultPreview').then((module) => ({ default: module.ResultPreview }))
);
const TaskOutputs = lazy(() =>
  import('./TaskCanvas').then((module) => ({ default: module.TaskOutputs }))
);

function ConversationResults({
  task,
  onOpen,
  onDiscuss
}: {
  task: Task;
  onOpen: () => void;
  onDiscuss: (source: ConversationSource) => void;
}) {
  const [result, setResult] = useState<TaskPresentation | null>(null),
    [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<Pick<
    Artifact,
    'id' | 'name' | 'mimeType' | 'sizeBytes'
  > | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void get<TaskPresentation>(`/v1/tasks/${task.id}/presentation`, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setResult(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      });
    return () => controller.abort();
  }, [task.id, task.updatedAt]);
  if (result && !result.results.length) return null;
  return (
    <section className="project-result-group">
      <div className="project-section-heading">
        <button onClick={onOpen}>{task.title}</button>
        <Button onClick={() => onDiscuss({ taskId: task.id })}>Discuss results</Button>
      </div>
      {result && (
        <Suspense fallback={<Spinner />}>
          <TaskOutputs
            presentation={result}
            onArtifact={(id) => {
              const selected = result.results.find((item) => item.artifactId === id);
              if (!selected?.mimeType || selected.sizeBytes === undefined) {
                setError(
                  new Error('This result could not be opened. Refresh the project and try again.')
                );
                return;
              }
              setPreview({
                id,
                name: selected.title,
                mimeType: selected.mimeType,
                sizeBytes: selected.sizeBytes
              });
            }}
            onDiscuss={(result) => onDiscuss(conversationResultSource(task.id, result))}
            autoPreview={false}
          />
        </Suspense>
      )}
      <ErrorNotice context="Could not refresh this project." error={error} />
      {preview && (
        <Dialog title={preview.name} wide onClose={() => setPreview(null)}>
          <Suspense fallback={<Spinner label="Opening result" />}>
            <ResultPreview key={preview.id} artifact={preview} />
          </Suspense>
          <a
            className="button"
            href={`/v1/artifacts/${encodeURIComponent(preview.id)}/content`}
            download={preview.name}
          >
            Download result
          </a>
        </Dialog>
      )}
    </section>
  );
}

export default function ProjectSpace({
  projectId,
  taskId,
  currentTask,
  revision,
  children,
  onAllProjects,
  onOverview,
  onTask,
  onNewConversation,
  onRefresh,
  onComputer
}: {
  projectId: string;
  taskId?: string;
  currentTask?: Task;
  revision: string;
  children?: ReactNode;
  onAllProjects: () => void;
  onOverview: () => void;
  onTask: (id: string) => void;
  onNewConversation: (project: Project, source?: ConversationSource) => void;
  onRefresh: () => void;
  onComputer: (taskId: string, surface: 'browser' | 'desktop', tabId?: string) => void;
}) {
  const permissionHelpId = useId();
  const [wide, setWide] = useState(
    () => window.matchMedia('(min-width: 960px) and (min-height: 540px)').matches
  );
  useEffect(() => {
    const media = window.matchMedia('(min-width: 960px) and (min-height: 540px)');
    const update = () => setWide(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const [view, selectView] = useProjectView();
  const docked = useDockedPanels();
  const [filesOpened, setFilesOpened] = useState(view === 'files');
  useEffect(() => {
    if (view === 'files') setFilesOpened(true);
  }, [view]);
  const [project, setProject] = useState<Project | null>(null),
    [tasks, setTasks] = useState<Task[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState<unknown>(null),
    [settings, setSettings] = useState(false),
    [draft, setDraft] = useState<{ title: string; brief: string; revision: number } | null>(null),
    [busy, setBusy] = useState(false),
    [archived, setArchived] = useState(false),
    [query, setQuery] = useState(''),
    [activityTick, setActivityTick] = useState(0);
  useEffect(() => {
    if (taskId) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setActivityTick((value) => value + 1);
    }, 15_000);
    return () => clearInterval(timer);
  }, [taskId]);
  const loadedScope = useRef('');
  const paged = useRef(false);
  const moreRequest = useRef<AbortController | null>(null);
  const conversationGrid = useRef<HTMLDivElement>(null);
  const changes = useProjectChanges(
    projectId,
    conversationGrid,
    Boolean(project) && !taskId && view === 'activity',
    `${query}:${archived}:${tasks.map((task) => task.id).join(',')}`
  );
  useEffect(() => {
    setBusy(false);
    return () => {
      moreRequest.current?.abort();
      moreRequest.current = null;
    };
  }, [projectId, archived]);
  useEffect(() => {
    const scope = `${projectId}:${archived}`;
    const sameScope = loadedScope.current === scope;
    loadedScope.current = scope;
    if (!sameScope) paged.current = false;
    const controller = new AbortController();
    void Promise.all([
      get<Project>(`/v1/projects/${projectId}`, { signal: controller.signal }),
      get<{ tasks: Task[]; nextCursor: string | null }>(
        `/v1/projects/${projectId}/conversations?archived=${archived}`,
        { signal: controller.signal }
      )
    ])
      .then(([record, page]) => {
        if (!controller.signal.aborted) {
          setProject(record);
          setTasks((current) =>
            sameScope
              ? [
                  ...new Map(
                    [
                      ...current.filter((task) => Boolean(task.archivedAt) === archived),
                      ...page.tasks
                    ].map((task) => [task.id, task])
                  ).values()
                ]
              : page.tasks
          );
          if (!paged.current) setCursor(page.nextCursor);
          setError(null);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      });
    return () => controller.abort();
  }, [projectId, revision, archived, activityTick]);
  async function more() {
    if (!cursor || busy) return;
    const pending = new AbortController();
    moreRequest.current = pending;
    setBusy(true);
    try {
      const page = await get<{ tasks: Task[]; nextCursor: string | null }>(
        `/v1/projects/${projectId}/conversations?archived=${archived}&before=${encodeURIComponent(cursor)}`,
        { signal: pending.signal }
      );
      if (pending.signal.aborted) return;
      setTasks((rows) => [
        ...new Map([...rows, ...page.tasks].map((task) => [task.id, task])).values()
      ]);
      paged.current = true;
      setCursor(page.nextCursor);
    } catch (cause) {
      if (!pending.signal.aborted) setError(cause);
    } finally {
      if (moreRequest.current === pending) {
        moreRequest.current = null;
        setBusy(false);
      }
    }
  }
  async function save(fields: Record<string, unknown>) {
    if (!project || busy) return;
    setBusy(true);
    try {
      const next = await patch<Project>(`/v1/projects/${projectId}`, {
        expectedRevision: draft?.revision ?? project.revision,
        ...fields
      });
      setProject(next);
      setDraft((current) => (current ? { ...current, revision: next.revision } : null));
      setError(null);
      onRefresh();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  if (!project)
    return (
      <>
        <ErrorNotice context="Could not refresh this project." error={error} />
        {!error && <Spinner label="Opening project…" />}
      </>
    );
  const visible = tasks
    .filter((task) => task.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id)
    );
  const conversations = [
    ...new Map(
      [...tasks, ...(currentTask ? [currentTask] : [])].map((task) => [task.id, task])
    ).values()
  ].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id)
  );
  const openProcesses = () => {
    if (fileNavigationBlocked()) return;
    setSurfaceLocation({ panel: 'tools', tool: 'processes' });
  };
  return (
    <section
      className={`project-space desk-project project-view-work${taskId ? ' has-conversation' : ''}${docked && view !== 'work' ? ' has-docked-panel' : ''}`}
    >
      <header className="project-space-header">
        <Button className="project-back" aria-label="All projects" onClick={onAllProjects}>
          <ArrowLeft size={15} />
        </Button>
        <div className="project-space-title">
          <div className="eyebrow">Project</div>
          <h1 aria-label={project.title}>
            <button
              className="project-overview-link"
              title={project.title}
              aria-label={`${project.title} · Project overview`}
              aria-current={!taskId ? 'page' : undefined}
              onClick={() => {
                if (!fileNavigationBlocked()) onOverview();
              }}
            >
              {project.title}
            </button>
          </h1>
          <p>
            {projectStatus(project)} <span>· {money(project.spentUsd)} spent</span>
          </p>
          <label className="project-conversation-switcher">
            <span className="sr-only">Current conversation</span>
            <select
              aria-label="Current conversation"
              value={taskId ?? ''}
              onChange={(event) => {
                if (fileNavigationBlocked()) return;
                if (event.target.value) onTask(event.target.value);
              }}
            >
              <option value="" disabled>
                Open a conversation…
              </option>
              {conversations.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title === project.title ? 'Main conversation' : task.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row">
          <Button
            className="project-new-conversation"
            aria-label="New conversation"
            onClick={() => onNewConversation(project)}
          >
            <MessageSquarePlus size={16} />
            <span className="project-new-label">New conversation</span>
          </Button>
          <Button
            aria-label="Project settings"
            onClick={() => {
              setDraft({ title: project.title, brief: project.brief, revision: project.revision });
              setSettings(true);
            }}
          >
            <Settings2 size={17} />
          </Button>
        </div>
      </header>
      <div className="project-workspace-bar">
        <nav className="project-conversation-tabs" aria-label="Project conversations">
          <Button
            aria-current={!taskId ? 'page' : undefined}
            onClick={() => {
              if (!fileNavigationBlocked()) onOverview();
            }}
          >
            Overview
          </Button>
          {conversations.map((conversation) => (
            <Button
              key={conversation.id}
              aria-current={taskId === conversation.id ? 'page' : undefined}
              title={conversation.title}
              onClick={() => {
                if (!fileNavigationBlocked()) onTask(conversation.id);
              }}
            >
              {conversation.title === project.title ? 'Main conversation' : conversation.title}
            </Button>
          ))}
          {cursor && <Button onClick={() => selectView('activity')}>All conversations</Button>}
        </nav>
        {!wide && (
          <Suspense fallback={null}>
            <ProjectJobsLink projectId={projectId} onOpen={openProcesses} />
          </Suspense>
        )}
        <ProjectPanelLinks />
      </div>
      <ErrorNotice context="Could not refresh this project." error={error} />
      <div className={`project-view-content${wide ? ' desk-with-support' : ''}`}>
        <div className="desk-work-card">
          {taskId ? (
            <div className="project-conversation">
              <Suspense fallback={<Spinner label="Opening conversation…" />}>{children}</Suspense>
            </div>
          ) : (
            <div className="project-overview project-view-work">
              {!archived && tasks.some((task) => needsAttention(task) || hasOngoingWork(task)) && (
                <section aria-label="Current work" className="project-current-work">
                  <h2>Current work</h2>
                  <ScrollRegion label="Current project work">
                    <div className="project-conversation-grid">
                      {tasks
                        .filter((task) => needsAttention(task) || hasOngoingWork(task))
                        .map((task) => (
                          <button key={task.id} onClick={() => onTask(task.id)}>
                            <StatusSprite stage={stageOf(task)} />
                            <span>
                              <strong>{task.title}</strong>
                              <small>{taskStatusLabel(task)}</small>
                            </span>
                          </button>
                        ))}
                    </div>
                  </ScrollRegion>
                </section>
              )}
              {!archived && (
                <section aria-label="Project results">
                  <h2>Results</h2>
                  {tasks
                    .slice()
                    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                    .slice(0, 4)
                    .map((task) => (
                      <ConversationResults
                        key={task.id}
                        task={task}
                        onOpen={() => onTask(task.id)}
                        onDiscuss={(source) => onNewConversation(project, source)}
                      />
                    ))}
                  {tasks.length > 4 && (
                    <p className="muted">
                      Recent conversation results are shown here. Open any conversation for its
                      complete results.
                    </p>
                  )}
                </section>
              )}
              {project.brief && (
                <details className="project-brief">
                  <summary>Project brief</summary>
                  <p>{project.brief}</p>
                </details>
              )}
            </div>
          )}
        </div>
        {wide && (
          <Suspense fallback={null}>
            <DeskSupport
              project={project}
              {...(taskId ? { taskId } : {})}
              tasks={conversations}
              onTask={onTask}
              onProcesses={openProcesses}
            />
          </Suspense>
        )}
      </div>
      {!taskId && (
        <ProjectPanel scope={project.title}>
          {view === 'activity' && (
            <>
              <Suspense fallback={<Spinner />}>
                <ProjectUpdates projectId={project.id} tasks={tasks} onTask={onTask} />
                <ProjectNotes projectId={project.id} revision={project.updatedAt} onTask={onTask} />
              </Suspense>
              <section aria-label="Conversations">
                <div className="project-section-heading">
                  <h2>Conversations</h2>
                  <label>
                    <input
                      type="checkbox"
                      checked={archived}
                      onChange={(event) => setArchived(event.target.checked)}
                    />{' '}
                    Archived
                  </label>
                </div>
                <input
                  className="project-conversation-search"
                  aria-label="Find a conversation"
                  placeholder={cursor ? 'Find in loaded conversations…' : 'Find a conversation…'}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <ScrollRegion label="Project conversations" resetKey={`${archived}/${query}`}>
                  <div className="project-conversation-grid" ref={conversationGrid}>
                    {visible.map((task) => (
                      <button key={task.id} data-task-id={task.id} onClick={() => onTask(task.id)}>
                        <StatusSprite stage={stageOf(task)} />
                        <span>
                          <strong>{task.title}</strong>
                          <small>
                            {taskStatusLabel(task)} · {money(task.spentUsd)}
                          </small>
                          {changeSummary(changes[task.id]) && (
                            <small
                              title={`Compared with this conversation's last published or checked-out files. Large files, binary data and dependency environments are excluded from line counts.${changes[task.id]?.measurement ? ` Measured ${new Date(changes[task.id]!.measurement!.observedAt).toLocaleString()}.` : ''}`}
                            >
                              {changeSummary(changes[task.id])}
                            </small>
                          )}
                          {task.activity && (
                            <>
                              <small className="project-activity-detail">
                                {task.activity.currentStep ?? task.activity.latest}
                              </small>
                              <small>
                                {task.activity.stepsTotal > 0 &&
                                  `Plan: ${task.activity.stepsCompleted} of ${task.activity.stepsTotal} marked complete · `}
                                {task.activity.observedAt &&
                                  `Last activity ${new Date(task.activity.observedAt).toLocaleTimeString()}`}
                              </small>
                            </>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                </ScrollRegion>
                {!visible.length && (
                  <p className="muted">
                    {query
                      ? 'No matching conversations in this list.'
                      : archived
                        ? 'No archived conversations.'
                        : 'Start a conversation to explore another aspect of this project.'}
                  </p>
                )}
                {cursor && (
                  <Button aria-busy={busy} aria-disabled={busy} onClick={() => void more()}>
                    {busy ? 'Loading conversations…' : 'More conversations'}
                  </Button>
                )}
              </section>
            </>
          )}
          {filesOpened && (
            <div hidden={view !== 'files'}>
              <Suspense fallback={<Spinner />}>
                <DirectoryPanel embedded projectId={project.id} openRequest={1} />
              </Suspense>
            </div>
          )}
          {view === 'tools' && (
            <Suspense fallback={<Spinner />}>
              <ProjectSessions projectId={project.id} onOpen={onComputer} />
              <ProcessPanel workspaceId={project.workspaceId} projectId={project.id} />
              <p className="muted">
                Choose a conversation above to open its terminal, browser or desktop. Each
                conversation keeps its own working copy and sessions.
              </p>
            </Suspense>
          )}
        </ProjectPanel>
      )}
      {settings && (
        <Dialog title="Project settings" onClose={() => setSettings(false)}>
          <div className="stack">
            <form
              className="stack"
              onSubmit={(event) => {
                event.preventDefault();
                if (draft) void save({ title: draft.title, brief: draft.brief });
              }}
            >
              <Field label="Project name">
                <input
                  value={draft?.title ?? project.title}
                  maxLength={160}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...(current ?? { brief: project.brief, revision: project.revision }),
                      title: event.target.value
                    }))
                  }
                />
              </Field>
              <Field label="Shared project brief">
                <textarea
                  rows={6}
                  value={draft?.brief ?? project.brief}
                  maxLength={20000}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...(current ?? { title: project.title, revision: project.revision }),
                      brief: event.target.value
                    }))
                  }
                />
              </Field>
              <p className="muted">
                Conversations use this brief as project context. Your current direction controls
                their work.
              </p>
              <Button type="submit" className="primary" busy={busy}>
                Save project
              </Button>
            </form>
            <Field label="Default autonomy for new conversations">
              <select
                value={project.securityMode}
                aria-describedby={permissionHelpId}
                disabled={busy}
                onChange={(event) => void save({ securityMode: event.target.value })}
              >
                <option value="review">Review</option>
                <option value="balanced">Balanced</option>
                <option value="autonomous">Autonomous</option>
              </select>
            </Field>
            <details>
              <summary>What this mode allows</summary>
              <p id={permissionHelpId}>{permissionModeSummary(project.securityMode)}</p>
            </details>
            <div className="row">
              <Button busy={busy} onClick={() => void save({ pinned: !project.pinned })}>
                {project.pinned ? 'Unpin project' : 'Pin project'}
              </Button>
              <Button busy={busy} onClick={() => void save({ archived: !project.archivedAt })}>
                {project.archivedAt ? 'Restore project' : 'Archive project'}
              </Button>
            </div>
            <Suspense fallback={<Spinner />}>
              <ProjectModels projectId={project.id} />
            </Suspense>
            <ErrorNotice context="Could not refresh this project." error={error} />
          </div>
        </Dialog>
      )}
    </section>
  );
}
