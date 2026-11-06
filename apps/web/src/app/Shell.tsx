import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import type { OwnerMove, Task } from '@garden/contracts';
import { toggleTheme } from '../appearance';
import AskBar from '../ask/AskBar';
import Home from '../home/Home';
import { focusAsk } from '../home/recent';
import { markLooked } from './actions';
import { beds, GROWTH_COLOR, goalLine, growth, money } from './derive';
import {
  Goals as GoalsIcon,
  Home as HomeIcon,
  Key,
  Library as LibraryIcon,
  More,
  Plus,
  Pulse,
  Repeat,
  Screen,
  Search as SearchIcon,
  Settings,
  Theme
} from './icons';
import Light from './Light';
import Wordmark from './Wordmark';
import { closeSheet, go, openGoal, useRoute, type View } from './route';
import { primaryWorkspace, useGarden } from './store';
import { Toasts } from './toast';
import { useViewed } from './viewer';
import './layout.css';

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

type Item = { view: View; label: string; icon: (props: object) => ReactNode };
const PRIMARY: Item[] = [
  { view: 'today', label: 'Home', icon: HomeIcon },
  { view: 'goals', label: 'Goals', icon: GoalsIcon },
  { view: 'library', label: 'Library', icon: LibraryIcon },
  { view: 'automations', label: 'Automations', icon: Repeat },
  { view: 'computer', label: 'Computer', icon: Screen }
];
const SECONDARY: Item[] = [
  { view: 'keys', label: 'Permissions', icon: Key },
  { view: 'record', label: 'Activity', icon: Pulse },
  { view: 'settings', label: 'Settings', icon: Settings }
];
/** The views a phone reaches from its tab bar; the rest sit behind More. */
const PHONE_TABS: Item[] = [PRIMARY[0]!, PRIMARY[1]!, PRIMARY[2]!];

/** A goal is in the rail while it is moving or waiting on the owner. */
const ACTIVE = new Set(['working', 'needs']);

