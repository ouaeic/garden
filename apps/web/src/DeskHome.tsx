import type { ReactNode } from 'react';
import { ArrowUpRight, Plus } from './icons';
import type { Project, Task } from '@garden/contracts';
import { hasOngoingWork, needsAttention, shortDate, taskStatusLabel } from './model';
import GardenPlot, { projectStage } from './life/GardenPlot';
import StatusSprite, { stageOf } from './life/StatusSprite';
import { Button } from './ui';
import './home.css';

/**
 * Home is the garden: your projects as plants, a prompt to plant the next one, and three short
 * lists in the order you act on them — what needs you, what is growing, where you were.
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
  const finished = recent.find((task) => task.status === 'completed' && !needsAttention(task));
  const projectTitle = (task: Task) =>
    projects.find((project) => project.id === task.projectId)?.title ?? task.title;
  const sortedProjects = [...projects].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt)
  );
  return (
    <section className="desk-home" aria-label="Home">
      <GardenPlot projects={projects} tasks={tasks} onProject={onProject} />
      <section className="desk-start-card" aria-label="Start a project" data-perch>
        {notice}
        {composer}
      </section>
      <div className="home-lists">
        <section className="desk-card home-card" aria-labelledby="home-needs" data-perch>
          <header className="desk-card-heading">
            <h2 id="home-needs">Needs you{attention.length ? ` · ${attention.length}` : ''}</h2>
            {attention.length > 0 && (
              <Button onClick={onAttention}>
                All <ArrowUpRight size={14} />
              </Button>
            )}
          </header>
          <div className="home-card-list">
            {attention.slice(0, 5).map((task) => (
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
          </div>
        </section>
        <section className="desk-card home-card" aria-labelledby="home-growing" data-perch>
          <header className="desk-card-heading">
            <h2 id="home-growing">Growing{growing.length ? ` · ${growing.length}` : ''}</h2>
          </header>
          <div className="home-card-list">
            {growing.slice(0, 5).map((task) => (
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
            {!growing.length && finished && (
              <button
                type="button"
                className="home-row cursor-row"
                onClick={() => onTask(finished.id)}
              >
                <StatusSprite stage="bloom" />
                <span>
                  <strong>{projectTitle(finished)}</strong>
                  <small>Ready · finished {shortDate(finished.updatedAt)}</small>
                </span>
              </button>
            )}
            {!growing.length && !finished && (
              <p className="home-quiet">Nothing is running. Plant something above.</p>
            )}
          </div>
        </section>
        <section
          className="desk-card home-card desk-recent"
          aria-labelledby="home-recent"
          data-perch
        >
          <header className="desk-card-heading">
            <h2 id="home-recent">Recent projects</h2>
            <Button onClick={onProjects}>
              All projects <ArrowUpRight size={14} />
            </Button>
          </header>
          <div className="home-card-list">
            {sortedProjects.slice(0, 6).map((project) => (
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
          </div>
        </section>
      </div>
    </section>
  );
}
