import { useState, type ReactNode } from 'react';
import { ArrowUpRight, Clock3, Plus } from './icons';
import type { Project, Task, Workspace } from '@garden/contracts';
import type { Bootstrap } from './model';
import {
  bytes,
  dollarsLeft,
  hasOngoingWork,
  money,
  needsAttention,
  shortDate,
  taskStatusLabel
} from './model';
import ScrollRegion from './ScrollRegion';
import StatusSprite, { projectStage, stageOf } from './life/StatusSprite';
import { Button } from './ui';
import './home.css';

/** A row of blocks, filled in proportion: the save bar every meter on this screen is drawn as. */
function Blocks({ value, total, count = 10 }: { value: number; total: number; count?: number }) {
  const filled = total > 0 ? Math.round((Math.min(value, total) / total) * count) : 0;
  return (
    <span className="blocks" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <i key={index} className={index < filled ? 'is-on' : ''} />
      ))}
    </span>
  );
}

function Meter({
  label,
  value,
  total,
  text,
  title,
  className = ''
}: {
  label: string;
  value: number;
  /** Null when only the amount left is known, so there is nothing to fill a bar against. */
  total: number | null;
  text: string;
  title?: string;
  className?: string;
}) {
  return (
    <div
      className={`meter ${className}`}
      role="meter"
      aria-label={title ?? label}
      aria-valuenow={value}
      aria-valuemin={0}
      {...(total === null ? {} : { 'aria-valuemax': total })}
      title={title}
    >
      <span>{label}</span>
      {total !== null && <Blocks value={value} total={total} />}
      <small>{text}</small>
    </div>
  );
}

const DAY = 86_400_000;
function until(iso: string) {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms < 60_000) return 'now';
  if (ms < 3_600_000) return `in ${Math.round(ms / 60_000)}m`;
  if (ms < DAY) return `in ${Math.round(ms / 3_600_000)}h`;
  return `in ${Math.round(ms / DAY)}d`;
}

/**
 * Home fits the screen and only its cards scroll. The prompt sits beside the computer it runs on;
 * under them, your projects as tiles - each a small plant with its steps as a meter - and a Today
 * column in the order you act: what needs you, what is growing, what is ready, what runs next.
 */
