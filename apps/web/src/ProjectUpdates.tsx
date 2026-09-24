import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, GitMerge, Layers, Plus, RefreshCw, Square } from 'lucide-react';
import type {
  ProjectCheck,
  ProjectUpdate,
  ProjectUpdateAction,
  ProjectUpdates as Updates,
  Task
} from '@athanor/contracts';
import ProjectCleanup, { type CleanupRequest } from './ProjectCleanup';
import { get, post } from './client';
import { Button, Dialog, ErrorNotice, Field, Spinner } from './ui';
import { processDuration, processMemory } from './process-display';
import { useVisibleClock } from './visible-clock';
import './project-updates.css';

const ProjectRepositories = lazy(() => import('./ProjectRepositories'));
const DirectoryPanel = lazy(() => import('./DirectoryPanel'));
const ProjectVersionHistory = lazy(() => import('./ProjectVersionHistory'));
const stateLabel: Record<ProjectUpdate['state'], string> = {
  preparing: 'Preparing files',
  publishing: 'Applying update',
  ready: 'Ready for checks',
  conflicted: 'Resolve conflicts',
  checking: 'Checks running',
  checks_failed: 'Checks need attention',
  outdated: 'Newer version available',
  published: 'Applied',
  failed: 'Preparation failed',
  cancelled: 'Cancelled'
};
const canStartChecks = (update: ProjectUpdate) =>
  !update.contentRemoval && ['ready', 'checking', 'checks_failed'].includes(update.state);
const active = (check: ProjectCheck) =>
  ['preparing', 'running', 'verifying'].includes(check.status);
const label = (update: ProjectUpdate) =>
  update.state === 'ready' &&
  update.changeCount === 0 &&
  !update.repositories?.some((repository) => repository.historyChanged)
    ? 'No changed files'
    : update.state === 'ready' &&
        update.checks.length &&
        update.checks.every((check) => check.status === 'passed')
      ? 'Ready to apply'
      : update.state === 'ready' && !update.checks.length
        ? 'No checks declared'
        : stateLabel[update.state];
const stamp = (value: string) => new Date(value).toLocaleString();

