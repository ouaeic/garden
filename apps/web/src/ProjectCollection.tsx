import ScrollRegion from './ScrollRegion';
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Pin } from './icons';
import type { Project, Task } from '@garden/contracts';
import { get } from './client';
import { ProjectLink } from './ProjectLink';
import { money } from './model';
import { Button, ErrorNotice } from './ui';
import './projects.css';
import StatusSprite from './life/StatusSprite';

export const projectStatus = (project: Project) =>
  [
    project.activeCount ? `${project.activeCount} working` : '',
    project.attentionCount
      ? `${project.attentionCount} ${project.attentionCount === 1 ? 'needs' : 'need'} attention`
      : ''
  ]
    .filter(Boolean)
    .join(' · ') ||
  `${project.conversationCount} conversation${project.conversationCount === 1 ? '' : 's'}`;

function ConversationLinks({
  projectId,
  currentTaskId,
  onTask
}: {
  projectId: string;
  currentTaskId: string | null;
  onTask: (id: string) => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void get<{ tasks: Task[]; nextCursor: string | null }>(
      `/v1/projects/${projectId}/conversations?archived=false`,
      { signal: controller.signal }
    )
      .then((page) => {
        if (!controller.signal.aborted) {
          setTasks(page.tasks);
          setCursor(page.nextCursor);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      });
    return () => controller.abort();
  }, [projectId, currentTaskId]);
  async function more() {
    if (!cursor || busy) return;
    setBusy(true);
    try {
      const page = await get<{ tasks: Task[]; nextCursor: string | null }>(
        `/v1/projects/${projectId}/conversations?before=${cursor}&archived=false`
      );
      setTasks((rows) => [...rows, ...page.tasks]);
      setCursor(page.nextCursor);
      setError(null);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="project-conversation-links">
      {[...tasks]
        .sort(
          (a, b) =>
            Number(b.pinned) - Number(a.pinned) ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.id.localeCompare(b.id)
        )
        .map((task) => (
          <ProjectLink
            key={task.id}
            task={task}
            current={task.id === currentTaskId}
            onOpen={onTask}
          />
        ))}
      {cursor && (
        <Button busy={busy} onClick={() => void more()}>
          More conversations
        </Button>
      )}
      <ErrorNotice error={error} />
    </div>
  );
}

export default function ProjectCollection({
  initial,
  cursor: initialCursor,
  currentProjectId,
  currentTaskId,
  onProject,
  onTask,
  search = '',
  mode = 'sidebar',
  filter = 'active',
  workspaceId
}: {
  initial: Project[];
  cursor: string | null;
  currentProjectId: string | null;
  currentTaskId: string | null;
  onProject: (id: string) => void;
  onTask: (id: string) => void;
  search?: string;
  mode?: 'sidebar' | 'grid';
  filter?: 'active' | 'running' | 'complete' | 'archived';
  workspaceId: string;
}) {
  const [extra, setExtra] = useState<Project[]>([]),
    [cursor, setCursor] = useState(initialCursor),
    [archived, setArchived] = useState<Project[]>([]),
    [expanded, setExpanded] = useState<string | null>(currentProjectId),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (filter !== 'archived') setCursor(initialCursor);
  }, [initialCursor, filter]);
  useEffect(() => {
    if (currentProjectId) setExpanded(currentProjectId);
  }, [currentProjectId]);
  useEffect(() => {
    if (filter !== 'archived') return;
    const controller = new AbortController();
    void get<{ projects: Project[]; nextCursor: string | null }>('/v1/projects?archived=true', {
      signal: controller.signal
    })
      .then((page) => {
        if (!controller.signal.aborted) {
          setArchived(page.projects);
          setCursor(page.nextCursor);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      });
    return () => controller.abort();
  }, [filter]);
  async function more() {
    if (!cursor || busy) return;
    setBusy(true);
    try {
      const page = await get<{ projects: Project[]; nextCursor: string | null }>(
        `/v1/projects?before=${cursor}&archived=${filter === 'archived'}`
      );
      if (filter === 'archived') setArchived((rows) => [...rows, ...page.projects]);
      else setExtra((rows) => [...rows, ...page.projects]);
      setCursor(page.nextCursor);
      setError(null);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  const projects = [
    ...new Map(
      (filter === 'archived' ? archived : [...extra, ...initial]).map((project) => [
        project.id,
        project
      ])
    ).values()
  ]
    .filter(
      (project) =>
        project.parentWorkspaceId === workspaceId &&
        project.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()) &&
        (filter !== 'running' || project.activeCount > 0) &&
        (filter !== 'complete' || (!project.activeCount && !project.attentionCount))
    )
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  const cards = (
    <>
      {projects.map((project) => (
        <div
          key={project.id}
          className={mode === 'grid' ? 'project-summary-card' : 'project-navigation-item'}
        >
          <div className="project-navigation-row">
            {mode === 'sidebar' && (
              <button
                className="project-expand"
                aria-label={`${expanded === project.id ? 'Collapse' : 'Expand'} ${project.title}`}
                aria-expanded={expanded === project.id}
                onClick={() => setExpanded(expanded === project.id ? null : project.id)}
              >
                {expanded === project.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            )}
            <button
              className="project-open cursor-row"
              aria-current={currentProjectId === project.id && !currentTaskId ? 'page' : undefined}
              onClick={() => onProject(project.id)}
            >
              <StatusSprite
                stage={project.attentionCount ? 'needs' : project.activeCount ? 'sprout' : 'bloom'}
              />
              <span>
                <strong>{project.title}</strong>
                {mode === 'grid' && (project.activeCount > 0 || project.attentionCount > 0) && (
                  <small>{projectStatus(project)}</small>
                )}
              </span>
              {project.pinned && <Pin size={13} />}
            </button>
          </div>
          {mode === 'grid' ? (
            <p className="project-card-meta">
              {project.conversationCount}{' '}
              {project.conversationCount === 1 ? 'conversation' : 'conversations'}{' '}
              <span>{money(project.spentUsd)} spent</span>
            </p>
          ) : (
            expanded === project.id && (
              <ConversationLinks
                key={project.id}
                projectId={project.id}
                currentTaskId={currentTaskId}
                onTask={onTask}
              />
            )
          )}
        </div>
      ))}
    </>
  );
  return (
    <div className={mode === 'grid' ? 'project-collection' : 'project-navigation'}>
      {mode === 'grid' ? (
        <ScrollRegion label="Projects" resetKey={`${filter}/${search}`}>
          <div className="project-grid">{cards}</div>
        </ScrollRegion>
      ) : (
        cards
      )}
      {!projects.length && (
        <p className="muted">
          {search ? 'No loaded projects match this search.' : 'Projects will appear here.'}
        </p>
      )}
      {cursor && (
        <Button busy={busy} onClick={() => void more()}>
          More projects
        </Button>
      )}
      <ErrorNotice error={error} />
    </div>
  );
}
