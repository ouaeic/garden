import { useSyncExternalStore } from 'react';
import { fileNavigationBlocked } from '../file-navigation';

/**
 * Where the owner is, kept in the address bar so a link, a reload and the back button all agree.
 *
 * Views replace one another; sheets open over whichever view is underneath and close back to it.
 */
export type View = 'today' | 'goal' | 'keys' | 'record' | 'computer' | 'settings';
export type Zoom = 'glance' | 'look' | 'inspect';
export type Sheet = 'deal' | 'catchup' | 'search' | null;

export interface Route {
  view: View;
  goal: string | null;
  zoom: Zoom;
  tab: string | null;
  section: string | null;
  sheet: Sheet;
}

const VIEWS: readonly View[] = ['today', 'goal', 'keys', 'record', 'computer', 'settings'];
const ZOOMS: readonly Zoom[] = ['glance', 'look', 'inspect'];
const SHEETS: readonly Exclude<Sheet, null>[] = ['deal', 'catchup', 'search'];
const CHANGE = 'garden:route';

const pick = <T extends string>(value: string | null, from: readonly T[], fallback: T): T =>
  value && (from as readonly string[]).includes(value) ? (value as T) : fallback;

const parse = (search: string): Route => {
  const query = new URLSearchParams(search);
  // Links from before this interface named a conversation `task`; they still open it.
  const goal = query.get('goal') ?? query.get('task');
  const view = goal && !query.get('view') ? 'goal' : pick(query.get('view'), VIEWS, 'today');
  return {
    view: view === 'goal' && !goal ? 'today' : view,
    goal: view === 'goal' || query.get('sheet') ? goal : null,
    zoom: pick(query.get('zoom'), ZOOMS, 'look'),
    tab: query.get('tab'),
    section: query.get('section'),
    sheet: (SHEETS as readonly string[]).includes(query.get('sheet') ?? '')
      ? (query.get('sheet') as Sheet)
      : null
  };
};

const format = (route: Route): string => {
  const query = new URLSearchParams();
  // A goal named over another view - a deal opened from Today - says which view it is over.
  if (route.view !== 'today' || route.goal) query.set('view', route.view);
  if (route.goal) query.set('goal', route.goal);
  if (route.view === 'goal' && route.zoom !== 'look') query.set('zoom', route.zoom);
  if (route.tab) query.set('tab', route.tab);
  if (route.section) query.set('section', route.section);
  if (route.sheet) query.set('sheet', route.sheet);
  const text = query.toString();
  return `${location.pathname}${text ? `?${text}` : ''}`;
};

let current = parse(location.search);
let shown = format(current);
const listeners = new Set<() => void>();
const publish = () => {
  current = parse(location.search);
  shown = format(current);
  listeners.forEach((listener) => listener());
};
/** Leaving the place an unsaved edit lives waits for the owner to save or discard it. */
const leaving = (next: Route) =>
  format({ ...next, sheet: null }) !== format({ ...current, sheet: null }) &&
  fileNavigationBlocked();
addEventListener('popstate', () => {
  if (leaving(parse(location.search))) history.pushState(history.state, '', shown);
  else publish();
});
addEventListener(CHANGE, publish);

export const currentRoute = (): Route => current;

/** Moves somewhere. A patch that changes the view clears what belonged to the old one. */
export function go(patch: Partial<Route>, options: { replace?: boolean } = {}): void {
  const viewChanged = patch.view !== undefined && patch.view !== current.view;
  const next: Route = {
    ...current,
    ...(viewChanged ? { goal: null, tab: null, section: null, zoom: 'look' as Zoom } : {}),
    ...patch
  };
  if (next.view !== 'goal' && !next.sheet) next.goal = null;
  const url = format(next);
  if (url === `${location.pathname}${location.search}` || leaving(next)) return;
  history[options.replace ? 'replaceState' : 'pushState'](history.state, '', url);
  dispatchEvent(new Event(CHANGE));
}

export const openGoal = (goal: string, zoom: Zoom = 'look') =>
  go({ view: 'goal', goal, zoom, sheet: null });

export const closeSheet = () => go({ sheet: null }, { replace: true });

/** Opens the deal a goal proposed, over whatever the owner is looking at. */
export const openDeal = (goal: string) => go({ sheet: 'deal', goal });

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useRoute = (): Route => useSyncExternalStore(subscribe, currentRoute);
