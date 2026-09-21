import { recoverDeviceDrafts, forgetDraftKey } from './draft-storage';
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowUpRight,
  Bell,
  FolderOpen,
  Grid2X2,
  Gauge,
  HardDrive,
  MemoryStick,
  PanelLeft,
  X,
  Sparkles,
  Monitor,
  Moon,
  Plus,
  Search,
  Settings2,
  Sun
} from 'lucide-react';
import type { Task, Workspace, Project, ConversationSource } from '@athanor/contracts';
import { get, ApiError, post, isNativeClient } from './client';
import type { NativeStatus } from './native';
import { createTaskNotifier } from './native-notices';
import { subscribeWorkerNavigation } from './worker-navigation';
import Brand from './Brand';
import { fileNavigationBlocked } from './file-navigation';
import { initialNavigation } from './navigation';
import type { View } from './navigation';
import type { Bootstrap, Decision, Draft } from './model';
import {
  hasOngoingWork,
  needsAttention,
  money,
  bytes,
  shortDate,
  taskStatusLabel,
  mergeTaskRefresh
} from './model';
import { Button, Dialog, Empty, ErrorNotice, Spinner } from './ui';
import DecisionQueue from './DecisionQueue';
import ProjectCollection from './ProjectCollection';
import './styles.css';
import './garden.css';
const Composer = lazy(() => import('./Composer'));
const TaskSurface = lazy(() => import('./TaskSurface'));
const ProjectSpace = lazy(() => import('./ProjectSpace'));
const NewConversation = lazy(() => import('./NewConversation'));
const Computer = lazy(() => import('./Computer'));
const Library = lazy(() => import('./Library'));
const Settings = lazy(() => import('./Settings'));
const NativeSetup = lazy(() => import('./NativeSetup'));
import type { ComputerTool as Tool } from './Computer';
const Login = lazy(() => import('./Login'));
const SearchDialog = lazy(() => import('./SearchDialog'));
function initialTheme() {
  try {
    return localStorage.getItem('athanor-theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}
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
  const [theme, setTheme] = useState(initialTheme);
  const [mobile, setMobile] = useState(() => window.innerWidth <= 760);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return window.innerWidth > 760 && localStorage.getItem('garden-sidebar') !== 'closed';
    } catch {
      return window.innerWidth > 760;
    }
  });
  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const resize = () => {
      setMobile(query.matches);
      if (query.matches) setSidebarOpen(false);
    };
    query.addEventListener('change', resize);
    return () => query.removeEventListener('change', resize);
  }, []);
  useEffect(() => {
    if (!mobile || !sidebarOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSidebarOpen(false);
        document.querySelector<HTMLButtonElement>('[aria-controls="garden-sidebar"]')?.focus();
      }
      if (event.key === 'Tab') {
        const items = [
          ...document.querySelectorAll<HTMLElement>(
            '#garden-sidebar button:not(:disabled), #garden-sidebar input, #garden-sidebar a[href]'
          )
        ].filter((item) => item.getClientRects().length > 0);
        const next = event.shiftKey ? items.at(-1) : items[0];
        const boundary = event.shiftKey ? items[0] : items.at(-1);
        if (
          next &&
          (document.activeElement === boundary ||
            !items.includes(document.activeElement as HTMLElement))
        ) {
          event.preventDefault();
          next.focus();
        }
      }
    };
    document.addEventListener('keydown', close);
    document.querySelector<HTMLButtonElement>('.garden-sidebar-close')?.focus();
    return () => document.removeEventListener('keydown', close);
  }, [mobile, sidebarOpen]);
  function toggleSidebar() {
    setSidebarOpen((current) => {
      try {
        localStorage.setItem('garden-sidebar', current ? 'closed' : 'open');
      } catch {
        /* Storage is optional. */
      }
      return !current;
    });
  }
  const [newWork, setNewWork] = useState(false);
  const [newConversation, setNewConversation] = useState<{
    project: Project;
    source?: ConversationSource;
  } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [tool, setTool] = useState<Tool>('files');
  const [computerOpened, setComputerOpened] = useState(initialNavigation().view === 'computer');
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
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      localStorage.setItem('athanor-theme', theme);
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
        return;
      }
      navigationUrl.current = location.pathname + location.search + location.hash;
      const next = initialNavigation();
      if (next.view === 'computer') setComputerOpened(true);
      setNavigation(next);
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('popstate', pop);
    return () => {
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
  function navigate(view: View, taskId: string | null = null, projectId: string | null = null) {
    if (fileNavigationBlocked()) return;
    if (mobile) setSidebarOpen(false);
    if (view === 'computer') setComputerOpened(true);
    setNavigation({ view, taskId, projectId });
    const params = new URLSearchParams();
    if (taskId) params.set('task', taskId);
    if (projectId) params.set('project', projectId);
    if (view !== 'work') params.set('view', view);
    navigationUrl.current = `${location.pathname}${params.size ? '?' + params.toString() : ''}`;
    history.pushState({}, '', navigationUrl.current);
    document.getElementById('main')?.scrollTo({ top: 0, behavior: 'instant' });
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
    if (window.innerWidth <= 760) setSidebarOpen(false);
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
  function updateTask(next: Task) {
    if (deletedTasks.current.has(next.id)) return;
    setBootstrap((current) =>
      current
        ? { ...current, tasks: [next, ...current.tasks.filter((item) => item.id !== next.id)] }
        : current
    );
    if (next.id !== navigation.taskId) openTask(next.id);
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
  const visibleTasks = bootstrap.tasks
    .filter(
      (item) =>
        (item.parentWorkspaceId ?? item.workspaceId) === workspace?.id &&
        (filter === 'archived' ? Boolean(item.archivedAt) : !item.archivedAt)
    )
    .filter((item) =>
      filter === 'running'
        ? hasOngoingWork(item)
        : filter === 'complete'
          ? item.status === 'completed' && item.deliveryStatus !== 'pending'
          : true
    )
    .filter((item) => item.title.toLowerCase().includes(search.toLowerCase()));
  const personalTasks = visibleTasks
    .filter((item) => !item.scheduleId)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  const scheduleTasks = visibleTasks.filter((item) => item.scheduleId);
  return (
    <div
      className={`garden-shell ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'} ${task && navigation.view === 'work' ? 'task-open' : ''}`}
    >
      <a className="skip-link" href="#main">
        Skip to work
      </a>
      <header className="garden-masthead">
        <button
          className="brand-button"
          onClick={() => navigate('work')}
          aria-label="garden · All work"
        >
          <Brand />
        </button>
        <Button
          aria-label={sidebarOpen ? 'Hide projects' : 'Show projects'}
          aria-expanded={sidebarOpen}
          aria-controls="garden-sidebar"
          onClick={toggleSidebar}
        >
          <PanelLeft size={19} />
        </Button>
        <nav className="garden-main-navigation" aria-label="Main navigation">
          {(
            [
              { id: 'work', label: 'Work', icon: Grid2X2 },
              { id: 'library', label: 'Library', icon: FolderOpen },
              { id: 'computer', label: 'Computer', icon: Monitor }
            ] as const
          ).map((item) => (
            <Button
              key={item.id}
              aria-label={item.label}
              className={navigation.view === item.id ? 'selected' : ''}
              aria-current={navigation.view === item.id ? 'page' : undefined}
              onClick={() => navigate(item.id, item.id === 'computer' ? navigation.taskId : null)}
            >
              <item.icon size={16} />
              <span>{item.label}</span>
            </Button>
          ))}
        </nav>
        <ComputerStatus bootstrap={bootstrap} workspace={workspace} />
        <div className="garden-masthead-end">
          <Button
            className="global-search"
            onClick={() => setSearchOpen(true)}
            aria-label="Find anything"
          >
            <Search size={17} />
            <span>Find anything</span>
            <kbd>⌘ K</kbd>
          </Button>
          <Button
            className={navigation.view === 'attention' ? 'selected' : ''}
            onClick={() => navigate('attention')}
            aria-label={`${attentionCount} work items need attention`}
          >
            <Bell size={18} />
            {attentionCount > 0 && <span className="notification-count">{attentionCount}</span>}
          </Button>
          <Button
            aria-label="Settings"
            className={navigation.view === 'settings' ? 'selected' : ''}
            onClick={() => navigate('settings')}
          >
            <Settings2 size={18} />
          </Button>
        </div>
      </header>
      {sidebarOpen && (
        <button
          className="garden-sidebar-scrim"
          aria-label="Close projects"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        id="garden-sidebar"
        className="garden-sidebar"
        aria-label="Projects"
        inert={!sidebarOpen}
      >
        <div className="garden-sidebar-heading">
          <span className="eyebrow">Your projects</span>
          <Button
            className="garden-sidebar-close"
            aria-label="Close projects"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={16} />
          </Button>
        </div>
        <Button
          className="garden-new-work"
          onClick={() => {
            setNewWork(true);
            if (window.innerWidth <= 760) setSidebarOpen(false);
          }}
        >
          <Plus size={16} />
          Plant an idea
        </Button>
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
        <button
          className={`garden-sidebar-home ${navigation.view === 'work' && !task ? 'selected' : ''}`}
          onClick={() => {
            navigate('work');
            if (window.innerWidth <= 760) setSidebarOpen(false);
          }}
        >
          <Grid2X2 size={15} />
          Overview<span>{bootstrap.projects?.length ?? 0}</span>
        </button>
        <label className="garden-sidebar-search">
          <Search size={14} />
          <input
            aria-label="Find a project"
            placeholder="Find a project…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <nav className="garden-project-list" aria-label="Project work">
          <ProjectCollection
            initial={bootstrap.projects ?? []}
            cursor={bootstrap.projectsCursor ?? null}
            currentProjectId={navigation.projectId ?? task?.projectId ?? null}
            currentTaskId={task?.id ?? null}
            workspaceId={workspaceId}
            search={search}
            onProject={(id) => navigate('work', null, id)}
            onTask={openTask}
          />
        </nav>
        <div className="garden-sidebar-bottom">
          <Button
            className="garden-sidebar-theme"
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}{' '}
            {theme === 'dark' ? 'Light' : 'Dark'} appearance
          </Button>
        </div>
      </aside>
      {offline && (
        <div className="offline-banner" role="status">
          You’re offline. Your work continues on the computer; updates will reconnect here.
        </div>
      )}
      <main
        id="main"
        inert={mobile && sidebarOpen}
        className={`garden-main view-${navigation.view}`}
      >
        <ErrorNotice error={error} onRetry={requestRefresh} />
        <Suspense fallback={<Spinner label="Opening this surface…" />}>
          {navigation.view === 'work' &&
            (activeProjectId ? (
              <ProjectSpace
                onComputer={(id, surface, tabId) => {
                  if (tabId) sessionStorage.setItem(`garden:open-tab:${id}`, tabId);
                  setTool(surface);
                  navigate('computer', id);
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
                        navigate('computer', task.id);
                      }}
                    />
                  ) : (
                    <Spinner label="Opening conversation…" />
                  ))}
              </ProjectSpace>
            ) : navigation.taskId ? (
              <Spinner label="Opening project…" />
            ) : (
              <section className="overview">
                <div className="overview-top">
                  <div>
                    <div className="eyebrow">{workspace?.name ?? 'Your workspace'}</div>
                    <h1>
                      {personalTasks.length
                        ? 'What’s taking shape.'
                        : 'What would you like to bring to life?'}
                    </h1>
                  </div>
                  <div className="row">
                    {bootstrap.workspaces.length > 1 && (
                      <select
                        aria-label="Computer workspace"
                        value={workspaceId}
                        onChange={(event) => setWorkspaceId(event.target.value)}
                      >
                        {bootstrap.workspaces.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    )}
                    {personalTasks.length > 0 && (
                      <Button className="primary" onClick={() => setNewWork(true)}>
                        <Plus size={17} />
                        New work
                      </Button>
                    )}
                  </div>
                </div>
                {!bootstrap.instance.providerConfigured && (
                  <div className="setup-note">
                    <Sparkles size={24} />
                    <div>
                      <h3>Connect your model provider.</h3>
                      <p>Add your provider credentials to start working.</p>
                    </div>
                    <Button className="primary" onClick={() => navigate('settings')}>
                      Connect provider
                      <ArrowUpRight size={16} />
                    </Button>
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
                          } catch (err) {
                            setError(err);
                          }
                        }}
                      >
                        Wake computer
                      </Button>
                    )}
                  </div>
                )}
                {!bootstrap.projects?.length && filter === 'active' && !search && workspace && (
                  <div className="first-intent">
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
                    <p className="muted">
                      Start with a question, a file, or something you want made.
                    </p>
                  </div>
                )}
                {attentionCount > 0 && (
                  <button className="attention-strip" onClick={() => navigate('attention')}>
                    <span>
                      <Bell size={17} />
                      {attentionCount}{' '}
                      {attentionCount === 1 ? 'piece of work needs' : 'pieces of work need'} your
                      attention
                    </span>
                    <span>
                      Take a look
                      <ArrowUpRight size={16} />
                    </span>
                  </button>
                )}
                {(bootstrap.tasks.length > 0 || filter !== 'active') && (
                  <>
                    <div className="work-filter">
                      <div className="segmented" aria-label="Filter work">
                        {(['active', 'running', 'complete', 'archived'] as const).map((value) => (
                          <button
                            key={value}
                            aria-pressed={filter === value}
                            onClick={() => changeFilter(value)}
                          >
                            {value === 'active'
                              ? 'All work'
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
                  </>
                )}
                {scheduleTasks.length > 0 && (
                  <section className="scheduled-work">
                    <h2>Running on a rhythm</h2>
                    {Array.from(new Set(scheduleTasks.map((item) => item.scheduleId))).map((id) => {
                      const rows = scheduleTasks.filter((item) => item.scheduleId === id);
                      const schedule = bootstrap.schedules.find((item) => item.id === id);
                      return (
                        <details key={id}>
                          <summary>
                            {schedule?.title ?? rows[0]?.title}{' '}
                            <span className="muted">
                              {bootstrap.scheduleRunCounts[id ?? ''] ?? rows.length} runs
                            </span>
                          </summary>
                          <div className="stack">
                            {rows.map((item) => (
                              <Button key={item.id} onClick={() => openTask(item.id)}>
                                {item.title} · {taskStatusLabel(item)} · {shortDate(item.createdAt)}
                                <ArrowUpRight size={14} />
                              </Button>
                            ))}
                          </div>
                        </details>
                      );
                    })}
                  </section>
                )}
              </section>
            ))}
          {navigation.view === 'library' && (
            <Library
              workspace={workspace}
              onOpenTask={openTask}
              onChange={requestRefresh}
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
          {computerOpened && (
            <section hidden={navigation.view !== 'computer'}>
              {navigation.taskId && !computerWorkspace ? (
                <Spinner />
              ) : (
                <Computer
                  key={computerWorkspace?.id}
                  workspace={computerWorkspace}
                  task={task}
                  initialTool={tool}
                  visible={navigation.view === 'computer'}
                  onChange={requestRefresh}
                />
              )}
            </section>
          )}
          {navigation.view === 'settings' && (
            <Settings workspace={workspace} onChange={requestRefresh} />
          )}
          {navigation.view === 'attention' && (
            <section>
              <div className="section-intro">
                <div className="eyebrow">Your attention, well spent</div>
                <h1>A moment for your judgement.</h1>
              </div>
              <DecisionQueue
                decisions={decisions}
                tasks={bootstrap.tasks}
                onResolved={requestRefresh}
                onOpenTask={openTask}
              />
              {attentionTasks
                .filter((item) => !decisions.some((decision) => decision.taskId === item.id))
                .map((item) => (
                  <button
                    className="attention-task"
                    key={item.id}
                    onClick={() => openTask(item.id)}
                  >
                    <span>
                      <small>{taskStatusLabel(item)}</small>
                      <strong>{item.title}</strong>
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
      </main>
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
                updateTask(next);
                requestRefresh();
              }}
            />
          </Suspense>
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
          />
        </Suspense>
      )}
    </div>
  );
}
function ComputerStatus({
  bootstrap,
  workspace
}: {
  bootstrap: Bootstrap;
  workspace: Workspace | null;
}) {
  const computer = bootstrap.computer;
  const plan = bootstrap.usage.plan;
  const disk =
    workspace?.hostStorageTotalBytes && workspace.hostStorageAvailableBytes !== undefined
      ? `${Math.round((1 - workspace.hostStorageAvailableBytes / workspace.hostStorageTotalBytes) * 100)}%`
      : null;
  if (!computer && !disk && !bootstrap.usage.plan) return null;
  return (
    <div className="garden-computer-status" aria-label="Computer health">
      {computer && (
        <span title={`CPU load: ${computer.cpuPercent}%`}>
          <Gauge size={13} />
          CPU {computer.cpuPercent}%
        </span>
      )}
      {computer && (
        <span
          title={`${bytes(computer.memoryUsedBytes)} of ${bytes(computer.memoryTotalBytes)} memory used`}
        >
          <MemoryStick size={13} />
          RAM{' '}
          {Math.round((computer.memoryUsedBytes / Math.max(1, computer.memoryTotalBytes)) * 100)}%
        </span>
      )}
      {disk && (
        <span title={`${bytes(workspace!.hostStorageAvailableBytes!)} free on host disk`}>
          <HardDrive size={13} />
          Disk {disk}
        </span>
      )}
      {plan?.windows.map((window, index) => {
        /*
         * Two providers measure two different things, and the strip now renders each in its own
         * unit rather than treating everything as a fraction of a plan. Ollama Cloud publishes how
         * much of a window is used, so a percentage is the whole answer. OpenRouter publishes
         * money, and what an owner wants from money is what is left - so the balance is shown as
         * remaining, which is the number that decides whether the next run starts.
         */
        const remaining =
          window.limit !== null && window.used !== null ? window.limit - window.used : null;
        const label = window.label.startsWith('Session')
          ? 'Session'
          : window.label.startsWith('Weekly')
            ? 'Week'
            : window.label === 'Credit balance'
              ? 'Balance'
              : window.label === 'Key limit'
                ? 'Key'
                : window.label;
        const shown =
          window.unit === 'usd'
            ? remaining === null
              ? window.used === null
                ? '—'
                : `${money(window.used)} used`
              : `${money(remaining)} left`
            : window.used === null
              ? '—'
              : `${Math.round(window.used * 100)}%`;
        const detail =
          window.unit === 'usd'
            ? `${window.label}: ${window.used === null ? 'spend unavailable' : `${money(window.used)} used`}${window.limit === null ? ', no limit set' : ` of ${money(window.limit)}`}`
            : `${window.label}: ${window.used === null ? 'unavailable' : `${Math.round(window.used * 100)}% of plan`}${window.resetsAt ? `, resets at ${new Date(window.resetsAt).toLocaleString()}` : ''}`;
        return (
          <span key={`${window.label}-${index}`} title={detail}>
            <Gauge size={13} />
            {label} {shown}
          </span>
        );
      })}
    </div>
  );
}