/** The frame every view sits in: the rail, the stage, the docked ask bar and the sheets. */
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
  const goalTask = route.view === 'goal' ? tasks.find((task) => task.id === route.goal) : undefined;
  const daily = (bootstrap.usage.providerSpend as { windows?: { daily?: { used: number } } })
    ?.windows?.daily?.used;
  const dealMove = moves.find(
    (move): move is Extract<typeof move, { kind: 'deal' }> =>
      move.kind === 'deal' && move.taskId === route.goal
  );
  // An open sheet is the only thing that can be reached; what is behind it waits, out of the tab
  // order and out of the reading order, until it closes.
  const away = route.sheet || viewed ? true : undefined;
  const current = route.view === 'goal' ? null : route.view;
  return (
    <div className="app" data-view={route.view}>
      <Light />
      <div className="vignette" aria-hidden="true" />
      <Rail
        current={current}
        tasks={tasks}
        moves={moves}
        openGoalId={route.view === 'goal' ? route.goal : null}
        daily={daily}
        away={away}
      />
      <PhoneTop current={current} needs={moves.length} away={away} />

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
            {route.view === 'today' && <Home catchUp={changed.length} />}
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
        {workspace && route.view === 'goal' && (
          <AskBar
            bootstrap={bootstrap}
            workspace={workspace}
            goal={goalTask ?? null}
            moves={moves}
            away={away}
          />
        )}
      </main>
      <PhoneTabs current={current} needs={moves.length} away={away} />

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

/**
 * Where everything is, and what is moving right now. The live list is the point: every goal that is
 * working or waiting on the owner is one click away from any screen.
 */
function Rail({
  current,
  tasks,
  moves,
  openGoalId,
  daily,
  away
}: {
  current: View | null;
  tasks: readonly Task[];
  moves: readonly OwnerMove[];
  openGoalId: string | null;
  daily: number | undefined;
  away: true | undefined;
}) {
  const { growing } = beds(tasks, moves);
  const active = growing.filter((task) => ACTIVE.has(growth(task, moves))).slice(0, 12);
  return (
    <aside className="rail" aria-label="garden" inert={away}>
      <div className="rail-top">
        <button
          type="button"
          className="brand"
          aria-label="garden, home"
          onClick={() => go({ view: 'today', sheet: null })}
        >
          <Wordmark />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Search (⌘K)"
          title="Search (⌘K)"
          onClick={() => go({ sheet: 'search' })}
        >
          <SearchIcon />
        </button>
      </div>
      <button
        type="button"
        className="rail-new"
        onClick={() => {
          go({ view: 'today', sheet: null });
          focusAsk();
        }}
      >
        <Plus /> New <kbd>⌘J</kbd>
      </button>
      <nav className="rail-nav" aria-label="Views">
        {PRIMARY.map((item) => (
          <RailLink
            key={item.view}
            item={item}
            current={current}
            badge={item.view === 'today' && moves.length ? moves.length : undefined}
          />
        ))}
      </nav>
      <section className="rail-live" aria-label="Working now">
        <div className="rail-label">
          {active.length ? 'Working now' : 'Nothing running'}
          {growing.length > active.length && (
            <button type="button" className="link" onClick={() => go({ view: 'goals' })}>
              All
            </button>
          )}
        </div>
        <ul>
          {active.map((task) => {
            const state = growth(task, moves);
            return (
              <li key={task.id}>
                <button
                  type="button"
                  className="rail-goal"
                  aria-current={openGoalId === task.id ? 'page' : undefined}
                  onClick={() => openGoal(task.id)}
                >
                  <span
                    className={`dot ${state === 'working' ? 'live' : ''}`}
                    style={{ '--c': GROWTH_COLOR[state] } as React.CSSProperties}
                    aria-hidden="true"
                  />
                  <span className="rail-goal-text">
                    <span className="rail-goal-title">{task.title || 'Untitled goal'}</span>
                    <span className="rail-goal-line">{goalLine(task, moves)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      <nav className="rail-nav rail-secondary" aria-label="Trust and settings">
        {SECONDARY.map((item) => (
          <RailLink key={item.view} item={item} current={current} />
        ))}
      </nav>
      <div className="rail-foot">
        <span className="num" title="Spent on models today">
          {daily === undefined ? '' : `${money(daily)} today`}
        </span>
        <button
          type="button"
          className="icon-btn"
          aria-label="Switch day or night"
          onClick={toggleTheme}
        >
          <Theme />
        </button>
      </div>
    </aside>
  );
}

function RailLink({
  item,
  current,
  badge
}: {
  item: Item;
  current: View | null;
  badge?: number | undefined;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      className="rail-link"
      aria-current={current === item.view ? 'page' : undefined}
      onClick={() => go({ view: item.view, sheet: null })}
    >
      <Icon />
      <span>{item.label}</span>
      {badge ? (
        <span className="rail-badge" aria-label={`${badge} need you`}>
          {badge}
        </span>
      ) : null}
    </button>
  );
}

/** On a phone the brand and what needs the owner stay at the top; the views sit at the bottom. */
function PhoneTop({
  current,
  needs,
  away
}: {
  current: View | null;
  needs: number;
  away: true | undefined;
}) {
  return (
    <header className="phone-top" inert={away}>
      <button
        type="button"
        className="brand"
        aria-label="garden, home"
        onClick={() => go({ view: 'today', sheet: null })}
      >
        <Wordmark />
      </button>
      {needs > 0 && current !== 'today' && (
        <button type="button" className="phone-needs" onClick={() => go({ view: 'today' })}>
          {needs} need{needs === 1 ? 's' : ''} you
        </button>
      )}
      <button
        type="button"
        className="icon-btn"
        aria-label="Search"
        onClick={() => go({ sheet: 'search' })}
      >
        <SearchIcon />
      </button>
    </header>
  );
}

function PhoneTabs({
  current,
  needs,
  away
}: {
  current: View | null;
  needs: number;
  away: true | undefined;
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    addEventListener('pointerdown', outside);
    addEventListener('keydown', escape);
    return () => {
      removeEventListener('pointerdown', outside);
      removeEventListener('keydown', escape);
    };
  }, [open]);
  const more = [PRIMARY[3]!, PRIMARY[4]!, ...SECONDARY];
  return (
    <nav className="phone-tabs" aria-label="Views" inert={away} ref={menu}>
      {PHONE_TABS.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.view}
            type="button"
            aria-current={current === item.view ? 'page' : undefined}
            onClick={() => go({ view: item.view, sheet: null })}
          >
            <Icon />
            <span>{item.label}</span>
            {item.view === 'today' && needs > 0 && <i className="tab-dot" aria-hidden="true" />}
          </button>
        );
      })}
      <button
        type="button"
        className="phone-new"
        aria-label="New"
        onClick={() => {
          go({ view: 'today', sheet: null });
          focusAsk();
        }}
      >
        <Plus />
      </button>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="phone-more"
        onClick={() => setOpen(!open)}
      >
        <More />
        <span>More</span>
      </button>
      {open && (
        <div id="phone-more" className="phone-more pane">
          {more.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.view}
                type="button"
                aria-current={current === item.view ? 'page' : undefined}
                onClick={() => {
                  setOpen(false);
                  go({ view: item.view, sheet: null });
                }}
              >
                <Icon /> {item.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              toggleTheme();
            }}
          >
            <Theme /> Day or night
          </button>
        </div>
      )}
    </nav>
  );
}

/** One view failing says so in its own place; the rail and the other views stay. */
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
