import { useEffect, useRef, useState } from 'react';
import type { OwnerMove, Task } from '@garden/contracts';
import { toggleTheme } from '../appearance';
import { focusAsk } from '../home/recent';
import { growth, money } from './derive';
import { Key, More, Plus, Pulse, Search as SearchIcon, Settings, Theme } from './icons';
import { go, type View } from './route';
import Wordmark from './Wordmark';

const PLACES: { view: View; label: string }[] = [
  { view: 'today', label: 'Desk' },
  { view: 'library', label: 'Library' },
  { view: 'automations', label: 'Automations' },
  { view: 'computer', label: 'Computer' }
];

/**
 * The one bar above everything: the four places work lives, how much is moving right now, and a
 * way to search. Everything else is one menu away, so the work below gets the whole screen.
 */
export default function TopBar({
  current,
  tasks,
  moves,
  daily,
  away
}: {
  current: View;
  tasks: readonly Task[];
  moves: readonly OwnerMove[];
  daily: number | undefined;
  away: true | undefined;
}) {
  const working = tasks.filter((task) => growth(task, moves) === 'working').length;
  const deskView = current === 'goal' ? 'today' : current;
  return (
    <header className="topbar" inert={away}>
      <button
        type="button"
        className="brand"
        aria-label="garden, the desk"
        onClick={() => go({ view: 'today', sheet: null })}
      >
        <Wordmark />
      </button>
      <nav className="topnav" aria-label="Views">
        {PLACES.map((place) => (
          <button
            key={place.view}
            type="button"
            data-nav={place.view === 'today' ? 'desk' : place.view}
            aria-current={deskView === place.view ? 'page' : undefined}
            onClick={() => go({ view: place.view, sheet: null })}
          >
            {place.label}
            {place.view === 'today' && moves.length > 0 && (
              <span className="topnav-count" aria-label={`${moves.length} need you`}>
                {moves.length}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="topbar-right">
        {working > 0 && (
          <button
            type="button"
            className="topbar-live"
            onClick={() => go({ view: 'today', sheet: null })}
            title="Working now"
          >
            <i aria-hidden="true" />
            {working} working
          </button>
        )}
        {daily !== undefined && (
          <span className="topbar-spend num" title="Spent on models today">
            {money(daily)} today
          </span>
        )}
        <button
          type="button"
          className="icon-btn topbar-new"
          aria-label="New ask (⌘J)"
          title="New ask (⌘J)"
          onClick={() => {
            go({ view: 'today', sheet: null });
            focusAsk();
          }}
        >
          <Plus />
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
        <MoreMenu current={current} />
      </div>
    </header>
  );
}

function MoreMenu({ current }: { current: View }) {
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
  const item = (view: View, label: string, Icon: (props: object) => React.ReactNode) => (
    <button
      key={view}
      type="button"
      aria-current={current === view ? 'page' : undefined}
      onClick={() => {
        setOpen(false);
        go({ view, sheet: null });
      }}
    >
      <Icon /> {label}
    </button>
  );
  return (
    <div className="topbar-more" ref={menu}>
      <button
        type="button"
        className="icon-btn"
        aria-label="More"
        aria-expanded={open}
        aria-controls="topbar-menu"
        onClick={() => setOpen(!open)}
      >
        <More />
      </button>
      {open && (
        <div id="topbar-menu" className="topbar-menu pane">
          <div className="topbar-menu-places">
            {PLACES.map((place) => item(place.view, place.label, () => null))}
          </div>
          {item('goals', 'Every goal', () => null)}
          {item('keys', 'Permissions', Key)}
          {item('record', 'Activity', Pulse)}
          {item('settings', 'Settings', Settings)}
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
    </div>
  );
}
