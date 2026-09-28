import type { BrowserTabState } from '@garden/contracts';

export const TAB_IDLE_MS = 30 * 60 * 1000;
export const AGENT_TAB_LIMIT = 24;
export const TAB_SWEEP_MS = 60 * 1000;

interface TabRecord {
  owner: 'agent' | 'user';
  taskId: string | null;
  pinned: boolean;
  lastUsedAt: number;
  title: string;
  downloads: number;
  dialog: boolean;
  ownerTouched: boolean;
}

/** Resource ownership comes from the signed caller and local browser events, never page text. */
export class BrowserTabs {
  readonly #tabs = new Map<string, TabRecord>();
  readonly cleanup = { closed: 0, lastClosedAt: null as string | null };

  add(tabId: string, owner: 'agent' | 'user', taskId: string | null, now: number): void {
    this.#tabs.set(tabId, {
      owner,
      taskId,
      pinned: false,
      lastUsedAt: now,
      title: '',
      downloads: 0,
      dialog: false,
      ownerTouched: false
    });
  }

  remove(tabId: string): void {
    this.#tabs.delete(tabId);
  }
  has(tabId: string): boolean {
    return this.#tabs.has(tabId);
  }
  ownership(tabId: string): { owner: 'agent' | 'user'; taskId: string | null } | undefined {
    const tab = this.#tabs.get(tabId);
    return tab ? { owner: tab.owner, taskId: tab.taskId } : undefined;
  }
  adopt(tabId: string, source: { owner: 'agent' | 'user'; taskId: string | null }): void {
    const tab = this.#tabs.get(tabId);
    if (tab && !tab.ownerTouched) {
      tab.owner = source.owner;
      tab.taskId = source.taskId;
    }
  }
  title(tabId: string): string {
    return this.#tabs.get(tabId)?.title ?? '';
  }
  setTitle(tabId: string, title: string): void {
    const tab = this.#tabs.get(tabId);
    if (tab) tab.title = title.slice(0, 500);
  }
  pin(tabId: string, pinned: boolean): void {
    const tab = this.#tabs.get(tabId);
    if (!tab) throw new Error(`Browser tab ${tabId} is no longer open`);
    tab.pinned = pinned;
  }
  touch(tabId: string, actor: 'agent' | 'user', now: number): void {
    const tab = this.#tabs.get(tabId);
    if (!tab) return;
    tab.lastUsedAt = now;
    if (actor === 'user') {
      tab.owner = 'user';
      tab.ownerTouched = true;
    }
  }
  download(tabId: string, change: 1 | -1): void {
    const tab = this.#tabs.get(tabId);
    if (tab) tab.downloads = Math.max(0, tab.downloads + change);
  }
  dialog(tabId: string, open: boolean): void {
    const tab = this.#tabs.get(tabId);
    if (tab) tab.dialog = open;
  }
  state(tabId: string, url: string, active: boolean, holder: string): BrowserTabState {
    const tab = this.#tabs.get(tabId);
    if (!tab) throw new Error(`Browser tab ${tabId} is no longer open`);
    return {
      tabId,
      url,
      title: tab.title,
      active,
      owner: tab.owner,
      taskId: tab.taskId,
      pinned: tab.pinned,
      lastUsedAt: new Date(tab.lastUsedAt).toISOString(),
      protectedReason:
        holder !== 'agent'
          ? 'control'
          : tab.owner === 'user'
            ? 'owner'
            : tab.pinned
              ? 'pinned'
              : active
                ? 'active'
                : tab.downloads
                  ? 'download'
                  : tab.dialog
                    ? 'dialog'
                    : null
    };
  }
  candidates(tabs: BrowserTabState[], now: number, makeRoom = false): string[] {
    const agentCount = tabs.filter((tab) => tab.owner === 'agent').length;
    let excess = Math.max(0, agentCount - AGENT_TAB_LIMIT + (makeRoom ? 1 : 0));
    return tabs
      .filter((tab) => tab.protectedReason === null)
      .sort((a, b) => Date.parse(a.lastUsedAt) - Date.parse(b.lastUsedAt))
      .filter((tab) => {
        if (now - Date.parse(tab.lastUsedAt) >= TAB_IDLE_MS) {
          excess = Math.max(0, excess - 1);
          return true;
        }
        if (excess > 0) {
          excess -= 1;
          return true;
        }
        return false;
      })
      .map((tab) => tab.tabId);
  }
  closed(now: number): void {
    this.cleanup.closed += 1;
    this.cleanup.lastClosedAt = new Date(now).toISOString();
  }
}
