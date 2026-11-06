import { lazy, Suspense, useEffect, useState } from 'react';
import { go } from '../app/route';
import { primaryWorkspace, refreshSoon, useGarden } from '../app/store';
import { Operations } from './Operations';
import '../computer.css';
import './computer-view.css';

const Files = lazy(() => import('./Files').then((module) => ({ default: module.Files })));
const Terminal = lazy(() => import('./Terminal'));
const Screen = lazy(() => import('./Screen'));

const TABS = [
  ['running', 'Running'],
  ['browser', 'Browser'],
  ['desktop', 'Desktop'],
  ['terminal', 'Terminal'],
  ['files', 'Files'],
  ['undo', 'Undo points']
] as const;
type Tab = (typeof TABS)[number][0];

/**
 * The computer itself, for whoever wants their hands on it: what is running, its screens, its
 * terminal and files, and the points it can be put back to. The terminal
 * and files keep their place while another tab is showing.
 */
export default function ComputerView({
  tab,
  section = null
}: {
  tab: string | null;
  section?: string | null;
}) {
  const { bootstrap } = useGarden();
  const workspace = primaryWorkspace(bootstrap);
  const current: Tab = TABS.some(([id]) => id === tab) ? (tab as Tab) : 'running';
  // A link that names the schedules tab lands on Automations, where schedules live.
  useEffect(() => {
    if (tab === 'rhythms') go({ view: 'automations', section }, { replace: true });
  }, [tab, section]);
  const [opened, setOpened] = useState<ReadonlySet<Tab>>(() => new Set([current]));
  if (!workspace) return null;
  const select = (next: Tab) => {
    setOpened((set) => new Set(set).add(next));
    go({ tab: next }, { replace: true });
  };
  const kept = (name: Tab) => opened.has(name) || current === name;
  return (
    <div className="computer-view">
      <header className="computer-head rise">
        <div>
          <div className="eyebrow">
            {workspace.status === 'running' ? 'Running' : workspace.status} · {workspace.region}
          </div>
          <h1 className="display">
            Your <em>computer</em>
          </h1>
        </div>
        <nav className="seg" aria-label="Computer tools">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" aria-pressed={current === id} onClick={() => select(id)}>
              {label}
            </button>
          ))}
        </nav>
      </header>
      <div className="computer-stage scroll">
        <Suspense fallback={<div className="view-loading" aria-busy="true" />}>
          {current === 'running' && (
            <div className="computer-running">
              <Operations
                workspace={workspace}
                task={null}
                tool="processes"
                onChange={refreshSoon}
              />
              <Operations
                workspace={workspace}
                task={null}
                tool="previews"
                onChange={refreshSoon}
              />
            </div>
          )}
          {(current === 'browser' || current === 'desktop') && (
            <div className="computer-screen">
              <Screen key={current} workspaceId={workspace.id} surface={current} />
            </div>
          )}
          {kept('terminal') && (
            <div className="computer-terminal" hidden={current !== 'terminal'}>
              <Terminal workspaceId={workspace.id} visible={current === 'terminal'} />
            </div>
          )}
          {kept('files') && (
            <div hidden={current !== 'files'}>
              <Files workspace={workspace} onChange={refreshSoon} />
            </div>
          )}
          {current === 'undo' && (
            <Operations
              workspace={workspace}
              task={null}
              tool="checkpoints"
              onChange={refreshSoon}
            />
          )}
        </Suspense>
      </div>
    </div>
  );
}
