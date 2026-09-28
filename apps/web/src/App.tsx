import { palettes, storedDisplayMode, storedPalette } from './appearance';
import { setLifeMode } from './life/settings';
import { recoverDeviceDrafts, forgetDraftKey } from './draft-storage';
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowUpRight,
  Bell,
  Clock3,
  Cog,
  FolderOpen,
  House,
  LibraryBig,
  Monitor,
  Sparkles,
  Plus,
  Search
} from './icons';
import type { Task, Workspace, Project, ConversationSource } from '@garden/contracts';
import { get, ApiError, post, isNativeClient } from './client';
import type { NativeStatus } from './native';
import { createTaskNotifier } from './native-notices';
import { subscribeWorkerNavigation } from './worker-navigation';
import Brand from './Brand';
import { Sprite } from './life/Sprite';
import { bellBird } from './life/growth';
import Stats from './Stats';
import './living-interface.css';
import { fileNavigationBlocked } from './file-navigation';
import { initialNavigation } from './navigation';
import type { View } from './navigation';
import type { Bootstrap, Decision, Draft } from './model';
import { needsAttention, shortDate, taskStatusLabel, mergeTaskRefresh } from './model';
import { Button, Dialog, Empty, ErrorNotice, Spinner } from './ui';
import DecisionQueue from './DecisionQueue';
import ProjectCollection from './ProjectCollection';
import './styles.css';
import './garden.css';
import './workspace-interface.css';
import './desk.css';
import './pixel.css';
import './shell.css';
import { useWorkspaceViewport } from './use-workspace-viewport';
const DeskHome = lazy(() => import('./DeskHome'));
const GardenLife = lazy(() => import('./life/GardenLife'));
import { setSurfaceLocation, sheetHistoryDepth } from './surface-location';
const Composer = lazy(() => import('./Composer'));
const TaskSurface = lazy(() => import('./TaskSurface'));
const ProjectSpace = lazy(() => import('./ProjectSpace'));
const NewConversation = lazy(() => import('./NewConversation'));
const Computer = lazy(() => import('./Computer'));
const Automations = lazy(() =>
  import('./library/Watches').then((module) => ({ default: module.WatchesLibrary }))
);
const Library = lazy(() => import('./Library'));
const sheetTitles: Partial<Record<View, string>> = {
  projects: 'Projects',
  library: 'Library',
  settings: 'Settings',
  automations: 'Automations',
  attention: 'Needs you'
};
const Settings = lazy(() => import('./Settings'));
const NativeSetup = lazy(() => import('./NativeSetup'));
import type { ComputerTool as Tool } from './Computer';
const Login = lazy(() => import('./Login'));
const SearchDialog = lazy(() => import('./SearchDialog'));
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    return this.state.error ? (
      <main className="boundary">
        <h1>This view needs to reopen.</h1>
        <p>Your work continues on your computer.</p>
        <ErrorNotice error={this.state.error} />
        <Button onClick={() => location.reload()}>Reopen workspace</Button>
      </main>
    ) : (
      this.props.children
    );
  }
}
export default function App() {
  return (
    <Boundary>
      <WorkspaceApp />
      <Suspense fallback={null}>
        <NativeAuthorizationPortal />
      </Suspense>
    </Boundary>
  );
}
const NativeAuthorizationPortal = lazy(() => import('./NativeAuthorization'));
function WorkspaceApp() {
  useWorkspaceViewport();
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [nativeState, setNativeState] = useState<NativeStatus | null>(null);
  const [nativePairingCode, setNativePairingCode] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [navigation, setNavigation] = useState(initialNavigation);
  const navigationUrl = useRef(location.pathname + location.search + location.hash);
  const [workspaceId, setWorkspaceId] = useState('');
  const [taskWorkspaces, setTaskWorkspaces] = useState<{
    ownerId: string;
    values: Record<string, Workspace>;
  }>({ ownerId: '', values: {} });
  const [theme, setTheme] = useState(storedDisplayMode);
  const [palette, setPalette] = useState(storedPalette);
  const [newWork, setNewWork] = useState(false);
  const [newConversation, setNewConversation] = useState<{
    project: Project;
    source?: ConversationSource;
  } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [tool, setTool] = useState<Tool>('files');
  const [computerOpened, setComputerOpened] = useState(
    initialNavigation().view === 'computer' ||
      new URLSearchParams(location.search).get('behind') === 'computer'
  );
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [filter, setFilter] = useState<'active' | 'running' | 'complete' | 'archived'>('active');
  const [search, setSearch] = useState('');
  const activePaged = useRef(false);
  const deletedTasks = useRef(new Set<string>());
  const [offline, setOffline] = useState(!navigator.onLine);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bootstrapRef = useRef(bootstrap);
  const taskNotifier = useRef(createTaskNotifier());
  bootstrapRef.current = bootstrap;
  const seenStatuses = useRef(new Map<string, Task['status']>());
  useEffect(() => {
    if (!bootstrap) return;
    // A run that finishes while you watch makes the garden bloom; one found finished does not.
    let bloomed = false;
    for (const item of bootstrap.tasks) {
      const before = seenStatuses.current.get(item.id);
      if (before && before !== 'completed' && item.status === 'completed') bloomed = true;
      seenStatuses.current.set(item.id, item.status);
    }
    if (bloomed) dispatchEvent(new Event('garden:bloom'));
  }, [bootstrap?.tasks]);
  const refresh = useCallback(async () => {
    try {
      const result = await get<Bootstrap>('/v1/bootstrap');
      let draftError: unknown = null;
      try {
        const recovered = await recoverDeviceDrafts(result.user.id);
        const merged = new Map(
          result.drafts.map((draft) => [draft.taskId ?? `new:${draft.workspaceId}`, draft])
        );
        for (const draft of recovered)
          merged.set(draft.taskId ?? `new:${draft.workspaceId}`, draft);
        result.drafts = [...merged.values()];
      } catch (cause) {
        draftError = cause;
      }
      void taskNotifier.current.update(result.tasks);
      setBootstrap((current) =>
        mergeTaskRefresh(current, result, activePaged.current, deletedTasks.current)
      );
      setAuthRequired(false);
      setError(draftError);
      setWorkspaceId((current) =>
        result.workspaces.some((workspace) => workspace.id === current)
          ? current
          : (result.workspaces[0]?.id ?? '')
      );
      setDrafts((current) => {
        const merged = { ...current };
        for (const draft of result.drafts) {
          const key = draft.taskId ?? `new:${draft.workspaceId}`;
          if (!merged[key]) merged[key] = draft;
        }
        return merged;
      });
    } catch (err) {
      if (
        err instanceof ApiError &&
        ['authentication_required', 'session_expired', 'invalid_session'].includes(err.code)
      ) {
        forgetDraftKey();
        setAuthRequired(true);
      } else setError(err);
    } finally {
      setLoading(false);
    }
  }, []);
  const refreshDecisions = useCallback(async () => {
    try {
      setDecisions(await get<Decision[]>('/v1/approvals'));
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) setError(err);
    }
  }, []);
  const requestRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void refresh();
      void refreshDecisions();
    }, 400);
  }, [refresh, refreshDecisions]);
  useEffect(() => {
    window.addEventListener('garden-draft-policy', requestRefresh);
    return () => window.removeEventListener('garden-draft-policy', requestRefresh);
  }, [requestRefresh]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        if (isNativeClient()) {
          const native = await import('./native');
          const status = await native.nativeStatus();
          if (!alive) return;
          setNativeState(status);
          if (status && !status.connected) {
            setLoading(false);
            return;
          }
          const details = await native.nativeBootstrap();
          if (!alive) return;
          setNativePairingCode(details.pairingCode ?? '');
        }
        await refresh();
      } catch (cause) {
        if (alive) {
          setError(cause);
          setLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [refresh]);
  useEffect(() => {
    if (!bootstrap) return;
    void refreshDecisions();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refresh();
        void refreshDecisions();
      }
    }, 15000);
    return () => clearInterval(timer);
  }, [Boolean(bootstrap), refresh, refreshDecisions]);
  useEffect(() => {
    if (palette === 'field') delete document.documentElement.dataset.palette;
    else document.documentElement.dataset.palette = palette;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', getComputedStyle(document.documentElement).backgroundColor);
    try {
      localStorage.setItem('garden-palette', palette);
    } catch {
      /* Appearance remains available without storage. */
    }
  }, [palette]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', getComputedStyle(document.documentElement).backgroundColor);
    try {
      localStorage.setItem('garden-theme', theme);
    } catch {
      /* Appearance remains available without storage. */
    }
  }, [theme]);
  useEffect(() => {
    const online = () => {
      setOffline(false);
      requestRefresh();
    };
    const offline = () => setOffline(true);
    const visible = () => {
      if (document.visibilityState === 'visible') requestRefresh();
    };
    const pop = () => {
      if (fileNavigationBlocked()) {
        history.pushState({}, '', navigationUrl.current);
        window.dispatchEvent(new Event('garden:surface-location'));
        return;
      }
      navigationUrl.current = location.pathname + location.search + location.hash;
      const next = initialNavigation();
      if (
        next.view === 'computer' ||
        new URLSearchParams(location.search).get('behind') === 'computer'
      )
        setComputerOpened(true);
      setNavigation(next);
    };
    const surface = () => {
      navigationUrl.current = location.pathname + location.search + location.hash;
    };
    window.addEventListener('garden:surface-location', surface);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('popstate', pop);
    return () => {
      window.removeEventListener('garden:surface-location', surface);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('popstate', pop);
    };
  }, [requestRefresh]);
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    return subscribeWorkerNavigation(
      navigator.serviceWorker,
      location.origin,
      (taskId) => (taskId ? openTask(taskId) : navigate('work')),
      requestRefresh
    );
  }, [requestRefresh]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((current) => !current);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        setNewWork(true);
      }
      const target = event.target as HTMLElement | null;
      if (
        event.key === '?' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !target?.closest('input, textarea, select, [contenteditable="true"], dialog[open]')
      ) {
        event.preventDefault();
        setKeysOpen(true);
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    if (
      !navigation.taskId ||
      !bootstrap ||
      bootstrap.tasks.some((task) => task.id === navigation.taskId)
    )
      return;
    const controller = new AbortController();
    void get<Task>(`/v1/tasks/${navigation.taskId}`, { signal: controller.signal })
      .then((task) => {
        if (controller.signal.aborted) return;
        setBootstrap((current) =>
          current ? { ...current, tasks: [task, ...current.tasks] } : current
        );
        if (
          bootstrap.workspaces.some(
            (workspace) => workspace.id === (task.parentWorkspaceId ?? task.workspaceId)
          )
        )
          setWorkspaceId(task.parentWorkspaceId ?? task.workspaceId);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err);
      });
    return () => controller.abort();
  }, [navigation.taskId, bootstrap?.tasks.some((task) => task.id === navigation.taskId)]);
  useEffect(() => {
    if (!workspaceId || !bootstrap || authRequired) return;
    const heartbeat = () => {
      void post(`/v1/workspaces/${workspaceId}/heartbeat`, {}).catch(() => undefined);
    };
    heartbeat();
    const timer = setInterval(heartbeat, 60000);
    return () => clearInterval(timer);
  }, [workspaceId, Boolean(bootstrap), authRequired]);
  const sheetTitle = sheetTitles[navigation.view];
  const baseView = sheetTitle
    ? new URLSearchParams(location.search).get('behind') === 'computer'
      ? 'computer'
      : 'work'
    : navigation.view;
  function navigate(view: View, taskId: string | null = null, projectId: string | null = null) {
    if (fileNavigationBlocked()) return;
    const floating = Boolean(sheetTitles[view]);
    if (view === 'computer') setComputerOpened(true);
    const params = floating ? new URLSearchParams(location.search) : new URLSearchParams();
    if (!floating) {
      if (taskId) params.set('task', taskId);
      if (projectId) params.set('project', projectId);
    } else {
      taskId = navigation.taskId;
      projectId = navigation.projectId;
      params.delete('section');
      if (baseView === 'computer') params.set('behind', 'computer');
    }
    if (view !== 'work') params.set('view', view);
    setNavigation({ view, taskId, projectId });
    navigationUrl.current = `${location.pathname}${params.size ? '?' + params.toString() : ''}`;
    const depth = sheetHistoryDepth();
    history.pushState(
      floating ? { gardenSheetDepth: sheetTitle && depth > 0 ? depth + 1 : 1 } : {},
      '',
      navigationUrl.current
    );
    window.dispatchEvent(new Event('garden:surface-location'));
  }
  function closeSheet() {
    if (fileNavigationBlocked()) return;
    const depth = sheetHistoryDepth();
    if (depth > 0) {
      history.go(-depth);
      return;
    }
    const params = new URLSearchParams(location.search);
    for (const key of ['view', 'section', 'behind']) params.delete(key);
    if (baseView === 'computer') params.set('view', 'computer');
    navigationUrl.current = `${location.pathname}${params.size ? '?' + params.toString() : ''}`;
    history.replaceState({}, '', navigationUrl.current);
    setNavigation(initialNavigation());
    window.dispatchEvent(new Event('garden:surface-location'));
  }
  const workspace =
    bootstrap?.workspaces.find((item) => item.id === workspaceId) ??
    bootstrap?.workspaces[0] ??
    null;
  const task = bootstrap?.tasks.find((item) => item.id === navigation.taskId) ?? null;
  const activeProjectId = task?.projectId ?? navigation.projectId;
  const taskWorkspace =
    bootstrap?.workspaces.find((item) => item.id === task?.workspaceId) ??
    (task && taskWorkspaces.ownerId === bootstrap?.user.id
      ? taskWorkspaces.values[task.workspaceId]
      : null);
  const computerWorkspace = navigation.taskId ? (taskWorkspace ?? null) : workspace;
  useEffect(() => {
    const ownerId = bootstrap?.user.id;
    if (!task || taskWorkspace || !ownerId) return;
    const controller = new AbortController();
    void get<Workspace>(`/v1/workspaces/${task.workspaceId}`, { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted || bootstrapRef.current?.user.id !== ownerId) return;
        setTaskWorkspaces((current) => ({
          ownerId,
          values: { ...(current.ownerId === ownerId ? current.values : {}), [value.id]: value }
        }));
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      });
    return () => controller.abort();
  }, [task?.workspaceId, taskWorkspace?.id, bootstrap?.user.id]);
  function openTask(id: string, projectId: string | null = null) {
    if (fileNavigationBlocked()) return;
    const target = bootstrapRef.current?.tasks.find((item) => item.id === id);
    if (
      target &&
      bootstrapRef.current?.workspaces.some(
        (item) => item.id === (target.parentWorkspaceId ?? target.workspaceId)
      )
    )
      setWorkspaceId(target.parentWorkspaceId ?? target.workspaceId);
    navigate('work', id, projectId ?? target?.projectId ?? null);
  }
  function updateTask(next: Task, open = false) {
    if (deletedTasks.current.has(next.id)) return;
    setBootstrap((current) =>
      current
        ? { ...current, tasks: [next, ...current.tasks.filter((item) => item.id !== next.id)] }
        : current
    );
    if (open || next.id !== navigation.taskId) openTask(next.id, next.projectId);
  }
  function saveDraft(draft: Draft) {
    setDrafts((current) => ({ ...current, [draft.taskId ?? `new:${draft.workspaceId}`]: draft }));
  }
  function changeFilter(value: typeof filter) {
    setFilter(value);
  }

  if (nativeState && !nativeState.connected)
    return (
      <Suspense fallback={<Spinner label="Opening connection setup…" />}>
        <NativeSetup
          initialStatus={nativeState}
          onConnected={(details) => {
            setNativePairingCode(details.pairingCode ?? '');
            setNativeState((current) => (current ? { ...current, connected: true } : null));
            setLoading(true);
            void refresh();
          }}
        />
      </Suspense>
    );
  if (loading && !bootstrap)
    return (
      <div className="startup">
        <Brand />
        <Spinner label="Opening your workspace…" />
      </div>
    );
  if (authRequired)
    return (
      <Suspense fallback={<Spinner label="Opening sign-in…" />}>
        <Login
          pairingCode={nativePairingCode}
          onAuthenticated={() => {
            setLoading(true);
            setNativePairingCode('');
            void refresh();
          }}
          theme={theme}
          toggleTheme={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
        />
      </Suspense>
    );
  if (!bootstrap)
    return (
      <main className="startup">
        <Brand />
        <ErrorNotice
          error={error}
          onRetry={() => (isNativeClient() ? location.reload() : void refresh())}
        />
      </main>
    );
  const attentionTasks = bootstrap.tasks.filter(needsAttention);
  const attentionCount = new Set([
    ...decisions.map((decision) => decision.taskId),
    ...attentionTasks.map((item) => item.id)
  ]).size;
  return (
    <div
      className={`garden-shell desk-shell ${task && baseView === 'work' ? 'task-open' : ''} ${activeProjectId && baseView === 'work' ? 'has-project' : ''}`}
    >
      <a className="skip-link" href="#main">
        Skip to work
      </a>
      <header className="garden-masthead">
        <button
          className="brand-button"
          onClick={() => navigate('work')}
          aria-label="garden · Home"
        >
          <Brand />
        </button>
        <nav className="desk-navigation" aria-label="Workspace navigation">
          {(
            [
              ['projects', 'Projects', FolderOpen],
              ['library', 'Library', LibraryBig],
              ['computer', 'Computer', Monitor],
              ['automations', 'Automations', Clock3]
            ] as const
          ).map(([view, label, Icon]) => (
            <Button
              key={view}
              aria-label={label}
              {...(view === 'computer'
                ? { 'aria-current': baseView === 'computer' ? ('page' as const) : undefined }
                : {
                    'aria-haspopup': 'dialog' as const,
                    'aria-expanded': navigation.view === view
                  })}
              onClick={() => navigate(view)}
            >
              <Icon size={17} />
              <span>{label}</span>
            </Button>
          ))}
        </nav>
        <div className="garden-masthead-end">
          <Button
            className="global-search"
            onClick={() => setSearchOpen(true)}
            aria-label="Find anything"
          >
            <Search size={17} />
            <span>Find</span>
            <kbd>⌘K</kbd>
          </Button>
          <Stats
            bootstrap={bootstrap}
            workspace={workspace}
            onComputer={() => navigate('computer')}
          />
          <Button
            className={`masthead-bell ${navigation.view === 'attention' ? 'selected' : ''}`}
            data-perch-bell
            onClick={() => navigate('attention')}
            aria-label={`${attentionCount} work items need attention`}
          >
            {attentionCount > 0 ? (
              <Sprite frames={bellBird} fps={0.6} className="bell-bird" />
            ) : (
              <Bell size={18} />
            )}
            {attentionCount > 0 && <span className="notification-count">{attentionCount}</span>}
          </Button>
          <Button
            aria-label="Settings"
            aria-haspopup="dialog"
            aria-expanded={navigation.view === 'settings'}
            onClick={() => navigate('settings')}
          >
            <Cog size={18} />
          </Button>
        </div>
      </header>
      {offline && (
        <div className="offline-banner" role="status">
          You’re offline. Your work continues on the computer; updates will reconnect here.
        </div>
      )}
      <main id="main" className={`garden-main view-${baseView}`}>
        <ErrorNotice
          context="Could not refresh the workspace."
          error={error}
          onRetry={requestRefresh}
        />
        <Suspense fallback={<Spinner label="Opening this surface…" />}>
          {baseView === 'work' &&
            (activeProjectId ? (
              <ProjectSpace
                onComputer={(id, surface, tabId) => {
                  if (tabId) sessionStorage.setItem(`garden:open-tab:${id}`, tabId);
                  setTool(surface);
                  navigate('work', id, activeProjectId);
                  setSurfaceLocation({ panel: 'tools', tool: surface }, true);
                }}
                key={activeProjectId}
                projectId={activeProjectId}
                {...(navigation.taskId ? { taskId: navigation.taskId } : {})}
                {...(task ? { currentTask: task } : {})}
                revision={
                  task?.updatedAt ??
                  bootstrap.projects?.find((p) => p.id === activeProjectId)?.updatedAt ??
                  ''
                }
                onAllProjects={() => navigate('work')}
                onOverview={() => navigate('work', null, activeProjectId)}
                onTask={(id) => openTask(id, activeProjectId)}
                onNewConversation={(project, source) =>
                  setNewConversation({ project, ...(source ? { source } : {}) })
                }
                onRefresh={requestRefresh}
              >
                {navigation.taskId &&
                  (task && taskWorkspace ? (
                    <TaskSurface
                      key={task.id}
                      task={task}
                      workspace={taskWorkspace}
                      bootstrap={bootstrap}
                      decisions={decisions}
                      {...(drafts[task.id] ? { draft: drafts[task.id] } : {})}
                      onDraft={saveDraft}
                      onTask={updateTask}
                      onRefresh={requestRefresh}
                      onBack={() => navigate('work', null, task.projectId)}
                      onDiscuss={(source) => {
                        void get<Project>(`/v1/projects/${task.projectId}`)
                          .then((project) => setNewConversation({ project, source }))
                          .catch(setError);
                      }}
                      onOpenTask={openTask}
                      onComputer={(nextTool) => {
                        setTool(nextTool);
                        setSurfaceLocation({
                          panel: nextTool === 'files' ? 'files' : 'tools',
                          tool: nextTool
                        });
                      }}
                    />
                  ) : (
                    <Spinner label="Opening conversation…" />
                  ))}
              </ProjectSpace>
            ) : navigation.taskId ? (
              <Spinner label="Opening project…" />
            ) : (
              <DeskHome
                projects={(bootstrap.projects ?? []).filter(
                  (project) => project.parentWorkspaceId === workspaceId
                )}
                tasks={bootstrap.tasks.filter(
                  (item) =>
                    !item.archivedAt &&
                    (item.workspaceId === workspaceId ||
                      bootstrap.projects?.some(
                        (project) =>
                          project.id === item.projectId && project.parentWorkspaceId === workspaceId
                      ))
                )}
                onTask={openTask}
                onProject={(id) => navigate('work', null, id)}
                onProjects={() => navigate('projects')}
                onAttention={() => navigate('attention')}
                onNew={() => setNewWork(true)}
                notice={
                  <>
                    {!bootstrap.instance.providerConfigured && (
                      <div className="setup-note">
                        <Sparkles size={20} />
                        <div>
                          <h3>Connect your model provider.</h3>
                          <Button
                            onClick={() => {
                              navigate('settings');
                              setSurfaceLocation({ section: 'Models' }, true);
                            }}
                          >
                            Connect provider <ArrowUpRight size={14} />
                          </Button>
                        </div>
                      </div>
                    )}
                    {workspace && workspace.status !== 'running' && (
                      <div className="setup-note">
                        <p>This computer is {workspace.status}.</p>
                        {workspace.status === 'hibernated' && (
                          <Button
                            onClick={async () => {
                              try {
                                await post(`/v1/workspaces/${workspace.id}/resume`, {});
                                requestRefresh();
                              } catch (cause) {
                                setError(cause);
                              }
                            }}
                          >
                            Wake computer
                          </Button>
                        )}
                      </div>
                    )}
                  </>
                }
                composer={
                  workspace && !newWork ? (
                    <Composer
                      key={`new:${workspace.id}`}
                      workspace={workspace}
                      bootstrap={bootstrap}
                      {...(drafts[`new:${workspace.id}`]
                        ? { initialDraft: drafts[`new:${workspace.id}`] }
                        : {})}
                      onDraft={saveDraft}
                      onSent={(next) => {
                        updateTask(next);
                        requestRefresh();
                      }}
                    />
                  ) : (
                    <Button onClick={() => setNewWork(true)}>
                      Start a project <Plus size={16} />
                    </Button>
                  )
                }
              />
            ))}
          {computerOpened && (
            <section hidden={baseView !== 'computer'}>
              {navigation.taskId && !computerWorkspace ? (
                <Spinner />
              ) : (
                <Computer
                  key={computerWorkspace?.id}
                  workspace={computerWorkspace}
                  task={task}
                  initialTool={tool}
                  visible={baseView === 'computer' && !sheetTitle}
                  onChange={requestRefresh}
                />
              )}
            </section>
          )}
        </Suspense>
      </main>
      <nav className="phone-bar" aria-label="Sections">
        {(
          [
            ['work', 'Home', House],
            ['projects', 'Projects', FolderOpen],
            ['attention', 'Needs you', Bell],
            ['computer', 'Computer', Monitor],
            ['library', 'Library', LibraryBig]
          ] as const
        ).map(([view, label, Icon]) => (
          <button
            type="button"
            key={view}
            aria-label={label}
            aria-current={
              (
                view === 'work'
                  ? navigation.view === 'work' && !navigation.taskId && !activeProjectId
                  : navigation.view === view
              )
                ? 'page'
                : undefined
            }
            onClick={() => navigate(view)}
            {...(view === 'attention' ? { 'data-perch-bell': true } : {})}
          >
            <Icon size={20} />
            <span>{label}</span>
            {view === 'attention' && attentionCount > 0 && (
              <span className="notification-count">{attentionCount}</span>
            )}
          </button>
        ))}
      </nav>
      <Suspense fallback={null}>
        <GardenLife />
      </Suspense>
      {sheetTitle && (
        <Dialog
          title={sheetTitle}
          onClose={closeSheet}
          className={`desk-sheet desk-sheet-${navigation.view}`}
          dismissOnBackdrop
        >
          <Suspense fallback={<Spinner label={`Opening ${sheetTitle.toLowerCase()}…`} />}>
            {navigation.view === 'projects' && (
              <section className="overview projects-index desk-project-index">
                <header className="management-heading">
                  <h1>Projects</h1>
                  <Button onClick={() => navigate('automations')}>
                    <Clock3 size={15} />
                    Automations
                  </Button>
                  <Button className="primary" onClick={() => setNewWork(true)}>
                    <Plus size={16} />
                    New project
                  </Button>
                </header>
                {bootstrap.workspaces.length > 1 && (
                  <select
                    aria-label="Project computer"
                    value={workspaceId}
                    onChange={(event) => {
                      setWorkspaceId(event.target.value);
                      navigate('work');
                    }}
                  >
                    {bootstrap.workspaces.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                )}
                <div className="work-filter">
                  <div className="segmented" aria-label="Filter work">
                    {(['active', 'running', 'complete', 'archived'] as const).map((value) => (
                      <button
                        key={value}
                        aria-pressed={filter === value}
                        onClick={() => changeFilter(value)}
                      >
                        {value === 'active'
                          ? 'All projects'
                          : value === 'complete'
                            ? 'Idle'
                            : value.charAt(0).toUpperCase() + value.slice(1)}
                      </button>
                    ))}
                  </div>
                  <label className="inline-search">
                    <Search size={15} />
                    <input
                      aria-label="Filter work by title"
                      placeholder="Find work…"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </label>
                </div>
                <ProjectCollection
                  initial={bootstrap.projects ?? []}
                  cursor={bootstrap.projectsCursor ?? null}
                  currentProjectId={null}
                  currentTaskId={null}
                  workspaceId={workspaceId}
                  search={search}
                  filter={filter}
                  mode="grid"
                  onProject={(id) => navigate('work', null, id)}
                  onTask={openTask}
                />
              </section>
            )}
            {navigation.view === 'automations' && (
              <section className="management-page">
                <header className="management-heading">
                  <p className="eyebrow">While you’re away</p>
                  <h1>Automations</h1>
                  <p className="muted">Schedule useful work and return to the results.</p>
                </header>
                <div className="management-content">
                  <Automations
                    workspace={workspace}
                    onOpenTask={openTask}
                    onChange={requestRefresh}
                  />
                </div>
              </section>
            )}
            {navigation.view === 'library' && (
              <Library
                workspace={workspace}
                onOpenTask={openTask}
                onChange={requestRefresh}
                projects={bootstrap.projects ?? []}
                knownTasks={bootstrap.tasks}
                onTaskDeleted={(id) => {
                  deletedTasks.current.add(id);
                  setBootstrap((current) =>
                    current
                      ? { ...current, tasks: current.tasks.filter((task) => task.id !== id) }
                      : current
                  );
                }}
              />
            )}
            {navigation.view === 'settings' && (
              <Settings
                workspace={workspace}
                onChange={requestRefresh}
                theme={theme}
                onThemeChange={setTheme}
                palette={palette}
                onPaletteChange={setPalette}
                onComputer={() => navigate('computer')}
              />
            )}
            {navigation.view === 'attention' && (
              <section>
                <div className="section-intro">
                  <div className="eyebrow">Your attention, well spent</div>
                  <h1>Needs you</h1>
                  <p className="muted">
                    Questions, requests and interrupted work. Open an item to see what it needs.
                  </p>
                </div>
                <DecisionQueue
                  decisions={decisions}
                  tasks={bootstrap.tasks}
                  onResolved={requestRefresh}
                  onOpenTask={openTask}
                />
                {attentionTasks
                  .filter((item) => !decisions.some((decision) => decision.taskId === item.id))
                  .sort(
                    (a, b) =>
                      Number(Boolean(b.hasOpenQuestion || b.status === 'awaiting_user')) -
                        Number(Boolean(a.hasOpenQuestion || a.status === 'awaiting_user')) ||
                      b.updatedAt.localeCompare(a.updatedAt)
                  )
                  .map((item) => (
                    <button
                      className="attention-task cursor-row"
                      key={item.id}
                      onClick={() => openTask(item.id)}
                    >
                      <span>
                        <small>
                          {item.hasOpenQuestion
                            ? 'Answer a question'
                            : item.status === 'awaiting_user'
                              ? 'Review request'
                              : 'Recover interrupted work'}{' '}
                          · {shortDate(item.updatedAt)}
                        </small>
                        <strong>{item.title}</strong>
                        <small>{item.activity?.latest ?? taskStatusLabel(item)}</small>
                      </span>
                      <ArrowUpRight size={20} />
                    </button>
                  ))}
                {attentionCount === 0 && (
                  <Empty title="Nothing needs you right now.">
                    Your active work can carry on. Come back when there’s something worth deciding.
                  </Empty>
                )}
              </section>
            )}
          </Suspense>
        </Dialog>
      )}
      {newConversation && (
        <Suspense fallback={<Spinner />}>
          <NewConversation
            project={newConversation.project}
            {...(newConversation.source ? { source: newConversation.source } : {})}
            bootstrap={bootstrap}
            {...(drafts[`new:${newConversation.project.workspaceId}`]
              ? { draft: drafts[`new:${newConversation.project.workspaceId}`] }
              : {})}
            onDraft={saveDraft}
            onClose={() => setNewConversation(null)}
            onSent={(next) => {
              setNewConversation(null);
              updateTask(next);
              requestRefresh();
            }}
          />
        </Suspense>
      )}
      {newWork && workspace && (
        <Dialog title="Begin something new" onClose={() => setNewWork(false)}>
          <Suspense fallback={<Spinner />}>
            <Composer
              key={`new:${workspace.id}`}
              workspace={workspace}
              bootstrap={bootstrap}
              {...(drafts[`new:${workspace.id}`]
                ? { initialDraft: drafts[`new:${workspace.id}`] }
                : {})}
              onDraft={saveDraft}
              onSent={(next) => {
                setNewWork(false);
                updateTask(next, true);
                requestRefresh();
              }}
            />
          </Suspense>
        </Dialog>
      )}
      {keysOpen && (
        <Dialog title="Keys" onClose={() => setKeysOpen(false)}>
          <dl className="key-list">
            {(
              [
                ['⌘ K', 'Find anything, jump anywhere, change the screen'],
                ['⌘ J', 'Start a new project'],
                ['⌘ ⏎', 'Send what you have typed'],
                ['Esc', 'Close the sheet or panel in front'],
                ['Tab', 'Move between controls; the pointer follows'],
                ['?', 'Show these keys']
              ] as const
            ).map(([keys, meaning]) => (
              <div key={keys}>
                <dt>
                  <kbd>{keys}</kbd>
                </dt>
                <dd>{meaning}</dd>
              </div>
            ))}
          </dl>
        </Dialog>
      )}
      {searchOpen && (
        <Suspense fallback={<Spinner label="Opening search…" />}>
          <SearchDialog
            workspace={workspace}
            tasks={bootstrap.tasks}
            onClose={() => setSearchOpen(false)}
            onTask={(id) => {
              setSearchOpen(false);
              openTask(id);
            }}
            onView={(view) => {
              setSearchOpen(false);
              navigate(view);
            }}
            onNew={() => {
              setSearchOpen(false);
              setNewWork(true);
            }}
            settings={[
              {
                label: theme === 'dark' ? 'Theme — light mode' : 'Theme — dark mode',
                action: () => setTheme(theme === 'dark' ? 'light' : 'dark')
              },
              ...palettes
                .filter((item) => item.value !== palette)
                .map((item) => ({
                  label: `Palette — ${item.label}`,
                  action: () => setPalette(item.value)
                })),
              ...(['lively', 'calm', 'still'] as const).map((mode) => ({
                label: `Garden life — ${mode}`,
                action: () => setLifeMode(mode)
              }))
            ]}
          />
        </Suspense>
      )}
    </div>
  );
}
