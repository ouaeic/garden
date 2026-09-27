import { useState, type ReactNode } from 'react';
import { ArrowRight, ArrowUpRight, Bell, FolderOpen, Plus } from 'lucide-react';
import type { Project, Task } from '@athanor/contracts';
import { hasOngoingWork, needsAttention, shortDate, taskStatusLabel } from './model';
import LivingBackdrop from './LivingBackdrop';
import ScrollRegion from './ScrollRegion';
import { Button } from './ui';

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
  const working = recent.filter(hasOngoingWork);
  const attention = recent.filter(needsAttention);
  const resume = working[0] ?? recent[0];
  const resumeProject = projects.find((project) => project.id === resume?.projectId);
  const updates = recent.filter((task) => !needsAttention(task));
  const [panel, setPanel] = useState('continue');
  const selected = !resume && panel === 'continue' ? 'new' : panel;
  const sortedProjects = [...projects].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt)
  );
  return (
    <section className={`desk-home${resume ? '' : ' is-empty'}`} data-home-panel={selected}>
      <div className="desk-home-intro">
        <header>
          <p className="eyebrow">Your garden</p>
          <h1>
            Space for your <em>next idea.</em>
          </h1>
          <p className="muted">
            {resume
              ? 'Your work is here. Pick up where you left off.'
              : 'Start with something you want to make or do.'}
          </p>
        </header>
        <section className="desk-start-card" aria-label="Start a project">
          <ScrollRegion label="New project prompt" className="desk-card-scroll">
            {notice}
            {composer}
          </ScrollRegion>
        </section>
      </div>
      <nav className="desk-home-switcher" aria-label="Home cards">
        {[
          ...(resume ? [['continue', 'Continue']] : []),
          ['new', 'New project'],
          ['attention', attention.length ? `Needs you · ${attention.length}` : 'Latest'],
          ['recent', 'Projects']
        ].map(([value, label]) => (
          <Button key={value} aria-pressed={selected === value} onClick={() => setPanel(value!)}>
            {label}
          </Button>
        ))}
      </nav>
      <div className="desk-home-middle">
        {resume ? (
          <section className="desk-resume-card" aria-label="Continue your work">
            <LivingBackdrop />
            <ScrollRegion label="Current project summary" className="desk-card-scroll">
              <span className="desk-resume-eyebrow eyebrow">
                <span className="desk-seed" aria-hidden="true" />
                Continue your work
              </span>
              <h2>{resumeProject?.title ?? resume.title}</h2>
              {(resume.activity?.currentStep ?? resume.activity?.latest) &&
                (resume.activity?.currentStep ?? resume.activity?.latest) !==
                  taskStatusLabel(resume) && (
                  <p>{resume.activity?.currentStep ?? resume.activity?.latest}</p>
                )}
            </ScrollRegion>
            <span className="desk-resume-status">
              <i className={`garden-project-dot status-${resume.status}`} />
              {taskStatusLabel(resume)}
              {working.length > 1 && ` · ${working.length} conversations working`}
            </span>
            <Button className="desk-resume-open" onClick={() => onTask(resume.id)}>
              <span>Open project</span>
              <span className="desk-resume-arrow" aria-hidden="true">
                <ArrowRight size={19} />
              </span>
            </Button>
          </section>
        ) : (
          <section className="desk-empty-card">
            <LivingBackdrop />
            <h2>A place for ideas to take shape.</h2>
            <p>
              Research, build, analyse, write. Your conversations, files, and results stay together.
            </p>
          </section>
        )}
        <section className="desk-card desk-home-attention" aria-label="Updates and next actions">
          <header className="desk-card-heading">
            <h2>Updates</h2>
            {attention.length > 0 && (
              <Button onClick={onAttention}>
                <Bell size={14} />
                Needs you · {attention.length}
              </Button>
            )}
          </header>
          <ScrollRegion label="Updates and next actions" className="desk-card-scroll">
            {attention.map((task) => {
              const title =
                projects.find((project) => project.id === task.projectId)?.title ?? task.title;
              const detail = task.activity?.latest;
              return (
                <button className="desk-action-row" key={task.id} onClick={() => onTask(task.id)}>
                  <span className="desk-action-copy">
                    <strong>{title}</strong>
                    <span className="desk-action-status">{taskStatusLabel(task)}</span>
                    {detail && detail !== title && detail !== taskStatusLabel(task) && (
                      <span>{detail}</span>
                    )}
                  </span>
                  <ArrowUpRight size={14} aria-hidden="true" />
                </button>
              );
            })}
            {updates.map((task) => (
              <button className="desk-update-row" key={task.id} onClick={() => onTask(task.id)}>
                <i className={`garden-project-dot status-${task.status}`} aria-hidden="true" />
                <span className="desk-update-copy">
                  <strong>{task.title}</strong>
                  <small>{task.activity?.latest ?? taskStatusLabel(task)}</small>
                  <time dateTime={task.updatedAt}>{shortDate(task.updatedAt)}</time>
                </span>
                <ArrowUpRight size={14} aria-hidden="true" />
              </button>
            ))}
            {!recent.length && (
              <div className="desk-empty-state">
                <p>Your work will appear here.</p>
                <span className="muted">Updates and finished work will appear here.</span>
              </div>
            )}
          </ScrollRegion>
        </section>
      </div>
      <div className="desk-home-bottom">
        <section className="desk-card desk-recent" aria-label="Recent projects">
          <header className="desk-card-heading">
            <h2>Recent projects</h2>
            <Button onClick={onProjects}>
              All projects <ArrowUpRight size={14} />
            </Button>
          </header>
          <ScrollRegion label="Recent projects" className="desk-card-scroll">
            {sortedProjects.map((project) => (
              <button
                className="desk-project-row"
                key={project.id}
                onClick={() => onProject(project.id)}
              >
                <span className="desk-project-icon" aria-hidden="true">
                  <FolderOpen size={19} strokeWidth={1.5} />
                </span>
                <span className="desk-project-copy">
                  <strong>{project.title}</strong>
                  <small>
                    {project.attentionCount
                      ? 'Needs your attention'
                      : project.activeCount
                        ? 'Work in progress'
                        : `${project.conversationCount} ${project.conversationCount === 1 ? 'conversation' : 'conversations'}`}
                  </small>
                </span>
                <time>{shortDate(project.updatedAt)}</time>
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
