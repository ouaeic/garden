import { Component, lazy, Suspense, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { toggleTheme } from '../appearance';
import AskBar from '../ask/AskBar';
import { stopWatching, watching } from '../ask/ask-bus';
import Today from '../today/Today';
import { markLooked } from './actions';
import { beds, GROWTH_COLOR, growth, money } from './derive';
import { Screen, Search as SearchIcon, Settings, Theme } from './icons';
import Light from './Light';
import { closeSheet, go, openDeal, openGoal, useRoute, type View } from './route';
import { primaryWorkspace, useGarden } from './store';
import { Toasts } from './toast';

const Goal = lazy(() => import('../goal/Goal'));
const Keys = lazy(() => import('../keys/Keys'));
const Record = lazy(() => import('../record/Record'));
const ComputerView = lazy(() => import('../computer/ComputerView'));
const SettingsView = lazy(() => import('../settings/SettingsView'));
const DealSheet = lazy(() => import('../deal/DealSheet'));
const CatchUp = lazy(() => import('../catchup/CatchUp'));
const Search = lazy(() => import('../search/Search'));
const UpdateNotice = lazy(() => import('../UpdateNotice'));

const AWAY_MS = 3 * 3_600_000;
const NAV: { view: View; label: string }[] = [
  { view: 'today', label: 'Today' },
  { view: 'keys', label: 'Keys' },
  { view: 'record', label: 'Record' }
];

/** The frame every view sits in: the light, the header, the stage, the ask bar and the sheets. */
export default function Shell() {
  const route = useRoute();
  const { bootstrap, moves } = useGarden();
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

  // A first visit starts the clock; a return after a long absence opens the catch-up once.
  const looked = useRef(false);
  useEffect(() => {
    if (!bootstrap || looked.current) return;
    looked.current = true;
    if (!lastLookAt) void markLooked();
    else if (Date.now() - Date.parse(lastLookAt) > AWAY_MS && changed.length && !route.sheet)
      go({ sheet: 'catchup' });
  }, [bootstrap, lastLookAt, changed.length, route.sheet]);

  // A goal just asked for either proposes a deal, which opens, or answers, which opens the answer.
  useEffect(() => {
    const sent = watching();
    if (!sent) return;
    if (moves.some((move) => move.kind === 'deal' && move.taskId === sent.taskId)) {
      stopWatching();
      openDeal(sent.taskId);
      return;
    }
    const task = tasks.find((item) => item.id === sent.taskId);
    if (task && ['completed', 'failed', 'awaiting_user'].includes(task.status)) {
      stopWatching();
      if (route.view !== 'goal') openGoal(task.id);
    }
  }, [moves, tasks, route.view]);

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        go({ sheet: 'search' });
      }
    };
    addEventListener('keydown', keys);
    return () => removeEventListener('keydown', keys);
  }, []);

  if (!bootstrap) return null;
  const { growing } = beds(tasks, moves);
  const goalTask = route.view === 'goal' ? tasks.find((task) => task.id === route.goal) : undefined;
  const daily = (bootstrap.usage.providerSpend as { windows?: { daily?: { used: number } } })
    ?.windows?.daily?.used;
  const dealMove = moves.find(
    (move): move is Extract<typeof move, { kind: 'deal' }> =>
      move.kind === 'deal' && move.taskId === route.goal
  );
  return (
    <div className="app" data-view={route.view}>
      <Light />
      <div className="vignette" aria-hidden="true" />
      <div className="grain" aria-hidden="true" />
      <header className="top">
        <button type="button" className="brand" onClick={() => go({ view: 'today', sheet: null })}>
          <span className="sr-only">garden, back to Today</span>
          <span aria-hidden="true">garden</span>
        </button>
        <nav className="views" aria-label="Views">
          {NAV.map((item) => (
            <button
              key={item.view}
              type="button"
              aria-current={route.view === item.view ? 'page' : undefined}
              onClick={() => go({ view: item.view, sheet: null })}
            >
              {item.label}
              {item.view === 'today' && moves.length > 0 && (
                <span className="nav-count" aria-label={`${moves.length} waiting`}>
                  {moves.length}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="glance" aria-label="At a glance">
          <span className="glance-dots" aria-hidden="true">
            {growing.slice(0, 6).map((task) => {
              const state = growth(task, moves);
              return (
                <span
                  key={task.id}
                  className={`dot ${state === 'working' ? 'live' : ''}`}
                  style={{ '--c': GROWTH_COLOR[state] } as React.CSSProperties}
                />
              );
            })}
          </span>
          <span>
            {growing.length ? `${growing.length} growing` : 'Nothing growing'}
            {moves.length
              ? ` · ${moves.length} need${moves.length === 1 ? 's' : ''} you`
              : ' · nothing needs you'}
          </span>
          {daily !== undefined && <span className="num glance-spend">{money(daily)} today</span>}
        </div>
        <div className="top-tools">
          <button
            type="button"
            className="icon-btn"
            aria-label="Search (⌘K)"
            onClick={() => go({ sheet: 'search' })}
          >
            <SearchIcon />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Your computer"
            aria-pressed={route.view === 'computer'}
            onClick={() => go({ view: 'computer', sheet: null })}
          >
            <Screen />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Settings"
            aria-pressed={route.view === 'settings'}
            onClick={() => go({ view: 'settings', sheet: null })}
          >
            <Settings />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Switch day or night"
            onClick={toggleTheme}
          >
            <Theme />
          </button>
        </div>
      </header>

      <main className="stage" key={route.view === 'goal' ? `goal:${route.goal}` : route.view}>
        <ViewBoundary>
          <Suspense fallback={<div className="view-loading" aria-busy="true" />}>
            {route.view === 'today' && <Today catchUp={changed.length > 0} />}
            {route.view === 'goal' && route.goal && <Goal id={route.goal} zoom={route.zoom} />}
            {route.view === 'keys' && <Keys />}
            {route.view === 'record' && <Record />}
            {route.view === 'computer' && <ComputerView tab={route.tab} />}
            {route.view === 'settings' && <SettingsView section={route.section} />}
          </Suspense>
        </ViewBoundary>
      </main>

      {workspace && route.view !== 'settings' && (
        <AskBar bootstrap={bootstrap} workspace={workspace} goal={goalTask ?? null} moves={moves} />
      )}

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
      </Suspense>
      <Toasts />
    </div>
  );
}

/** One view failing says so in its own place; the header, the ask bar and the other views stay. */
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
