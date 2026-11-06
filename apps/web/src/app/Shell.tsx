import { Component, lazy, Suspense, useEffect, useMemo, useRef, type ReactNode } from 'react';
import Desk from '../desk/Desk';
import { focusAsk } from '../home/recent';
import { markLooked } from './actions';
import { growth } from './derive';
import Light from './Light';
import { closeSheet, go, useRoute } from './route';
import { primaryWorkspace, useGarden } from './store';
import { Toasts } from './toast';
import TopBar from './TopBar';
import { useViewed } from './viewer';
import './layout.css';
import './topbar.css';

const Goal = lazy(() => import('../goal/Goal'));
const Goals = lazy(() => import('../goals/Goals'));
const Library = lazy(() => import('../library/LibraryView'));
const Automations = lazy(() => import('../automations/Automations'));
const Keys = lazy(() => import('../keys/Keys'));
const Record = lazy(() => import('../record/Record'));
const ComputerView = lazy(() => import('../computer/ComputerView'));
const SettingsView = lazy(() => import('../settings/SettingsView'));
const DealSheet = lazy(() => import('../deal/DealSheet'));
const CatchUp = lazy(() => import('../catchup/CatchUp'));
const Search = lazy(() => import('../search/Search'));
const UpdateNotice = lazy(() => import('../UpdateNotice'));
const ArtifactViewer = lazy(() => import('./ArtifactViewer'));

/** The frame every view sits in: one bar above, the stage below, and the sheets over both. */
export default function Shell() {
  const route = useRoute();
  const viewed = useViewed();
  const { bootstrap, moves, error } = useGarden();
  const workspace = primaryWorkspace(bootstrap);
  const tasks = useMemo(() => bootstrap?.tasks ?? [], [bootstrap]);
  const lastLookAt = bootstrap?.user.preferences?.lastLookAt as string | undefined;
  const changed = useMemo(
    () =>
      lastLookAt
        ? tasks.filter(
            (task) =>
              Date.parse(task.updatedAt) > Date.parse(lastLookAt) &&
              ['ready', 'needs', 'failed'].includes(growth(task, moves))
          )
        : [],
    [tasks, moves, lastLookAt]
  );

  // A first visit starts the clock the catch-up counts from.
  const looked = useRef(false);
  useEffect(() => {
    if (!bootstrap || looked.current) return;
    looked.current = true;
    if (!lastLookAt) void markLooked();
  }, [bootstrap, lastLookAt]);

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        go({ sheet: 'search' });
      } else if (key === 'j' || (key === 'n' && event.shiftKey)) {
        // Cmd-N belongs to the browser; Cmd-J and Cmd-Shift-N reach a new ask from anywhere.
        event.preventDefault();
        go({ view: 'today', sheet: null });
        focusAsk();
      }
    };
    addEventListener('keydown', keys);
    return () => removeEventListener('keydown', keys);
  }, []);

  if (!bootstrap) return null;
  const daily = (bootstrap.usage.providerSpend as { windows?: { daily?: { used: number } } })
    ?.windows?.daily?.used;
  const dealMove = moves.find(
    (move): move is Extract<typeof move, { kind: 'deal' }> =>
      move.kind === 'deal' && move.taskId === route.goal
  );
  // An open sheet is the only thing that can be reached; what is behind it waits, out of the tab
  // order and out of the reading order, until it closes.
  const away = route.sheet || viewed ? true : undefined;
  return (
    <div className="app" data-view={route.view}>
      <Light />
      <div className="vignette" aria-hidden="true" />
      <TopBar current={route.view} tasks={tasks} moves={moves} daily={daily} away={away} />
      <main
        className="stage"
        key={route.view === 'goal' ? `goal:${route.goal}` : route.view}
        inert={away}
      >
        {error ? (
          <span className="lost" role="status">
            Reconnecting…
          </span>
        ) : null}
        <ViewBoundary>
          <Suspense fallback={<div className="view-loading" aria-busy="true" />}>
            {route.view === 'today' && <Desk catchUp={changed.length} />}
            {route.view === 'goal' && route.goal && <Goal id={route.goal} zoom={route.zoom} />}
            {route.view === 'goals' && <Goals />}
            {route.view === 'library' && <Library />}
            {route.view === 'automations' && <Automations section={route.section} />}
            {route.view === 'keys' && <Keys />}
            {route.view === 'record' && <Record />}
            {route.view === 'computer' && <ComputerView tab={route.tab} section={route.section} />}
            {route.view === 'settings' && <SettingsView section={route.section} />}
          </Suspense>
        </ViewBoundary>
      </main>

      <Suspense fallback={null}>
        {route.sheet === 'deal' && route.goal && <DealSheet move={dealMove} />}
        {route.sheet === 'catchup' && (
          <CatchUp
            since={lastLookAt ?? null}
            onClose={() => {
              void markLooked();
              closeSheet();
            }}
          />
        )}
        {route.sheet === 'search' && workspace && (
          <Search workspaceId={workspace.id} tasks={tasks} />
        )}
        <UpdateNotice onSettings={() => go({ view: 'settings', section: 'instance' })} />
        {viewed && <ArtifactViewer />}
      </Suspense>
      <Toasts />
    </div>
  );
}

/** One view failing says so in its own place; the bar and the other views stay. */
class ViewBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    return this.state.error ? (
      <div className="view-fault" role="alert">
        <h2 className="display">This view hit a snag.</h2>
        <p className="muted">Your work carries on. {this.state.error.message}</p>
        <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
