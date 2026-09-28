import { useState, type ReactNode } from 'react';
import { ArrowUpRight, Plus } from './icons';
import type { Project, Task } from '@garden/contracts';
import { hasOngoingWork, needsAttention, shortDate, taskStatusLabel } from './model';
import ScrollRegion from './ScrollRegion';
import StatusSprite, { projectStage, stageOf } from './life/StatusSprite';
import { Button } from './ui';
import './home.css';

/**
 * Home is the prompt and three lists in the order you act on them: what needs you, what is
 * growing, where you were. It fits the screen; only the lists scroll, and on a phone one list at a
 * time takes the remaining height.
 */
export default function DeskHome({
  projects,
  tasks,
  composer,
  notice,
  onTask,
  onProject,
  onProjects,
  onAttention,
  onNew
}: {
  projects: Project[];
  tasks: Task[];
  composer: ReactNode;
  notice?: ReactNode;
  onTask: (id: string) => void;
  onProject: (id: string) => void;
  onProjects: () => void;
  onAttention: () => void;
  onNew: () => void;
}) {
  const recent = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const attention = recent.filter(needsAttention);
  const growing = recent.filter((task) => hasOngoingWork(task) && !needsAttention(task));
  // The latest finished conversation of each project, so a busy project is listed once.
  const ready = recent.filter(
    (task, index) =>
      task.status === 'completed' &&
      !needsAttention(task) &&
      recent.findIndex((other) => other.projectId === task.projectId) === index
  );
  const projectTitle = (task: Task) =>
    projects.find((project) => project.id === task.projectId)?.title ?? task.title;
  const sortedProjects = [...projects].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt)
  );
  const [shown, setShown] = useState<'needs' | 'growing' | 'recent'>(() =>
    attention.length ? 'needs' : growing.length ? 'growing' : 'recent'
  );
  return (
    <section className="desk-home" aria-labelledby="home-title" data-home-card={shown}>
      <h1 id="home-title" className="sr-only">
        Home
      </h1>
      <section className="desk-start-card" aria-label="Start a project" data-perch>
        {notice}
        {composer}
      </section>
      <nav className="home-switcher" aria-label="Home lists">
        {(
          [
            ['needs', `Needs you${attention.length ? ` · ${attention.length}` : ''}`],
            ['growing', `Growing${growing.length ? ` · ${growing.length}` : ''}`],
            ['recent', 'Recent']
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            key={value}
            aria-pressed={shown === value}
            onClick={() => setShown(value)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="home-lists">
        <section className="desk-card home-card home-needs" aria-labelledby="home-needs" data-perch>
          <header className="desk-card-heading">
            <h2 id="home-needs">Needs you{attention.length ? ` · ${attention.length}` : ''}</h2>
            {attention.length > 0 && (
              <Button onClick={onAttention}>
                All <ArrowUpRight size={14} />
              </Button>
            )}
          </header>
          <ScrollRegion label="Work that needs you" className="desk-card-scroll">
            {attention.map((task) => (
              <button
                type="button"
                className="home-row cursor-row"
                key={task.id}
                onClick={() => onTask(task.id)}
              >
                <StatusSprite stage={stageOf(task)} />
                <span>
                  <strong>{projectTitle(task)}</strong>
                  <small>
                    {task.hasOpenQuestion ? 'Answer a question' : taskStatusLabel(task)}
                    {task.activity?.latest ? ` · ${task.activity.latest}` : ''}
                  </small>
                </span>
              </button>
            ))}
            {!attention.length && <p className="home-quiet">Nothing needs you right now.</p>}
          </ScrollRegion>
        </section>
        <section
          className="desk-card home-card home-growing"
          aria-labelledby="home-growing"
          data-perch
        >
          <header className="desk-card-heading">
            <h2 id="home-growing">Growing{growing.length ? ` · ${growing.length}` : ''}</h2>
          </header>
          <ScrollRegion label="Work in progress" className="desk-card-scroll">
            {growing.map((task) => (
              <button
                type="button"
                className="home-row cursor-row"
                key={task.id}
                onClick={() => onTask(task.id)}
              >
                <StatusSprite stage={stageOf(task)} />
                <span>
                  <strong>{projectTitle(task)}</strong>
                  <small>
                    {task.activity?.currentStep ?? task.activity?.latest ?? taskStatusLabel(task)}
                  </small>
                </span>
              </button>
            ))}
            {ready.length > 0 && <h3 className="home-divider">Ready</h3>}
            {ready.map((task) => (
              <button
                type="button"
                className="home-row cursor-row"
                key={task.id}
                onClick={() => onTask(task.id)}
              >
                <StatusSprite stage={stageOf(task)} />
                <span>
                  <strong>{projectTitle(task)}</strong>
                  <small>
                    {task.activity?.latest ?? taskStatusLabel(task)} · {shortDate(task.updatedAt)}
                  </small>
                </span>
              </button>
            ))}
            {!growing.length && !ready.length && (
              <p className="home-quiet">Nothing is running. Start something above.</p>
            )}
          </ScrollRegion>
        </section>
        <section
          className="desk-card home-card home-recent desk-recent"
          aria-labelledby="home-recent"
          data-perch
        >
          <header className="desk-card-heading">
            <h2 id="home-recent">Recent projects</h2>
            <Button onClick={onProjects}>
              All projects <ArrowUpRight size={14} />
            </Button>
          </header>
          <ScrollRegion label="Recent projects" className="desk-card-scroll">
            {sortedProjects.map((project) => (
              <button
                type="button"
                className="home-row desk-project-row cursor-row"
                key={project.id}
                onClick={() => onProject(project.id)}
              >
                <StatusSprite
                  stage={projectStage(
                    project,
                    tasks.find((task) => task.id === project.latestTaskId)
                  )}
                />
                <span>
                  <strong>{project.title}</strong>
                  <small>
                    {project.conversationCount}{' '}
                    {project.conversationCount === 1 ? 'conversation' : 'conversations'}
                  </small>
                </span>
                <time dateTime={project.updatedAt}>{shortDate(project.updatedAt)}</time>
              </button>
            ))}
            {!projects.length && (
              <Button onClick={onNew}>
                <Plus size={16} />
                Start your first project
              </Button>
            )}
          </ScrollRegion>
        </section>
      </div>
    </section>
  );
}
