import { lazy, Suspense, useEffect, useState } from 'react';
import type { ManagedProcess, Project, Task, Workspace } from '@garden/contracts';
const Files = lazy(() =>
  import('./computer/Files.js').then((module) => ({ default: module.Files }))
);
import { Operations } from './computer/Operations.js';
import { COMPUTER_TOOLS as TOOLS, type ComputerTool } from './computer-tools';
import './computer.css';

const Terminal = lazy(() => import('./computer/Terminal.js'));
const Screen = lazy(() => import('./computer/Screen.js'));
const Schedules = lazy(() =>
  import('./library/Watches.js').then((module) => ({ default: module.WatchesLibrary }))
);
const Results = lazy(() =>
  import('./library/Results.js').then((module) => ({ default: module.ResultsLibrary }))
);
const ComputerSettings = lazy(() =>
  import('./settings/Computer.js').then((module) => ({ default: module.ComputerSettings }))
);
const InstanceSettings = lazy(() =>
  import('./settings/Instance.js').then((module) => ({ default: module.InstanceSettings }))
);

export type { ComputerTool } from './computer-tools';
/** Inside a conversation the machine-wide tabs stay on the Computer page. */
const EMBEDDED: readonly ComputerTool[] = ['runs', 'terminal', 'browser', 'desktop', 'machine'];

export interface ComputerProps {
  workspace: Workspace | null;
  task?: Task | null;
  initialTool?: ComputerTool;
  visible?: boolean;
  onChange: () => void;
  embedded?: boolean;
  onToolChange?: (tool: ComputerTool) => void;
  /** What the Results tab lists; absent inside a conversation, which has no Results tab. */
  projects?: Project[];
  knownTasks?: Task[];
  onOpenTask?: (id: string) => void;
  onTaskDeleted?: (id: string) => void;
  /** Inside a conversation: a run handed back to it as something to talk about. */
  onAskAboutRun?: (process: ManagedProcess) => void;
}

/**
 * The machine itself: what is running on it, what it has produced, its files, and direct hands on
 * its terminal, browser and desktop. Runs come first because a remote computer is mostly a place
 * where work is happening.
 */
export default function Computer({
  workspace,
  task,
  initialTool = 'runs',
  visible = true,
  embedded = false,
  onToolChange,
  onChange,
  projects = [],
  knownTasks = [],
  onOpenTask = () => undefined,
  onTaskDeleted = () => undefined,
  onAskAboutRun
}: ComputerProps) {
  const tools = embedded ? EMBEDDED : TOOLS;
  const start = tools.includes(initialTool) ? initialTool : tools[0]!;
  const [tool, setTool] = useState<ComputerTool>(start);
  const [opened, setOpened] = useState<ReadonlySet<ComputerTool>>(() => new Set([start]));
  useEffect(() => {
    setTool(start);
    setOpened((current) => new Set([...current, start]));
  }, [start]);
  const select = (next: ComputerTool) => {
    setOpened((current) => new Set([...current, next]));
    setTool(next);
    onToolChange?.(next);
  };
  if (!workspace)
    return (
      <section className="panel empty">Choose a computer to open its files and sessions.</section>
    );
  // Files and the terminal keep their state while another tab is showing.
  const kept = (name: ComputerTool) => opened.has(name);
  return (
    <section className="computer panel" aria-label={`${workspace.name} computer`}>
      {!embedded && (
        <header className="computer-heading">
          <h1>{workspace.name}</h1>
          <span className="muted">{workspace.status}</span>
        </header>
      )}
      <nav className="computer-tabs" aria-label="Computer tools">
        {tools.map((name) => (
          <button
            type="button"
            key={name}
            className={tool === name ? 'button active' : 'button'}
            aria-pressed={tool === name}
            onClick={() => select(name)}
          >
            {name === 'machine' && embedded ? 'Recovery' : name[0]!.toUpperCase() + name.slice(1)}
          </button>
        ))}
      </nav>
      <Suspense
        fallback={
          <p className="muted" role="status">
            Opening…
          </p>
        }
      >
        {visible && tool === 'runs' && (
          <div className="computer-runs">
            <Operations
              workspace={workspace}
              task={task ?? null}
              tool="processes"
              onChange={onChange}
              {...(onAskAboutRun ? { onAsk: onAskAboutRun } : {})}
            />
            <Operations
              workspace={workspace}
              task={task ?? null}
              tool="previews"
              onChange={onChange}
            />
            {!embedded && (
              <Schedules workspace={workspace} onOpenTask={onOpenTask} onChange={onChange} />
            )}
          </div>
        )}
        {!embedded && visible && tool === 'results' && (
          <Results
            workspace={workspace}
            projects={projects}
            knownTasks={knownTasks}
            onOpenTask={onOpenTask}
            onChange={onChange}
            onTaskDeleted={onTaskDeleted}
          />
        )}
        {!embedded && kept('files') && (
          <div hidden={tool !== 'files'}>
            <Files
              key={workspace.id}
              workspace={workspace}
              taskId={task?.id ?? null}
              onChange={onChange}
            />
          </div>
        )}
        {kept('terminal') && (
          <div hidden={tool !== 'terminal'}>
            <Terminal
              key={workspace.id}
              workspaceId={workspace.id}
              visible={visible && tool === 'terminal'}
            />
          </div>
        )}
        {visible && (tool === 'browser' || tool === 'desktop') && (
          <Screen
            key={`${workspace.id}:${tool}`}
            workspaceId={workspace.id}
            {...(task ? { taskId: task.id } : {})}
            surface={tool}
          />
        )}
        {visible && tool === 'machine' && (
          <div className="computer-machine">
            {!embedded && <ComputerSettings workspace={workspace} onChange={onChange} />}
            <Operations
              workspace={workspace}
              task={task ?? null}
              tool="checkpoints"
              onChange={onChange}
            />
            {!embedded && <InstanceSettings />}
          </div>
        )}
      </Suspense>
    </section>
  );
}
