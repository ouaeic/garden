import { lazy, Suspense, useEffect, useState } from 'react';
import type { Task, Workspace } from '@garden/contracts';
const Files = lazy(() =>
  import('./computer/Files.js').then((module) => ({ default: module.Files }))
);
import { Operations } from './computer/Operations.js';
import './computer.css';

const Terminal = lazy(() => import('./computer/Terminal.js'));
const Screen = lazy(() => import('./computer/Screen.js'));
export type ComputerTool =
  | 'files'
  | 'terminal'
  | 'browser'
  | 'desktop'
  | 'previews'
  | 'processes'
  | 'checkpoints';
export interface ComputerProps {
  workspace: Workspace | null;
  task?: Task | null;
  initialTool?: ComputerTool;
  visible?: boolean;
  onChange: () => void;
  embedded?: boolean;
  onToolChange?: (tool: ComputerTool) => void;
}

export default function Computer({
  workspace,
  task,
  initialTool = 'files',
  visible = true,
  embedded = false,
  onToolChange,
  onChange
}: ComputerProps) {
  const [tool, setTool] = useState<ComputerTool>(initialTool);
  const [filesOpened, setFilesOpened] = useState(initialTool === 'files');
  const [terminalOpened, setTerminalOpened] = useState(initialTool === 'terminal');
  useEffect(() => {
    setTool(initialTool);
    if (initialTool === 'files') setFilesOpened(true);
    if (initialTool === 'terminal') setTerminalOpened(true);
  }, [initialTool]);
  const select = (next: ComputerTool) => {
    if (next === 'terminal') setTerminalOpened(true);
    if (next === 'files') setFilesOpened(true);
    setTool(next);
    onToolChange?.(next);
  };
  if (!workspace)
    return (
      <section className="panel empty">Choose a computer to open its files and sessions.</section>
    );
  return (
    <section className="computer panel" aria-label={`${workspace.name} computer`}>
      {!embedded && (
        <header className="section-heading">
          <div>
            <p className="eyebrow">All computer work</p>
            <h2>{task?.title ?? workspace.name}</h2>
          </div>
          <span className="muted">{workspace.status}</span>
        </header>
      )}
      <nav className="computer-tabs" aria-label="Computer tools">
        {(
          [
            'files',
            'terminal',
            'browser',
            'desktop',
            'previews',
            'processes',
            'checkpoints'
          ] as const
        )
          .filter((name) => !embedded || name !== 'files')
          .map((name) => (
            <button
              type="button"
              key={name}
              className={tool === name ? 'button active' : 'button'}
              aria-pressed={tool === name}
              onClick={() => select(name)}
            >
              {name === 'checkpoints'
                ? 'Recovery'
                : name === 'processes'
                  ? 'Jobs'
                  : name[0]!.toUpperCase() + name.slice(1)}
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
        {filesOpened && (
          <div hidden={tool !== 'files'}>
            <Files
              key={workspace.id}
              workspace={workspace}
              taskId={task?.id ?? null}
              onChange={onChange}
            />
          </div>
        )}
        {terminalOpened && (
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
        {visible && (tool === 'previews' || tool === 'processes' || tool === 'checkpoints') && (
          <Operations
            key={`${workspace.id}:${tool}`}
            workspace={workspace}
            task={task ?? null}
            tool={tool}
            onChange={onChange}
          />
        )}
      </Suspense>
    </section>
  );
}