export default function ProjectUpdates({
  projectId,
  tasks,
  onTask
}: {
  projectId: string;
  tasks: Task[];
  onTask: (taskId: string) => void;
}) {
  const endpoint = `/v1/projects/${projectId}/updates`;
  const [showRepositories, setShowRepositories] = useState(false);
  const [repositoriesOpened, setRepositoriesOpened] = useState(false);
  const [cleanup, setCleanup] = useState<CleanupRequest | null>(null);
  const [fileCheck, setFileCheck] = useState('');
  const [data, setData] = useState<Updates | null>(null),
    [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<ProjectUpdate | null>(null),
    [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false),
    [taskId, setTaskId] = useState(tasks[0]?.id ?? '');
  const [title, setTitle] = useState(''),
    [paths, setPaths] = useState('workspace'),
    [deletions, setDeletions] = useState('');
  const [resolvedPaths, setResolvedPaths] = useState(''),
    [commands, setCommands] = useState(''),
    [cwd, setCwd] = useState('workspace'),
    [reason, setReason] = useState('');
  const [logs, setLogs] = useState<{ check: string; text: string } | null>(null),
    [history, setHistory] = useState(false);
  const selectedVersion = selected?.publishedRevision
    ? data?.revisions.find((item) => item.id === selected.publishedRevision)
    : null;
  const ticking = (check: ProjectCheck) => ['preparing', 'running'].includes(check.status);
  const clock = useVisibleClock(
    Boolean(
      data?.updates.some((update) => update.checks.some(ticking)) || selected?.checks.some(ticking)
    ),
    1000,
    data?.observedAt
  );
  const previouslyActive = useRef<string[]>([]);
  previouslyActive.current =
    data?.updates
      .filter((update) => update.state === 'preparing' || update.checks.some(active))
      .map((update) => update.id) ?? [];
  const historyCursor = useRef<string | null | undefined>(undefined);
  const revisionCursor = useRef<string | null | undefined>(undefined);
  const activeProject = useRef(projectId);
  activeProject.current = projectId;
  const request = useRef<AbortController | null>(null),
    details = useRef<string | null>(null);
  details.current = selected?.id ?? null;
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const [page, detail] = await Promise.all([
        get<Updates>(endpoint, { signal: controller.signal }),
        details.current
          ? get<ProjectUpdate>(`${endpoint}?updateId=${details.current}`, {
              signal: controller.signal
            })
          : Promise.resolve(null)
      ]);
      const finalStates = await Promise.all(
        previouslyActive.current
          .filter((id) => !page.updates.some((update) => update.id === id))
          .map((id) =>
            get<ProjectUpdate>(`${endpoint}?updateId=${id}`, { signal: controller.signal })
          )
      );
      page.updates.push(...finalStates);
      if (controller.signal.aborted) return;
      setData((previous) =>
        previous
          ? {
              ...page,
              updates: [
                ...page.updates,
                ...previous.updates.filter(
                  (old) => !page.updates.some((update) => update.id === old.id)
                )
              ],
              nextCursor:
                historyCursor.current === undefined ? page.nextCursor : historyCursor.current,
              revisions: [
                ...page.revisions,
                ...previous.revisions.filter(
                  (old) => !page.revisions.some((item) => item.id === old.id)
                )
              ].sort((a, b) => b.number - a.number),
              nextRevisionCursor:
                revisionCursor.current === undefined
                  ? page.nextRevisionCursor
                  : revisionCursor.current
            }
          : page
      );
      if (detail && details.current === detail.id)
        setSelected((previous) =>
          previous?.id === detail.id &&
          previous.candidateDigest === detail.candidateDigest &&
          previous.changes.length > detail.changes.length
            ? {
                ...detail,
                changes: [...detail.changes, ...previous.changes.slice(detail.changes.length)],
                nextChange: previous.nextChange
              }
            : detail
        );
      setError(null);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause);
    }
  }, [endpoint]);
  useEffect(() => {
    historyCursor.current = undefined;
    revisionCursor.current = undefined;
    setData(null);
    setSelected(null);
    setLogs(null);
    setError(null);
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 15_000);
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      request.current?.abort();
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);
  const act = async (operation: ProjectUpdateAction, conversation?: string) => {
    const result = await post<ProjectUpdate>(endpoint, {
      operation,
      ...(conversation ? { taskId: conversation } : {})
    });
    return result;
  };
  const perform = async (key: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  };
  const inspect = (id: string) =>
    void perform(id, async () => {
      const detail = await get<ProjectUpdate>(`${endpoint}?updateId=${id}`);
      setSelected(detail);
      setLogs(null);
      setReason('');
    });
  const pending =
    data?.updates.filter((update) => !['published', 'cancelled'].includes(update.state)) ?? [];
  const rows = history ? (data?.updates ?? []) : pending;
  const running = data?.updates.flatMap((update) => update.checks).filter(active).length ?? 0;
  const checkTime = (check: ProjectCheck) =>
    processDuration(
      (check.status === 'preparing' && check.startedAt
        ? Math.max(0, clock - Date.parse(check.startedAt))
        : check.ranForMs) +
        (check.status === 'running' && data?.observedAt
          ? Math.max(0, clock - Date.parse(data.observedAt))
          : 0)
    );
  return (
    <section className="project-updates" aria-label="Project updates and checks">
      <div className="project-section-heading">
        <div>
          <h2>
            <Layers size={18} /> Project versions
          </h2>
          <p className="muted">
            Review changes, check them, then apply them to the project. This does not publish
            anything online. Running jobs keep their existing inputs.
          </p>
        </div>
        <div className="row">
          <Button
            aria-label="Refresh project updates"
            disabled={!!busy}
            onClick={() => void refresh()}
          >
            <RefreshCw size={15} />
          </Button>
          <Button
            disabled={!tasks.length || !!busy}
            onClick={() => {
              setTaskId(tasks[0]?.id ?? '');
              setCreating(true);
            }}
          >
            <Plus size={15} /> Prepare update
          </Button>
        </div>
      </div>
      <ErrorNotice error={error} onRetry={() => void refresh()} />
      {Boolean(error) && data && (
        <p className="muted">Last known status is shown. Work continues on the server.</p>
      )}
      {!data && !error && <Spinner label="Reading project versions…" />}
      {data && (
        <>
          <div className="project-version-head">
            <GitMerge size={22} />
            <div>
              {data.head ? (
                <>
                  <strong>
                    Version {data.head.number} · {data.head.title}
                  </strong>
                  <small>
                    {data.head.checks.length
                      ? `${data.head.checks.length} ${data.head.checks.length === 1 ? 'check' : 'checks'} passed for this version`
                      : 'Applied by owner without automated checks'}{' '}
                    · {stamp(data.head.createdAt)}
                  </small>
                </>
              ) : (
                <>
                  <strong>No saved project version yet</strong>
                  <small>
                    Conversation results stay in their working areas until you apply a project
                    update.
                  </small>
                </>
              )}
            </div>
            <span>
              {running
                ? `${running} ${running === 1 ? 'check' : 'checks'} running`
                : pending.length
                  ? `${pending.length}${data.nextCursor ? '+' : ''} pending ${pending.length === 1 && !data.nextCursor ? 'update' : 'updates'}`
                  : data.nextCursor
                    ? 'More update history available'
                    : 'No pending updates'}
            </span>
          </div>
          {data.head && (
            <details className="project-version-path">
              <summary>Project files and version history</summary>
              <p>
                Use the exact path below as a fixed input for an analysis. Later publications leave
                it intact.
              </p>
              <code>{data.head.path}</code>
              <Suspense fallback={<Spinner />}>
                <DirectoryPanel
                  readOnlyRoot={{
                    base: `/v1/projects/${projectId}/versions/${data.head.id}`,
                    description: 'Immutable files from this saved project version.',
                    id: data.head.id,
                    name: `Version ${data.head.number}`
                  }}
                />
              </Suspense>
              <Suspense fallback={<Spinner label="Opening version history…" />}>
                <ProjectVersionHistory
                  key={projectId}
                  projectId={projectId}
                  headId={data.head?.id ?? null}
                  revisions={data.revisions}
                  nextCursor={data.nextRevisionCursor}
                  loading={Boolean(busy)}
                  onInspect={inspect}
                  onChanged={(revision) => {
                    if (activeProject.current !== projectId) return;
                    request.current?.abort();
                    setData((previous) =>
                      previous
                        ? {
                            ...previous,
                            head: previous.head?.id === revision.id ? revision : previous.head,
                            revisions: previous.revisions.map((item) =>
                              item.id === revision.id ? revision : item
                            )
                          }
                        : previous
                    );
                  }}
                  onEarlier={() =>
                    void perform('versions', async () => {
                      const page = await get<Updates>(
                        `${endpoint}?revisionsBefore=${data.nextRevisionCursor}`
                      );
                      if (activeProject.current !== projectId) return;
                      revisionCursor.current = page.nextRevisionCursor;
                      setData((previous) =>
                        previous
                          ? {
                              ...previous,
                              revisions: [
                                ...previous.revisions,
                                ...page.revisions.filter(
                                  (item) => !previous.revisions.some((old) => old.id === item.id)
                                )
                              ].sort((a, b) => b.number - a.number),
                              nextRevisionCursor: page.nextRevisionCursor
                            }
                          : previous
                      );
                    })
                  }
                />
              </Suspense>
            </details>
          )}
          <details
            onToggle={(event) => {
              setShowRepositories(event.currentTarget.open);
              if (event.currentTarget.open) setRepositoriesOpened(true);
            }}
            className="project-version-path"
          >
            <summary>Git repositories</summary>
            {repositoriesOpened && (
              <Suspense fallback={<Spinner label="Opening repositories…" />}>
                <ProjectRepositories
                  key={projectId}
                  projectId={projectId}
                  revisionId={data.head?.id ?? null}
                  conversations={tasks}
                  active={showRepositories}
                />
              </Suspense>
            )}
          </details>
          <div className="project-update-list">
            {rows.map((update) => (
              <button
                className="project-update-row"
                key={update.id}
                onClick={() => inspect(update.id)}
              >
                <span className={`project-update-state state-${update.state}`}>
                  {label(update)}
                </span>
                <span className="project-update-title">
                  <strong>{update.title}</strong>
                  <small>
                    {tasks.find((task) => task.id === update.taskId)?.title ?? 'Conversation'} ·{' '}
                    {update.changeCount} changed {update.changeCount === 1 ? 'file' : 'files'} ·{' '}
                    {stamp(update.updatedAt)}
                  </small>
                  {update.lineChanges && (
                    <small className="project-line-changes">
                      <span>+{update.lineChanges.added.toLocaleString()}</span>{' '}
                      <span>−{update.lineChanges.removed.toLocaleString()}</span> lines
                      {update.lineChanges.unmeasuredFiles > 0 &&
                        ` · ${update.lineChanges.unmeasuredFiles} files unmeasured`}
                    </small>
                  )}
                </span>
                <span>
                  {update.state === 'preparing'
                    ? `${update.progress.files} files · ${processMemory(update.progress.bytes)}`
                    : update.checks.length
                      ? update.state === 'outdated'
                        ? 'Earlier checks · rebuild required'
                        : `${update.checks.filter((check) => check.status === 'passed').length}/${update.checks.length} checks passed`
                      : 'No automated checks'}
                </span>
              </button>
            ))}
          </div>
          {!rows.length && (
            <p className="muted">
              {data.head
                ? 'No pending updates. Conversations can keep working independently.'
                : 'Prepare selected files from a conversation, run checks, then apply a project update.'}
            </p>
          )}
          <div className="row">
            <Button onClick={() => setHistory(!history)}>
              {history ? 'Show pending updates' : 'Show all updates'}
            </Button>
            {data.nextCursor && (
              <Button
                disabled={!!busy}
                onClick={() =>
                  void perform('more', async () => {
                    const page = await get<Updates>(`${endpoint}?before=${data.nextCursor}`);
                    historyCursor.current = page.nextCursor;
                    setData((prior) =>
                      prior
                        ? {
                            ...prior,
                            updates: [
                              ...new Map(
                                [...prior.updates, ...page.updates].map((update) => [
                                  update.id,
                                  update
                                ])
                              ).values()
                            ],
                            nextCursor: page.nextCursor
                          }
                        : page
                    );
                  })
                }
              >
                Older updates
              </Button>
            )}
            <small className="muted">Observed {stamp(data.observedAt)}</small>
          </div>
        </>
      )}
      {creating && (
        <Dialog
          title="Prepare a project update"
          onClose={() => {
            if (!busy) setCreating(false);
          }}
        >
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void perform('prepare', async () => {
                const update = await act(
                  {
                    action: 'prepare',
                    requestId: crypto.randomUUID(),
                    update: {
                      title,
                      resolvedPaths: resolvedPaths
                        .split('\n')
                        .map((line) => line.trim())
                        .filter(Boolean),
                      ...(resolvedPaths.trim() && data?.head
                        ? { expectedRevision: data.head.id }
                        : {}),
                      paths: paths
                        .split('\n')
                        .map((line) => line.trim())
                        .filter(Boolean),
                      deletePaths: deletions
                        .split('\n')
                        .map((line) => line.trim())
                        .filter(Boolean),
                      checks: commands
                        .split('\n')
                        .filter((line) => line.trim())
                        .map((command) => ({
                          name: command.slice(0, 120),
                          executable: 'bash',
                          args: ['-lc', command],
                          cwd
                        }))
                    }
                  },
                  taskId
                );
                setCreating(false);
                setSelected(update);
                setTitle('');
              });
            }}
          >
            <p>
              Capture only the files this update should contribute. Other files in the saved project
              stay in place. Credentials, installed dependencies and runtime state are excluded.
            </p>
            <Field label="Conversation">
              <select value={taskId} onChange={(event) => setTaskId(event.target.value)}>
                {tasks.map((task) => (
                  <option value={task.id} key={task.id}>
                    {task.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Update title">
              <input
                required
                maxLength={160}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Describe the result of this update"
              />
            </Field>
            <Field label="Files or directories · one per line">
              <textarea
                required
                rows={3}
                value={paths}
                onChange={(event) => setPaths(event.target.value)}
              />
            </Field>
            <Field label="Check commands · one per line">
              <textarea
                rows={3}
                value={commands}
                onChange={(event) => setCommands(event.target.value)}
                placeholder={'python -m pytest\nnpm test'}
              />
            </Field>
            <p className="muted">
              Each command runs independently against the complete combined candidate. Checks have
              no implicit deadline. Declaring a command does not start it.
            </p>
            <details>
              <summary>Advanced options</summary>
              <div className="stack">
                <Field label="Files with conflicts you have resolved against the current project version">
                  <textarea
                    rows={2}
                    value={resolvedPaths}
                    onChange={(event) => setResolvedPaths(event.target.value)}
                    placeholder="One exact file path per line"
                  />
                </Field>
                <Field label="Check working directory">
                  <input value={cwd} onChange={(event) => setCwd(event.target.value)} />
                </Field>
                <Field label="Explicit deletions · one per line">
                  <textarea
                    rows={3}
                    value={deletions}
                    onChange={(event) => setDeletions(event.target.value)}
                  />
                </Field>
              </div>
            </details>
            <ErrorNotice error={error} />
            <Button className="primary" type="submit" busy={busy === 'prepare'} disabled={!!busy}>
              Prepare files
            </Button>
          </form>
        </Dialog>
      )}
      {selected && !cleanup && (
        <Dialog
          title={selected.title}
          onClose={() => {
            setSelected(null);
            setLogs(null);
          }}
        >
          <div className="stack project-update-detail">
            <div className="row">
              <span className={`project-update-state state-${selected.state}`}>
                {label(selected)}
              </span>
              <Button
                onClick={() => {
                  onTask(selected.taskId);
                  setSelected(null);
                }}
              >
                Open conversation
              </Button>
            </div>
            {selected.detail && <p>{selected.detail}</p>}
            {selected.contentRemoval && (
              <p role="status">
                {selected.contentRemoval.state === 'removed'
                  ? 'Candidate files permanently removed. Their change summary and check receipts remain.'
                  : 'Candidate cleanup is incomplete.'}
              </p>
            )}
            {['published', 'failed', 'cancelled'].includes(selected.state) &&
              selected.contentRemoval?.state !== 'removed' && (
                <Button
                  onClick={() =>
                    setCleanup({
                      selection: { versions: [], updates: [selected.id], checks: [] },
                      ...(selected.contentRemoval
                        ? { requestId: selected.contentRemoval.requestId }
                        : {})
                    })
                  }
                >
                  {selected.contentRemoval ? 'View cleanup' : 'Remove candidate files…'}
                </Button>
              )}
            <p className="muted">
              {selected.parentRevision
                ? `Based on version ${data?.revisions.find((revision) => revision.id === selected.parentRevision)?.number ?? selected.parentRevision}`
                : 'Initial project version'}{' '}
              · {stamp(selected.createdAt)}
            </p>
            {!!selected.repositories?.length && (
              <details>
                <summary>Exact repository commits</summary>
                {selected.repositories.map((repository) => (
                  <div key={repository.repositoryId}>
                    <strong>{repository.branch}</strong>
                    <code>{repository.commit}</code>
                    <small>Tree {repository.tree}</small>
                    <small>Based on {repository.base}</small>
                    {repository.sourceCommit && (
                      <small>Conversation history {repository.sourceCommit}</small>
                    )}
                  </div>
                ))}
              </details>
            )}
            {selected.state === 'publishing' && (
              <div role="status">
                <p>Publication is being completed. The saved operation can be resumed safely.</p>
                <Button
                  disabled={!!busy}
                  onClick={() =>
                    void perform('recover', () =>
                      act({
                        action: 'publish',
                        updateId: selected.id,
                        digest: selected.candidateDigest!
                      })
                    )
                  }
                >
                  Resume publication
                </Button>
              </div>
            )}
            {selected.path && (
              <details>
                <summary>Files in this candidate</summary>
                <code>{selected.path}</code>
                <small>SHA-256 {selected.candidateDigest}</small>
              </details>
            )}
            {selected.state === 'preparing' && (
              <p role="status">
                {selected.progress.stage} · {selected.progress.files} files ·{' '}
                {processMemory(selected.progress.bytes)}
              </p>
            )}
            <h3>Checks</h3>
            {selected.checks.map((check) => (
              <div className="project-check" key={check.id}>
                <div className="project-section-heading">
                  <strong>{check.name}</strong>
                  <span className={`check-status check-${check.status}`}>
                    {check.status === 'passed' && <CheckCircle2 size={14} />}
                    {check.status} {check.startedAt && `· ${checkTime(check)}`}
                  </span>
                </div>
                <details>
                  <summary>Command and evidence</summary>
                  <pre>
                    {[check.executable, ...check.args.map((arg) => JSON.stringify(arg))].join(' ')}
                  </pre>
                  <p>Directory: {check.cwd}</p>
                  <small>Candidate {check.candidateDigest}</small>
                  {check.exitCode !== null && <p>Exit code {check.exitCode}</p>}
                </details>
                {check.detail && <p>{check.detail}</p>}
                {check.contentRemoval && (
                  <p className="muted">
                    {check.contentRemoval.state === 'removed'
                      ? 'Files and output permanently removed. This check receipt is preserved.'
                      : 'Check files are awaiting cleanup.'}
                  </p>
                )}
                {!['pending', 'preparing', 'running', 'verifying'].includes(check.status) &&
                  check.contentRemoval?.state !== 'removed' && (
                    <Button
                      onClick={() =>
                        setCleanup({
                          selection: { versions: [], updates: [], checks: [check.id] },
                          ...(check.contentRemoval
                            ? { requestId: check.contentRemoval.requestId }
                            : {})
                        })
                      }
                    >
                      {check.contentRemoval ? 'View cleanup' : 'Remove check files and output…'}
                    </Button>
                  )}
                {check.sessionId && !check.contentRemoval && (
                  <details
                    onToggle={(event) => {
                      if (event.currentTarget.open) setFileCheck(check.id);
                      else setFileCheck((id) => (id === check.id ? '' : id));
                    }}
                  >
                    <summary>Files produced by this check</summary>
                    {fileCheck === check.id && (
                      <Suspense fallback={<Spinner />}>
                        <DirectoryPanel
                          openRequest={1}
                          readOnlyRoot={{
                            id: check.id,
                            name: check.name,
                            base: `/v1/projects/${projectId}/checks/${selected.id}/${check.id}`,
                            description:
                              'Files from this check. A running check may still be writing results.'
                          }}
                        />
                      </Suspense>
                    )}
                  </details>
                )}
                {check.preparation && (
                  <p role="status">
                    Preparing {check.preparation.files} of {check.preparation.totalFiles} files ·{' '}
                    {processMemory(check.preparation.bytes)} of{' '}
                    {processMemory(check.preparation.totalBytes)}
                  </p>
                )}
                {check.resources && (
                  <small className="muted">
                    {check.resources.cpuPercent === null
                      ? 'CPU sample pending'
                      : `${check.resources.cpuPercent.toFixed(1)}% CPU`}{' '}
                    · {processMemory(check.resources.residentBytes)} RAM · sampled{' '}
                    {stamp(check.resources.sampledAt)}
                  </small>
                )}
                <div className="row">
                  {check.status === 'pending' && canStartChecks(selected) && (
                    <Button
                      disabled={!!busy}
                      onClick={() =>
                        void perform(check.id, () =>
                          act({
                            action: 'check',
                            updateId: selected.id,
                            checkId: check.id,
                            digest: selected.candidateDigest!
                          })
                        )
                      }
                    >
                      Run check
                    </Button>
                  )}
                  {check.sessionId && !check.contentRemoval && (
                    <Button
                      disabled={!!busy}
                      onClick={() =>
                        void perform(`log:${check.id}`, async () => {
                          const output = await post<{ stdout?: string; stderr?: string }>(
                            endpoint,
                            {
                              operation: { action: 'log', updateId: selected.id, checkId: check.id }
                            }
                          );
                          setLogs({
                            check: check.name,
                            text:
                              [output.stdout, output.stderr].filter(Boolean).join('\n') ||
                              'No output yet.'
                          });
                        })
                      }
                    >
                      View output
                    </Button>
                  )}
                  {active(check) && (
                    <Button
                      disabled={!!busy}
                      onClick={() =>
                        void perform(`stop:${check.id}`, () =>
                          act({ action: 'stop', updateId: selected.id, checkId: check.id })
                        )
                      }
                    >
                      <Square size={13} /> Stop check
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {!selected.checks.length && (
              <p>No automated checks were declared. This update has no passing test evidence.</p>
            )}
            {selected.state === 'outdated' && (
              <p>
                Any earlier passing checks apply to the earlier candidate. Rebuild onto the current
                project version, then run its checks again.
              </p>
            )}
            {selected.state === 'conflicted' && (
              <p>
                Open the conversation to resolve the marked files against the current published
                version. Both proposals remain available; no files have been overwritten.
              </p>
            )}
            <details>
              <summary>Changed files ({selected.changeCount})</summary>
              <p className="muted">
                Line counts compare each captured proposal with its conversation’s baseline. Binary
                and oversized files are reported as unmeasured. Edits made after capture belong to
                the next update.
              </p>
              <div className="project-change-list">
                {selected.changes.map((change) => (
                  <details key={change.path}>
                    <summary>
                      {change.conflict ? 'Conflict' : change.merged ? 'Combined' : change.kind} ·{' '}
                      {change.path}
                      {change.lines && ` · +${change.lines.added} −${change.lines.removed}`}
                    </summary>
                    {change.detail && <p>{change.detail}</p>}
                    {change.diff ? (
                      <pre>{change.diff}</pre>
                    ) : (
                      <p>
                        Text preview unavailable for this file. Inspect the captured content and
                        recorded hashes.
                      </p>
                    )}
                    <small>
                      Proposed {change.proposed?.sha256 ?? 'deleted'} · Current{' '}
                      {change.current?.sha256 ?? 'absent'}
                    </small>
                  </details>
                ))}
              </div>
              {selected.nextChange && (
                <Button
                  disabled={!!busy}
                  onClick={() =>
                    void perform('files', async () => {
                      const page = await get<ProjectUpdate>(
                        `${endpoint}?${new URLSearchParams({ updateId: selected.id, changesAfter: selected.nextChange! })}`
                      );
                      setSelected({ ...page, changes: [...selected.changes, ...page.changes] });
                    })
                  }
                >
                  More changed files
                </Button>
              )}
            </details>
            <div className="row">
              {canStartChecks(selected) &&
                selected.checks.some((check) => check.status === 'pending') && (
                  <Button
                    className="primary"
                    disabled={!!busy}
                    onClick={() =>
                      void perform('checks', () =>
                        Promise.all(
                          selected.checks
                            .filter((check) => check.status === 'pending')
                            .map((check) =>
                              act({
                                action: 'check',
                                updateId: selected.id,
                                checkId: check.id,
                                digest: selected.candidateDigest!
                              })
                            )
                        )
                      )
                    }
                  >
                    Run pending checks
                  </Button>
                )}
              {!selected.contentRemoval &&
                ['ready', 'outdated', 'checks_failed', 'failed'].includes(selected.state) && (
                  <Button
                    disabled={!!busy}
                    onClick={() =>
                      void perform('rebase', async () => {
                        const next = await act({
                          action: 'rebase',
                          updateId: selected.id,
                          requestId: crypto.randomUUID()
                        });
                        setSelected(next);
                      })
                    }
                  >
                    Rebuild and reset checks
                  </Button>
                )}
              {selected.state === 'ready' &&
                selected.checks.length > 0 &&
                selected.checks.every((check) => check.status === 'passed') && (
                  <Button
                    className="primary"
                    disabled={!!busy}
                    onClick={() =>
                      void perform('publish', () =>
                        act({
                          action: 'publish',
                          updateId: selected.id,
                          digest: selected.candidateDigest!
                        })
                      )
                    }
                  >
                    Apply checked update
                  </Button>
                )}
              {!selected.contentRemoval &&
                !['publishing', 'published', 'cancelled'].includes(selected.state) && (
                  <Button
                    disabled={!!busy}
                    onClick={() =>
                      void perform('cancel', () => act({ action: 'cancel', updateId: selected.id }))
                    }
                  >
                    Cancel update and its checks
                  </Button>
                )}
            </div>
            {selected.state === 'ready' &&
              !selected.checks.length &&
              (selected.changeCount > 0 ||
                selected.repositories?.some((repository) => repository.historyChanged)) && (
                <details>
                  <summary>Apply without automated checks</summary>
                  <p>
                    This records your decision with the version. It will be labelled as untested.
                  </p>
                  <Field label="Reason">
                    <textarea
                      rows={2}
                      maxLength={600}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </Field>
                  <Button
                    disabled={!!busy || !reason.trim()}
                    onClick={() =>
                      void perform('publish', () =>
                        act({
                          action: 'publish',
                          updateId: selected.id,
                          digest: selected.candidateDigest!,
                          uncheckedReason: reason
                        })
                      )
                    }
                  >
                    Apply untested update
                  </Button>
                </details>
              )}
            {selectedVersion?.contentRemoval && (
              <p>Saved version files were permanently removed. Their history remains available.</p>
            )}
            {selectedVersion?.archive && !selectedVersion.contentRemoval && (
              <p>
                Saved version files are archived. Restore them from version history to browse them.
              </p>
            )}
            {selected.publishedRevision &&
              !selectedVersion?.archive &&
              !selectedVersion?.contentRemoval && (
                <Suspense fallback={<Spinner />}>
                  <DirectoryPanel
                    readOnlyRoot={{
                      id: selected.publishedRevision,
                      name: selected.title,
                      base: `/v1/projects/${projectId}/versions/${selected.publishedRevision}`,
                      description: 'Immutable files from this saved project version.'
                    }}
                  />
                </Suspense>
              )}
            {selected.uncheckedReason && (
              <p>Owner’s publication reason: {selected.uncheckedReason}</p>
            )}
            {logs && (
              <section>
                <h3>{logs.check} · output snapshot</h3>
                <pre className="project-check-output">{logs.text}</pre>
              </section>
            )}
            <ErrorNotice error={error} />
          </div>
        </Dialog>
      )}
      {cleanup && (
        <ProjectCleanup
          projectId={projectId}
          request={cleanup}
          onChanged={() => void refresh()}
          onClose={() => {
            setCleanup(null);
            void refresh();
          }}
        />
      )}
    </section>
  );
}