export default function DeskHome({
  projects,
  tasks,
  composer,
  notice,
  bootstrap,
  workspace,
  onTask,
  onProject,
  onProjects,
  onAttention,
  onAutomations,
  onComputer,
  onNew
}: {
  projects: Project[];
  tasks: Task[];
  composer: ReactNode;
  notice?: ReactNode;
  bootstrap: Bootstrap;
  workspace: Workspace | null;
  onTask: (id: string) => void;
  onProject: (id: string) => void;
  onProjects: () => void;
  onAttention: () => void;
  onAutomations: () => void;
  onComputer: () => void;
  onNew: () => void;
}) {
  const recent = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const attention = recent.filter(needsAttention);
  const growing = recent.filter((task) => hasOngoingWork(task) && !needsAttention(task));
  // The latest finished conversation of each project, so a busy project is listed once.
  const ready = recent
    .filter(
      (task, index) =>
        task.status === 'completed' &&
        !needsAttention(task) &&
        recent.findIndex((other) => other.projectId === task.projectId) === index
    )
    .slice(0, 6);
  const upcoming = [...(bootstrap.schedules ?? [])]
    .filter((schedule) => schedule.enabled && schedule.nextRunAt)
    .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))
    .slice(0, 4);
  const projectTitle = (task: Task) =>
    projects.find((project) => project.id === task.projectId)?.title ?? task.title;
  const latestOf = (project: Project) => tasks.find((task) => task.id === project.latestTaskId);
  const sortedProjects = [...projects].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt)
  );
  // Fourteen days of activity, one column a day, from the work this device has loaded.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 14 }, (_, index) => {
    const start = today.getTime() - (13 - index) * DAY;
    const count = tasks.filter((task) => {
      const at = Date.parse(task.updatedAt);
      return at >= start && at < start + DAY;
    }).length;
    return { start, count };
  });
  const busiest = Math.max(1, ...days.map((day) => day.count));
  const computer = bootstrap.computer;
  const providerWindows = bootstrap.usage.plan?.windows ?? [];
  const diskUsed =
    workspace?.hostStorageTotalBytes && workspace.hostStorageAvailableBytes !== undefined
      ? workspace.hostStorageTotalBytes - workspace.hostStorageAvailableBytes
      : null;
  const [shown, setShown] = useState<'today' | 'projects'>(() =>
    attention.length || growing.length ? 'today' : 'projects'
  );
  const row = (task: Task, detail: ReactNode, meter?: ReactNode) => (
    <button
      type="button"
      className="home-row cursor-row"
      key={task.id}
      onClick={() => onTask(task.id)}
    >
      <StatusSprite stage={stageOf(task)} />
      <span>
        <strong>{projectTitle(task)}</strong>
        <small>{detail}</small>
        {meter}
      </span>
    </button>
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
      <button type="button" className="home-machine" onClick={onComputer} data-perch>
        <strong className="home-machine-title">
          <i
            className={growing.length ? 'home-pulse is-working' : 'home-pulse'}
            aria-hidden="true"
          />
          {workspace?.name ?? 'Your computer'} ·{' '}
          {growing.length ? `working on ${growing.length}` : (workspace?.status ?? 'idle')}
        </strong>
        <span className="home-machine-readout">
          {computer ? (
            <>
              <Meter
                label="CPU"
                value={computer.cpuPercent}
                total={100}
                text={`${computer.cpuPercent}%`}
              />
              <Meter
                label="RAM"
                value={computer.memoryUsedBytes}
                total={computer.memoryTotalBytes}
                text={bytes(computer.memoryUsedBytes)}
              />
            </>
          ) : (
            <small>Load unavailable</small>
          )}
          {diskUsed !== null && workspace?.hostStorageTotalBytes && (
            <Meter
              label="Disk"
              value={diskUsed}
              total={workspace.hostStorageTotalBytes}
              text={`${bytes(workspace.hostStorageAvailableBytes!)} free`}
            />
          )}
          {providerWindows.map((window, index) => {
            const left = dollarsLeft(window);
            const period = window.label.startsWith('Session')
              ? 'Session'
              : window.label.startsWith('Weekly')
                ? 'Week'
                : window.label === 'Credit balance'
                  ? 'Balance'
                  : window.label === 'Key limit'
                    ? 'Key'
                    : window.label;
            const label = `${window.connection ?? bootstrap.usage.plan!.provider} · ${period}`;
            const text =
              window.unit === 'usd'
                ? left !== null
                  ? `${money(left)} left`
                  : window.used !== null
                    ? `${money(window.used)} used`
                    : 'Unavailable'
                : window.used !== null
                  ? `${Math.round(window.used * 100)}% used`
                  : 'Unavailable';
            const value = window.unit === 'usd' ? (left ?? window.used) : window.used;
            return value === null ? (
              <span key={index} className="meter meter-provider" title={label}>
                <span>{label}</span>
                <small>{text}</small>
              </span>
            ) : (
              <Meter
                key={index}
                className="meter-provider"
                label={label}
                value={value}
                total={window.unit === 'usd' ? window.limit : 1}
                text={text}
                title={`${label}: ${text}${window.resetsAt ? `, resets ${new Date(window.resetsAt).toLocaleString()}` : ''}`}
              />
            );
          })}
        </span>
      </button>
      <nav className="home-switcher" aria-label="Home lists">
        {(
          [
            ['today', `Today${attention.length ? ` · ${attention.length}` : ''}`],
            ['projects', 'Projects']
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
      <section
        className="desk-card home-projects desk-recent"
        aria-labelledby="home-recent"
        data-perch
      >
        <header className="desk-card-heading">
          <h2 id="home-recent">Projects · {projects.length}</h2>
          <span
            className="home-activity"
            role="img"
            aria-label="Activity over the last fourteen days"
          >
            {days.map((day) => (
              <i
                key={day.start}
                title={`${new Date(day.start).toLocaleDateString()}: ${day.count} updated`}
                style={{ height: `${Math.max(2, Math.round((day.count / busiest) * 16))}px` }}
                className={day.count ? 'is-on' : ''}
              />
            ))}
          </span>
          <Button onClick={onProjects}>
            All <ArrowUpRight size={14} />
          </Button>
        </header>
        <ScrollRegion label="Recent projects" className="desk-card-scroll">
          <div className="project-tiles">
            {sortedProjects.map((project) => {
              const latest = latestOf(project);
              const activity = latest?.activity;
              return (
                <button
                  type="button"
                  className="project-tile"
                  key={project.id}
                  onClick={() => onProject(project.id)}
                >
                  <StatusSprite stage={projectStage(project, latest)} scale={3} />
                  <span>
                    <strong>{project.title}</strong>
                    <small>
                      {latest
                        ? (activity?.currentStep ?? activity?.latest ?? taskStatusLabel(latest))
                        : `${project.conversationCount} conversations`}
                    </small>
                    {activity && activity.stepsTotal > 0 && (
                      <span className="tile-steps">
                        <Blocks
                          value={activity.stepsCompleted}
                          total={activity.stepsTotal}
                          count={Math.min(activity.stepsTotal, 10)}
                        />
                        <small>
                          {activity.stepsCompleted}/{activity.stepsTotal}
                        </small>
                      </span>
                    )}
                    <small className="tile-meta">
                      {project.conversationCount}{' '}
                      {project.conversationCount === 1 ? 'conversation' : 'conversations'} ·{' '}
                      {money(project.spentUsd)} · {shortDate(project.updatedAt)}
                    </small>
                  </span>
                </button>
              );
            })}
            <button type="button" className="project-tile project-tile-new" onClick={onNew}>
              <Plus size={18} />
              <span>New project</span>
            </button>
          </div>
        </ScrollRegion>
      </section>
      <section className="desk-card home-today" aria-labelledby="home-today" data-perch>
        <header className="desk-card-heading">
          <h2 id="home-today">Today</h2>
          {attention.length > 0 && (
            <Button onClick={onAttention}>
              Needs you · {attention.length} <ArrowUpRight size={14} />
            </Button>
          )}
        </header>
        <ScrollRegion label="Today" className="desk-card-scroll">
          <h3 className="home-divider">Needs you</h3>
          {attention.map((task) =>
            row(
              task,
              <>
                {task.hasOpenQuestion ? 'Answer a question' : taskStatusLabel(task)}
                {task.activity?.latest ? ` · ${task.activity.latest}` : ''}
              </>
            )
          )}
          {!attention.length && <p className="home-quiet">Nothing needs you.</p>}
          <h3 className="home-divider">Growing</h3>
          {growing.map((task) =>
            row(
              task,
              task.activity?.currentStep ?? task.activity?.latest ?? taskStatusLabel(task),
              task.activity && task.activity.stepsTotal > 0 ? (
                <span className="tile-steps">
                  <Blocks
                    value={task.activity.stepsCompleted}
                    total={task.activity.stepsTotal}
                    count={Math.min(task.activity.stepsTotal, 10)}
                  />
                  <small>
                    {task.activity.stepsCompleted}/{task.activity.stepsTotal}
                  </small>
                </span>
              ) : undefined
            )
          )}
          {!growing.length && <p className="home-quiet">Nothing is running.</p>}
          {ready.length > 0 && <h3 className="home-divider">Ready</h3>}
          {ready.map((task) =>
            row(
              task,
              <>
                {task.activity?.latest ?? taskStatusLabel(task)} · {shortDate(task.updatedAt)}
              </>
            )
          )}
          <h3 className="home-divider">Next up</h3>
          {upcoming.map((schedule) => (
            <button
              type="button"
              className="home-row cursor-row"
              key={schedule.id}
              onClick={onAutomations}
            >
              <Clock3 size={16} />
              <span>
                <strong>{schedule.title}</strong>
                <small>{until(schedule.nextRunAt!)}</small>
              </span>
            </button>
          ))}
          {!upcoming.length && (
            <button type="button" className="home-quiet home-link" onClick={onAutomations}>
              No automations scheduled. Set one up
            </button>
          )}
        </ScrollRegion>
      </section>
    </section>
  );
}
