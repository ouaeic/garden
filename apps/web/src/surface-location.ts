import { useEffect, useState } from 'react';
import { fileNavigationBlocked } from './file-navigation';

const eventName = 'garden:surface-location';
export function sheetHistoryDepth(): number {
  return historyDepth('gardenSheetDepth');
}
function historyDepth(key: string): number {
  const state: unknown = history.state;
  if (!state || typeof state !== 'object') return 0;
  const depth = (state as Record<string, unknown>)[key];
  return typeof depth === 'number' && Number.isSafeInteger(depth) && depth > 0 ? depth : 0;
}
export const projectViews = ['work', 'files', 'activity', 'tools'] as const;
export type ProjectView = (typeof projectViews)[number];

export function closeProjectPanel() {
  if (fileNavigationBlocked()) return;
  const depth = historyDepth('gardenProjectPanelDepth');
  if (depth) history.go(-depth);
  else setSurfaceLocation({ panel: null }, true);
}

/** URLs contain navigation identifiers only; drafts and credentials stay out of history. */
export function setSurfaceLocation(values: Record<string, string | null>, replace = false) {
  if (fileNavigationBlocked()) return false;
  const url = new URL(location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  if (url.href !== location.href) {
    const depth = sheetHistoryDepth();
    const previousPanel = new URL(location.href).searchParams.get('panel');
    const nextPanel = url.searchParams.get('panel');
    const panelOpen = nextPanel && nextPanel !== 'work';
    const previousDepth = historyDepth('gardenProjectPanelDepth');
    const nextDepth = !panelOpen
      ? 0
      : previousPanel && previousPanel !== 'work'
        ? previousDepth && previousDepth + (replace ? 0 : 1)
        : replace
          ? 0
          : 1;
    // Panel sections share one close destination, including after Back and Forward.
    history[replace ? 'replaceState' : 'pushState'](
      {
        ...(depth ? { gardenSheetDepth: replace ? depth : depth + 1 } : {}),
        ...(nextDepth ? { gardenProjectPanelDepth: nextDepth } : {})
      },
      '',
      url
    );
  }
  window.dispatchEvent(new Event(eventName));
  return true;
}

export function useSurfaceLocation(key: string, fallback: string) {
  const read = () => new URLSearchParams(location.search).get(key) ?? fallback;
  const [value, setValue] = useState(read);
  useEffect(() => {
    const update = () => setValue(read());
    update();
    window.addEventListener('popstate', update);
    window.addEventListener(eventName, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(eventName, update);
    };
  }, [key, fallback]);
  return [value, (next: string) => setSurfaceLocation({ [key]: next })] as const;
}

export function useProjectView() {
  const [value, select] = useSurfaceLocation('panel', 'work');
  return [
    projectViews.includes(value as ProjectView) ? (value as ProjectView) : 'work',
    select
  ] as const;
}

export function useProjectTool(projectId: string) {
  let remembered = 'browser';
  try {
    remembered = localStorage.getItem(`garden:project-tool:${projectId}`) ?? remembered;
  } catch {
    /* Preferences are optional. */
  }
  const [tool, select] = useSurfaceLocation('tool', remembered);
  useEffect(() => {
    try {
      localStorage.setItem(`garden:project-tool:${projectId}`, tool);
    } catch {
      /* Keep navigation usable without storage. */
    }
  }, [projectId, tool]);
  return [tool, select] as const;
}
