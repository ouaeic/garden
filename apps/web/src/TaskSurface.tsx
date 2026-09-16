import { readQuestionDraft, writeQuestionDraft } from './draft-storage';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  FileText,
  GitBranch,
  History,
  MessageSquare,
  MoreHorizontal,
  Pause,
  Square,
  Play,
  Plus,
  Share2,
  Terminal,
  X
} from 'lucide-react';
import type { Artifact, Task, TaskEvent, Workspace, ConversationSource } from '@athanor/contracts';
import type { Bootstrap, Decision, Draft } from './model';
import {
  activeQuestion,
  conversationResultSource,
  data,
  date,
  duration,
  eventText,
  isFinished,
  isWorking,
  lastEvent,
  money,
  statusLabel,
  taskStatusLabel,
  strings,
  surfaceAnswer,
  text
} from './model';
import { post } from './client';
import { loadEventPage } from './stream';
import { useTaskRecord } from './useTaskRecord';
import { Button, Dialog, ErrorNotice, Field, Spinner } from './ui';
import { DecisionCard } from './DecisionQueue';
import { createQuestionAnswerSender } from './task-actions';
import { TaskOutputs, TaskProgress } from './TaskCanvas';
import WorkTrace from './WorkTrace';
import { currentWork } from './current-work';
import { completionChecks, evidenceSource } from './completion-checks';
import MessageAttachmentList from './MessageAttachmentList';
import './presentation.css';
import { effortLabel } from './reasoning-options';
import { resourceWaitReason } from './resource-wait';
const ProjectNoteEditor = lazy(() =>
  import('./ProjectNotes').then((module) => ({ default: module.ProjectNoteEditor }))
);
const ProcessPanel = lazy(() => import('./ProcessPanel'));
const DirectoryPanel = lazy(() => import('./DirectoryPanel'));
const PlanEditor = lazy(() => import('./PlanEditor'));
const TaskOptions = lazy(() => import('./TaskOptions'));
const Trajectory = lazy(() => import('./Trajectory'));
const Markdown = lazy(() => import('./MarkdownBody'));
const Composer = lazy(() => import('./Composer'));
const MediaJobs = lazy(() => import('./MediaJobs'));
const ProjectModels = lazy(() => import('./ProjectModels'));
const CodingMissions = lazy(() => import('./CodingMissions'));
const SubagentLanes = lazy(() => import('./SubagentLanes'));
const SpendBlock = lazy(() => import('./SpendBlock'));
const WorkDirections = lazy(() =>
  import('./WorkDirections').then((module) => ({ default: module.WorkDirections }))
);
const Share = lazy(() => import('./Sharing'));
const ResultPreview = lazy(() =>
  import('./computer/ResultPreview').then((module) => ({ default: module.ResultPreview }))
);
export interface TaskSurfaceProps {
  task: Task;
  workspace: Workspace;
  bootstrap: Bootstrap;
  decisions: Decision[];
  draft?: Draft;
  onDraft: (draft: Draft) => void;
  onTask: (task: Task) => void;
  onRefresh: () => void;
  onBack: () => void;
  onDiscuss?: (source: ConversationSource) => void;
  onOpenTask: (id: string) => void;
  onComputer: (
    tool: 'files' | 'terminal' | 'browser' | 'desktop' | 'previews' | 'processes' | 'checkpoints'
  ) => void;
}
export default function TaskSurface({
  task,
  workspace,
  bootstrap,
  decisions,
  draft,
  onDraft,
  onTask,
  onRefresh,
  onBack,
  onDiscuss,
  onOpenTask,
  onComputer
}: TaskSurfaceProps) {
  const {
    events,
    plan,
    setPlan,
    artifacts,
    storedPresentation,
    initialPage,
    loading,
    error,
    setError,
    connection,
    reload
  } = useTaskRecord({
    taskId: task.id,
    workspaceId: workspace.id,
    finished: isFinished(task),
    onTask,
    onRefresh
  });
  const [preview, setPreview] = useState<Artifact | null>(null);
  const [panel, setPanel] = useState<
    'direction' | 'history' | 'plan' | 'settings' | 'share' | 'brief' | 'models' | 'stop' | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(
    Boolean(draft?.body || draft?.attachments.length)
  );
  const [historyMore, setHistoryMore] = useState(false);
  const [fileRequest, setFileRequest] = useState(0);
  const [historyPage, setHistoryPage] = useState<TaskEvent[]>([]);
  useEffect(() => {
    if (!initialPage) return;
    setHistoryPage(initialPage.events);
    setHistoryMore(initialPage.hasMore);
  }, [initialPage]);
  const [evidence, setEvidence] = useState<TaskEvent | null>(null);
  const [scope, setScope] = useState('');
  const [questionAnswer, setQuestionAnswer] = useState('');
  const [deliverAnswer] = useState(createQuestionAnswerSender);
  const [originalBrief, setOriginalBrief] = useState<TaskEvent | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [noteSource, setNoteSource] = useState<ConversationSource | null>(null);
  const [branchEvent, setBranchEvent] = useState<TaskEvent | null>(null);
  const presentation = currentWork(storedPresentation, events);
  const showComposer = !isFinished(task) || composerExpanded || Boolean(scope);
  /*
   * The run summary's elapsed figure is a live clock, not a snapshot. Re-rendering on a half
   * minute keeps it honest while a task runs; a finished task's duration is fixed and the tick
   * is wasted, so this only runs while the work could still be accruing time.
   */
  const [clock, setClock] = useState(() => Date.now());
  const running = !isFinished(task);
  useEffect(() => {
    if (!running) return;
    const ticker = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(ticker);
  }, [task.id, running]);
  function showArtifact(id: string) {
    const artifact = artifacts.find((item) => item.id === id);
    if (artifact) setPreview(artifact);
    else
      setError(
        new Error(
          'This result metadata is not available. Refresh its recorded results and try again.'
        )
      );
  }
  async function inspectEvidence(id: string) {
    const existing = events.find((event) => event.id === id);
    if (existing) return setEvidence(existing);
    const sequence =
      presentation?.progress.milestones.find((item) => item.id === id)?.sequence ??
      presentation?.surface?.references.find((item) => item.eventId === id)?.sequence ??
      presentation?.surface?.sources.find((item) => item.eventId === id)?.sequence;
    if (sequence === undefined) return;
    try {
      const page = await loadEventPage(task.id, { after: Math.max(0, sequence - 1), limit: 1 });
      const event = page.events.find((item) => item.id === id);
      if (!event) throw new Error('This recorded action is no longer available.');
      setEvidence(event);
    } catch (cause) {
      setError(cause);
    }
  }
  const directionSequence = presentation?.surface?.direction?.sequence ?? 0;
  const currentEvents = events.filter((event) => event.sequence >= directionSequence);
  const answer = surfaceAnswer(currentEvents);
  const previousAnswer = directionSequence
    ? surfaceAnswer(events.filter((event) => event.sequence < directionSequence))
    : null;
  const completionEvent = lastEvent(currentEvents, 'completed');
  const completion = data(completionEvent?.payload);
  const verification = data(completion.verification);
  const checks = completionChecks(verification);
  const acceptance = strings(completion.acceptance);
  const pendingDelivery = (presentation?.delivery?.status ?? task.deliveryStatus) === 'pending';
  const deliveryFailed = (presentation?.delivery?.status ?? task.deliveryStatus) === 'incomplete';
  /*
   * A run can reach `completed` with plan steps still open, and that is deliberate: the finish gate
   * asks about them once and a turn that says in writing which ones it is leaving is allowed to
   * stop. What was not deliberate is the word the owner then read. The panel showed "4 of 7" while
   * the line above it said Complete, and of the two the status line is the one that gets believed -
   * so a run that had done four of seven things announced itself as finished. The count is the
   * honest number, so the label defers to it.
   */
  const openPhases = (presentation?.progress?.phases ?? []).filter(
    (phase) => phase.status !== 'completed' && phase.status !== 'skipped'
  ).length;
  const partlyDone = task.status === 'completed' && openPhases > 0;
  const waitingReason =
    task.status === 'awaiting_resource' ? resourceWaitReason(events, task.resourceWait) : null;
  const displayStatus =
    task.status === 'completed' && pendingDelivery
      ? 'Generating media'
      : task.status === 'completed' && deliveryFailed
        ? 'Delivery needs attention'
        : partlyDone
          ? `Stopped with ${openPhases} step${openPhases === 1 ? '' : 's'} open`
          : (waitingReason?.label ?? taskStatusLabel(task));
  const question = activeQuestion(events, task);
  const questionDraftKey = question ? `garden:question:${task.id}:${question.id}` : null;
  const questionDraftWrites = useRef(Promise.resolve());
  const questionDraftRevision = useRef(0);
  useEffect(() => {
    let active = true;
    const revision = ++questionDraftRevision.current;
    setQuestionAnswer('');
    if (questionDraftKey) {
      questionDraftWrites.current = questionDraftWrites.current
        .then(async () => {
          const value = await readQuestionDraft(bootstrap.user.id, questionDraftKey);
          if (active && revision === questionDraftRevision.current) setQuestionAnswer(value);
        })
        .catch((cause) => {
          if (active) setError(cause);
        });
    }
    return () => {
      active = false;
    };
  }, [questionDraftKey, bootstrap.user.id]);
  function saveQuestionAnswer(value: string) {
    ++questionDraftRevision.current;
    setQuestionAnswer(value);
    if (questionDraftKey)
      questionDraftWrites.current = questionDraftWrites.current
        .then(() => writeQuestionDraft(bootstrap.user.id, questionDraftKey, value))
        .catch(setError);
  }

  const questionData = data(question?.payload);
  const taskDecisions = decisions.filter((decision) => decision.taskId === task.id);
  const latestActivity = [...events]
    .reverse()
    .find((event) =>
      ['tool_started', 'status', 'notice', 'warning', 'error', 'assistant_reasoning'].includes(
        event.kind
      )
    );
  const opening =
    originalBrief ??
    (events[0]?.sequence === 1 ? events.find((event) => event.kind === 'user_message') : undefined);
  /*
   * Everything the owner has said to this task, oldest first: the opening brief and every
   * direction since. This is the answer to "where do I see my inputs" - a follow-up opens a new
   * direction epoch, and without this list the earlier ones are only reachable through the raw
   * activity log.
   */
  const ownerDirections = events.filter((event) =>
    ['user_message', 'queued_message'].includes(event.kind)
  );
  if (opening && !ownerDirections.some((event) => event.id === opening.id))
    ownerDirections.unshift(opening);
  /*
   * How long this has taken. A finished run ends at `completedAt`, not at `updatedAt`: the latter
   * moves when the conversation is renamed, pinned or shared, so a run measured that way keeps
   * growing after it stopped. A run still going has to track the wall clock, and the only state
   * that re-renders this on a tick is `clock` - so that branch reads it rather than Date.now().
   */
  const elapsed = isFinished(task)
    ? duration(task.createdAt, task.completedAt ?? task.updatedAt)
    : duration(task.createdAt, new Date(clock).toISOString());
  useEffect(() => {
    if (panel !== 'brief' || opening) return;
    const controller = new AbortController();
    setBriefLoading(true);
    void loadEventPage(task.id, { after: 0, limit: 20, signal: controller.signal })
      .then((page) => {
        if (!controller.signal.aborted)
          setOriginalBrief(page.events.find((event) => event.kind === 'user_message') ?? null);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBriefLoading(false);
      });
    return () => controller.abort();
  }, [panel, task.id, opening]);
  const notices = events.filter((event) => ['warning', 'error'].includes(event.kind)).slice(-3);
  async function action(value: 'pause' | 'resume' | 'cancel') {
    setBusy(true);
    setError(null);
    try {
      onTask(await post<Task>(`/v1/tasks/${task.id}/${value}`, {}));
      onRefresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  async function answerQuestion(value: string) {
    if (!value.trim() || !question) return;
    setBusy(true);
    setError(null);
    try {
      onTask(await deliverAnswer(task.id, question.id, value));
      saveQuestionAnswer('');
      onRefresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  async function older() {
    setBusy(true);
    try {
      const before = historyPage[0]?.sequence;
      const page = await loadEventPage(task.id, { ...(before ? { before } : {}), limit: 250 });
      setHistoryPage(page.events);
      setHistoryMore(page.hasMore);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  function selectedContext() {
    const selection = window.getSelection()?.toString().trim() ?? '';
    setScope(selection.slice(0, 12000));
    document.getElementById(`intent-${task.id}`)?.focus();
  }
  const attentionPanel =
    taskDecisions.length > 0 || question ? (
      <aside className="work-attention" id={`attention-${task.id}`}>
        {taskDecisions.map((decision) => (
          <DecisionCard
            key={decision.id}
            decision={decision}
            onComputer={onComputer}
            onResolved={() => {
              onRefresh();
              void reload();
            }}
          />
        ))}
        {question && (!task.parentMissionId || taskDecisions.length === 0) && (
          <article className="question-card" id={`question-${task.id}`}>
            <div className="eyebrow">
              <MessageSquare size={14} />
              Needs your answer
            </div>
            <h2>{text(questionData.question, question.summary)}</h2>
            {text(questionData.why) && <p>{text(questionData.why)}</p>}
            {text(questionData.continueWith) && task.status === 'running' && (
              <p className="muted">Working meanwhile: {text(questionData.continueWith)}</p>
            )}
            {data(questionData.handoff).kind === 'challenge' && (
              <Button className="primary" onClick={() => onComputer('browser')}>
                Open browser verification
              </Button>
            )}
            <div className="stack">
              {strings(questionData.options).map((option) => (
                <Button key={option} disabled={busy} onClick={() => answerQuestion(option)}>
                  {option}
                  <ArrowUpRight size={15} />
                </Button>
              ))}
            </div>
            {data(questionData.handoff).kind !== 'challenge' && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void answerQuestion(questionAnswer);
                }}
              >
                <Field label="Your answer">
                  <textarea
                    value={questionAnswer}
                    onChange={(event) => saveQuestionAnswer(event.target.value)}
                    rows={3}
                  />
                </Field>
                <Button
                  type="submit"
                  className="primary"
                  disabled={!questionAnswer.trim()}
                  busy={busy}
                >
                  {task.status === 'running' ? 'Send answer' : 'Answer and continue'}
                  <ArrowUpRight size={16} />
                </Button>
              </form>
            )}
          </article>
        )}
      </aside>
    ) : null;
  return (
    <section className="garden-task">
      <div className="garden-task-scroll">
        <div className="garden-work-navigation">
          {onDiscuss && !task.parentTaskId ? (
            <span className="eyebrow">Conversation</span>
          ) : (
            <Button
              className="quiet-button"
              onClick={() => (task.parentTaskId ? onOpenTask(task.parentTaskId) : onBack())}
            >
              <ArrowLeft size={16} />
              {task.parentTaskId ? 'Return to parent work' : 'All work'}
            </Button>
          )}
          <div className="row">
            <span
              className={`connection ${connection}`}
              title={
                connection === 'connected'
                  ? 'Live updates connected'
                  : connection === 'idle'
                    ? 'Checking for late updates'
                    : 'Connection to project activity updates; separate from task execution'
              }
            >
              {' '}
              <i />
              {connection === 'connected'
                ? 'Live'
                : connection === 'idle'
                  ? 'Up to date'
                  : connection === 'closed'
                    ? 'Disconnected'
                    : connection === 'connecting'
                      ? 'Connecting'
                      : 'Reconnecting'}
            </span>
            <Button aria-label="Work options" onClick={() => setPanel('settings')}>
              <MoreHorizontal size={19} />
            </Button>
          </div>
        </div>
        <div className="garden-work-heading">
          <div>
            <div className="eyebrow">
              {workspace.name}
              <ChevronRight size={12} /> {displayStatus}
            </div>
            {onDiscuss ? <h2>{task.title}</h2> : <h1>{task.title}</h1>}
          </div>
          <div className="garden-heading-actions">
            <Button onClick={() => setPanel('share')} aria-label="Share this work">
              <Share2 size={17} />
              <span>Share</span>
            </Button>
            <Button
              className="primary"
              onClick={() => {
                setComposerExpanded(true);
                requestAnimationFrame(() => document.getElementById(`intent-${task.id}`)?.focus());
              }}
            >
              <Plus size={17} />
              Add direction
            </Button>
          </div>
        </div>
        {attentionPanel}
        <details className="garden-project-tools">
          <summary>Tools & activity</summary>
          <div className="work-tools garden-top-tools">
            <Button onClick={() => onComputer('terminal')}>
              <Terminal size={16} />
              Terminal
            </Button>
            <Button onClick={() => onComputer('browser')}>Browser</Button>
            <Button onClick={() => onComputer('desktop')}>Desktop</Button>
            <Button
              onClick={() => {
                setFileRequest((value) => value + 1);
                document
                  .getElementById(`directories-${task.id}`)
                  ?.scrollIntoView({ block: 'start' });
              }}
            >
              Files
            </Button>
            <Button onClick={() => onComputer('previews')}>Previews</Button>
            <Button
              onClick={() =>
                document.getElementById(`processes-${task.id}`)?.scrollIntoView({ block: 'start' })
              }
            >
              Processes
            </Button>
            <Button onClick={() => setPanel('models')}>Models</Button>
            <Button
              onClick={() => {
                setHistoryPage(events.slice(-250));
                setHistoryMore((events.at(-250)?.sequence ?? events[0]?.sequence ?? 1) > 1);
                setPanel('history');
              }}
            >
              <History size={16} />
              Activity
            </Button>
            <Button onClick={() => setPanel('plan')}>Plan</Button>
          </div>
        </details>
        <div className="run-summary">
          <div className={`status-line ${isWorking(task) || pendingDelivery ? 'active' : ''}`}>
            <i />
            <span>{displayStatus}</span>
            {task.queuedMessageCount > 0 && (
              <span className="badge">{task.queuedMessageCount} queued</span>
            )}
          </div>
          <div className="row">
            {/*
             * Labelled, because an unattributed currency figure beside a status line is a number
             * the owner cannot check: it could be this project, today, or the account. It is this
             * project's own settled provider cost, and saying so is the difference between a
             * figure that can be verified against the spending pane and one that can only be
             * doubted.
             */}
            <span className="muted">
              <span title="Settled provider cost for this project">
                {money(task.spentUsd)} spent
                {task.maxSpendUsd !== null && ` of ${money(task.maxSpendUsd)}`}
              </span>
              {elapsed && ` · ${elapsed}${isFinished(task) ? '' : ' so far'}`}
            </span>
            {!isFinished(task) && (
              <>
                <Button
                  className="quiet-button"
                  busy={busy}
                  onClick={() =>
                    action(
                      task.status === 'paused' ||
                        (task.status === 'awaiting_resource' &&
                          task.resourceWait?.code !== 'background_jobs')
                        ? 'resume'
                        : 'pause'
                    )
                  }
                >
                  {task.status === 'paused' ||
                  (task.status === 'awaiting_resource' &&
                    task.resourceWait?.code !== 'background_jobs') ? (
                    <Play size={14} />
                  ) : (
                    <Pause size={14} />
                  )}{' '}
                  {task.status === 'awaiting_resource'
                    ? task.resourceWait?.code === 'background_jobs'
                      ? 'Pause follow-up'
                      : 'Retry now'
                    : task.status === 'paused'
                      ? 'Resume'
                      : 'Pause'}
                </Button>
                {/*
                 * Stop belongs beside Pause, not two clicks into Work options.
                 *
                 * Pausing and stopping are the two things an owner wants from a run that is going
                 * wrong, and only one of them was on the screen: the other sat inside a settings
                 * dialog, which is not where anybody looks for a brake. It asks first, because
                 * unlike Pause it cannot be undone - the run does not continue afterwards, though
                 * the files and the history stay and a new direction can pick the work back up.
                 */}
                <Button
                  className="quiet-button"
                  busy={busy}
                  onClick={() => setPanel('stop')}
                  aria-label="Stop this work"
                >
                  <Square size={14} /> Stop
                </Button>
              </>
            )}
          </div>
        </div>
        {waitingReason && (
          <aside className="resource-wait-note" role="status" aria-label="Why this work is waiting">
            <strong>{waitingReason.label}</strong>
            <p>{waitingReason.detail}</p>
            <p className="muted">
              Your work is saved. Retry now makes another attempt with the current model settings.
            </p>
          </aside>
        )}
        <ErrorNotice
          error={error}
          onRetry={() => {
            setError(null);
            void reload();
          }}
        />
        {loading ? (
          <Spinner label="Opening this work…" />
        ) : (
          <div className="garden-task-layout">
            <div className="garden-task-primary">
              {/*
               * A run a ceiling stopped is the one pause that has an answer, and the answer is a
               * question rather than a button - so it sits at the top of the work, above
               * everything else the owner might read, in the same card the product asks every
               * other question in.
               */}
              {task.spendPausedAt && (
                <Suspense fallback={null}>
                  <SpendBlock task={task} onResumed={reload} />
                </Suspense>
              )}
              {presentation?.surface && (
                <details
                  className="garden-task-directions"
                  key={`${task.id}:${isFinished(task)}`}
                  open={!isFinished(task)}
                >
                  <summary>Your directions</summary>
                  <Suspense fallback={null}>
                    <WorkDirections
                      surface={presentation.surface}
                      {...(onDiscuss
                        ? {
                            onDiscuss: (eventId: string) => onDiscuss({ taskId: task.id, eventId })
                          }
                        : {})}
                      onRevisit={(eventId) => {
                        const event = events.find((item) => item.id === eventId);
                        if (event) setBranchEvent(event);
                      }}
                    />
                  </Suspense>
                </details>
              )}
              <SubagentLanes events={events} />
              <Suspense fallback={null}>
                <MediaJobs taskId={task.id} onDelivered={reload} />
              </Suspense>
              {presentation && (
                <TaskOutputs
                  {...(task.projectId
                    ? {
                        onRemember: (result) =>
                          setNoteSource(conversationResultSource(task.id, result))
                      }
                    : {})}
                  {...(onDiscuss
                    ? {
                        onDiscuss: (result) => onDiscuss(conversationResultSource(task.id, result))
                      }
                    : {})}
                  events={events}
                  artifacts={artifacts}
                  presentation={
                    presentation.surface
                      ? {
                          ...presentation,
                          results: presentation.results.filter((result) =>
                            presentation.surface!.currentResultIds.includes(result.id)
                          ),
                          ...(!presentation.surface.report &&
                          directionSequence > 0 &&
                          !presentation.progress.phases.length
                            ? { outputs: [] }
                            : {})
                        }
                      : presentation
                  }
                  onArtifact={(id) => showArtifact(id)}
                />
              )}
              {presentation && (
                <WorkTrace
                  progress={presentation.progress}
                  {...(presentation.surface ? { surface: presentation.surface } : {})}
                  onEvidence={(id) => void inspectEvidence(id)}
                  onResult={(kind, id) => {
                    if (kind === 'artifact') showArtifact(id);
                    else
                      document
                        .getElementById(`preview-${id}`)
                        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                  }}
                />
              )}
              {presentation?.surface &&
                presentation.results.some(
                  (result) => !presentation.surface!.currentResultIds.includes(result.id)
                ) && (
                  <details className="garden-previous-results">
                    <summary>Results from earlier directions</summary>
                    <TaskOutputs
                      {...(onDiscuss
                        ? {
                            onDiscuss: (result) =>
                              onDiscuss(conversationResultSource(task.id, result))
                          }
                        : {})}
                      autoPreview={false}
                      events={events}
                      artifacts={artifacts}
                      presentation={{
                        ...presentation,
                        results: presentation.results.filter(
                          (result) => !presentation.surface!.currentResultIds.includes(result.id)
                        )
                      }}
                      onArtifact={(id) => showArtifact(id)}
                    />
                  </details>
                )}
              {previousAnswer?.markdown && (
                <details className="garden-previous-answer">
                  <summary>Answer from an earlier direction</summary>
                  <Suspense fallback={null}>
                    <Markdown>{previousAnswer.markdown}</Markdown>
                  </Suspense>
                </details>
              )}
              {answer.markdown ? (
                <article className="garden-answer">
                  <div className="result-toolbar">
                    <span className="eyebrow">
                      {answer.partial
                        ? 'Taking shape'
                        : answer.previous
                          ? 'Previous result'
                          : task.status !== 'completed'
                            ? 'Latest update'
                            : completion.interrupted
                              ? 'Unverified answer'
                              : 'The result'}
                    </span>
                    <div className="row">
                      <Button
                        className="quiet-button"
                        onClick={() =>
                          navigator.clipboard.writeText(answer.markdown).catch(setError)
                        }
                      >
                        Copy
                      </Button>
                    </div>
                  </div>
                  <Suspense fallback={<Spinner label="Opening the result…" />}>
                    <Markdown>{answer.markdown}</Markdown>
                  </Suspense>
                  {answer.partial && (
                    <div className="writing-indicator" role="status">
                      Writing…
                    </div>
                  )}
                </article>
              ) : attentionPanel ? null : (
                <article className="garden-working-note">
                  <span className="eyebrow">{statusLabel[task.status]}</span>
                  <h2>
                    {task.status === 'awaiting_user'
                      ? 'Your input will shape the next step.'
                      : task.status === 'paused'
                        ? 'Ready to continue.'
                        : task.status === 'failed'
                          ? 'This work needs attention.'
                          : task.status === 'cancelled'
                            ? 'This work has stopped.'
                            : 'Making room for your idea.'}
                  </h2>
                  <p>
                    {presentation?.progress.current?.title ??
                      latestActivity?.summary ??
                      'The first recorded update will appear here.'}
                  </p>
                  <Button className="quiet-button" onClick={() => setPanel('brief')}>
                    Read your brief
                    <ArrowUpRight size={14} />
                  </Button>
                </article>
              )}
              <div id={`processes-${task.id}`}>
                <Suspense fallback={null}>
                  <ProcessPanel key={task.id} workspaceId={workspace.id} taskId={task.id} />
                </Suspense>
              </div>
              <div id={`directories-${task.id}`}>
                <Suspense fallback={null}>
                  <DirectoryPanel key={task.id} taskId={task.id} openRequest={fileRequest} />
                </Suspense>
              </div>
              {completionEvent && (
                <section
                  className={`completion-record ${completion.interrupted || verification.status === 'checks_failed' || verification.status === 'checks_did_not_run' || verification.status === 'delivery_incomplete' ? 'needs-review' : ''}`}
                >
                  <div className="row between">
                    <span className="eyebrow">
                      {(lastEvent(events, 'user_message')?.sequence ?? 0) > completionEvent.sequence
                        ? 'Previous completion'
                        : 'Completion record'}
                    </span>
                    <span className="badge">
                      {completion.interrupted
                        ? 'Review needed'
                        : verification.status === 'delivery_pending'
                          ? pendingDelivery
                            ? 'Generation continues'
                            : deliveryFailed
                              ? 'Delivery needs attention'
                              : presentation?.delivery?.status === 'ready'
                                ? 'Delivered'
                                : 'Checking delivery'
                          : verification.status === 'delivery_incomplete'
                            ? 'Delivery needs attention'
                            : verification.status === 'verified'
                              ? checks.label
                              : verification.status === 'not_applicable'
                                ? 'No executable checks needed'
                                : verification.status === 'checks_failed'
                                  ? 'Checks failed'
                                  : verification.status === 'checks_did_not_run'
                                    ? 'Checks did not run'
                                    : 'Verification not recorded'}
                    </span>
                  </div>
                  {text(completion.summary) &&
                    text(completion.summary).trim() !== answer.markdown.trim() && (
                      <p>{text(completion.summary)}</p>
                    )}
                  {strings(verification.remainingRisks).length > 0 && (
                    <div className="remaining-risks">
                      <strong>Still to consider</strong>
                      <ul>
                        {strings(verification.remainingRisks).map((risk, index) => (
                          <li key={index}>{risk}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {(checks.evidence.length > 0 || acceptance.length > 0) && (
                    <details>
                      <summary>Evidence and checks</summary>
                      <ul className="evidence-list">
                        {checks.evidence.map((record, index) => {
                          const call = text(record.toolCallId);
                          const source = events.find(
                            (event) =>
                              text(data(event.payload).toolCallId) === call &&
                              event.kind === 'tool_result'
                          );
                          return (
                            <li key={index}>
                              <span>{text(record.claim)}</span>
                              <small>{evidenceSource(record.source)}</small>
                              {source && (
                                <Button onClick={() => setEvidence(source)}>
                                  Inspect evidence
                                </Button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                      {acceptance.length > 0 && (
                        <div className="completion-acceptance">
                          <strong>Check results</strong>
                          <ul>
                            {acceptance.map((result, index) => (
                              <li key={index}>{result}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </details>
                  )}
                </section>
              )}
              {!presentation && artifacts.length > 0 && (
                <section className="result-shelf">
                  <div className="section-heading">
                    <h2>Made with this work</h2>
                    <Button onClick={() => onComputer('files')}>
                      All files
                      <ArrowUpRight size={15} />
                    </Button>
                  </div>
                  <div className="artifact-grid">
                    {artifacts.map((artifact) => (
                      <button
                        type="button"
                        className="artifact-tile"
                        key={artifact.id}
                        onClick={() => setPreview(artifact)}
                      >
                        <FileText size={24} />
                        <span>{artifact.name}</span>
                        <small>
                          Version {artifact.version} · {artifact.mimeType.split('/').at(-1)}
                        </small>
                        <ArrowUpRight className="artifact-arrow" size={17} />
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </div>
            <div className="garden-task-aside">
              <Suspense fallback={null}>
                <CodingMissions taskId={task.id} onOpenTask={onOpenTask} onChange={reload} />
              </Suspense>
              {presentation && (
                <TaskProgress
                  presentation={presentation}
                  onPlan={() => setPanel('plan')}
                  onEvidence={(id) => void inspectEvidence(id)}
                />
              )}
            </div>
          </div>
        )}
        {notices.length > 0 && (
          <details className="notices">
            <summary>
              {notices.length} recent {notices.length === 1 ? 'notice' : 'notices'}
            </summary>
            {notices.map((event) => (
              <article key={event.id}>
                <strong>{event.summary}</strong>
                <p>{text(data(event.payload).detail)}</p>
                <Button onClick={() => setEvidence(event)}>Inspect</Button>
              </article>
            ))}
          </details>
        )}
      </div>
      {panel === 'models' && (
        <Dialog title="Conversation models" onClose={() => setPanel(null)} wide>
          <Suspense fallback={<Spinner />}>
            <ProjectModels taskId={task.id} onChange={onRefresh} />
          </Suspense>
        </Dialog>
      )}
      <div className="garden-task-composer">
        {attentionPanel && (
          <Button
            className="primary garden-attention-jump"
            onClick={() =>
              document
                .getElementById(`attention-${task.id}`)
                ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
            }
          >
            Needs you · View request
            <ArrowUpRight size={16} />
          </Button>
        )}
        {!attentionPanel && !task.parentMissionId && !showComposer && (
          <Button
            className="garden-compose-prompt"
            onClick={() => {
              setComposerExpanded(true);
              requestAnimationFrame(() => document.getElementById(`intent-${task.id}`)?.focus());
            }}
          >
            <Plus size={18} /> Add a direction…
            <span>Continue this work</span>
          </Button>
        )}
        <div hidden={Boolean(attentionPanel) || (!task.parentMissionId && !showComposer)}>
          {!attentionPanel && !task.parentMissionId && isFinished(task) && showComposer && (
            <Button
              className="garden-compose-collapse"
              aria-label="Collapse composer"
              onClick={() => setComposerExpanded(false)}
            >
              <X size={14} /> Keep draft and collapse
            </Button>
          )}
          {task.parentMissionId ? (
            <div className="selected-context garden-mission-context">
              <p>This specialist uses the model and budget assigned by its parent work.</p>
              <small className="muted">
                {bootstrap.models.find((model) => model.id === task.modelId)?.displayName ??
                  task.modelId}
                {' · '}Effort {effortLabel(task.reasoningEffort ?? 'auto')}
              </small>
              <div className="row">
                {question && taskDecisions.length === 0 && (
                  <Button
                    onClick={() => {
                      const card = document.getElementById(`question-${task.id}`);
                      card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                      card?.querySelector('textarea')?.focus({ preventScroll: true });
                    }}
                  >
                    Reply to the question
                  </Button>
                )}
                {task.parentTaskId && (
                  <Button onClick={() => onOpenTask(task.parentTaskId!)}>
                    Continue in parent work
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <>
              {scope && (
                <div className="selected-context">
                  <span className="eyebrow">Selected context</span>
                  <p>{scope}</p>
                  <Button onClick={() => setScope('')} aria-label="Clear selected context">
                    <X size={14} />
                  </Button>
                </div>
              )}
              <Suspense fallback={<Spinner />}>
                <Composer
                  workspace={workspace}
                  task={task}
                  bootstrap={bootstrap}
                  toolbarExtra={
                    <Button className="quiet-button" onClick={selectedContext}>
                      Shape selection
                      <ArrowUpRight size={14} />
                    </Button>
                  }
                  {...(draft ? { initialDraft: draft } : {})}
                  {...(scope ? { scope } : {})}
                  onDraft={onDraft}
                  onSent={(result) => {
                    onTask(result);
                    setScope('');
                    onRefresh();
                  }}
                />
              </Suspense>
            </>
          )}
        </div>
      </div>
      {panel === 'brief' && (
        <Dialog title="What you asked" wide onClose={() => setPanel(null)}>
          <p className="muted">
            {(events[0]?.sequence ?? 1) > 1
              ? 'Your opening direction and recent directions. Earlier activity holds the rest.'
              : 'Your opening direction and every direction since, oldest first.'}
          </p>
          {briefLoading && !opening ? (
            <Spinner label="Loading your original direction…" />
          ) : ownerDirections.length === 0 ? (
            <p className="muted">
              {opening ? (
                <Suspense fallback={null}>
                  <Markdown>{eventText(opening)}</Markdown>
                </Suspense>
              ) : (
                'No opening direction is available in the first recorded events.'
              )}
            </p>
          ) : (
            <ol className="activity-ledger">
              {ownerDirections.map((event) => (
                <li key={event.id}>
                  <span className="activity-kind">
                    {event.id === opening?.id ? 'Original direction' : 'Direction'}
                  </span>
                  <div>
                    <Suspense fallback={<p>{event.summary}</p>}>
                      <Markdown>{eventText(event)}</Markdown>
                    </Suspense>
                    <MessageAttachmentList
                      workspaceId={task.workspaceId}
                      paths={data(event.payload).attachments}
                    />
                    <small className="muted">{date(event.createdAt)}</small>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Dialog>
      )}
      {panel === 'history' && (
        <Dialog title="Activity and directions" wide onClose={() => setPanel(null)}>
          <div className="row between">
            <p className="muted">The recorded work, with details available at each step.</p>
            {historyMore && (
              <Button busy={busy} onClick={older}>
                Earlier activity
              </Button>
            )}
            <Button
              onClick={() => {
                setHistoryPage(events.slice(-250));
                setHistoryMore((events.at(-250)?.sequence ?? events[0]?.sequence ?? 1) > 1);
              }}
            >
              Latest
            </Button>
          </div>
          <details className="diagnostic-download">
            <summary>Troubleshooting</summary>
            <p className="muted">
              Download recorded activity, wait states and cost counters for offline inspection.
              Prompts, file contents, addresses and private input are excluded. Nothing is sent
              elsewhere.
            </p>
            <a
              href={`/v1/tasks/${encodeURIComponent(task.id)}/diagnostics`}
              download="garden-diagnostic.ndjson"
            >
              Download diagnostics
            </a>
          </details>
          <ol className="activity-ledger">
            {historyPage
              .filter((event) => !['assistant_delta', 'assistant_reasoning'].includes(event.kind))
              .map((event) => (
                <li key={event.id}>
                  <span className="activity-kind">{event.kind.replaceAll('_', ' ')}</span>
                  <div>
                    <p>{event.summary}</p>
                    <small className="muted">{date(event.createdAt)}</small>
                    <div className="row">
                      <Button className="quiet-button" onClick={() => setEvidence(event)}>
                        Details
                      </Button>
                      {['user_message', 'assistant_message'].includes(event.kind) && (
                        <Button className="quiet-button" onClick={() => setBranchEvent(event)}>
                          <GitBranch size={13} />
                          Branch / retry
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
          </ol>
        </Dialog>
      )}
      {panel === 'stop' && (
        <Dialog title="Stop this work?" onClose={() => setPanel(null)}>
          <p>
            The run stops where it is. Its files, its published links and everything it recorded
            stay exactly as they are — send another direction later and the work picks up from here.
          </p>
          <p className="muted">To hold it without ending it, close this and use Pause instead.</p>
          <ErrorNotice error={error} />
          <div className="row">
            <Button
              className="primary"
              busy={busy}
              onClick={async () => {
                await action('cancel');
                setPanel(null);
              }}
            >
              Stop this work
            </Button>
            <Button onClick={() => setPanel(null)}>Keep going</Button>
          </div>
        </Dialog>
      )}
      {panel === 'plan' && (
        <Dialog title="The plan" wide onClose={() => setPanel(null)}>
          <Suspense fallback={<Spinner label="Opening plan…" />}>
            <PlanEditor
              task={task}
              plan={plan}
              onSaved={(next) => {
                setPlan(next);
                onRefresh();
              }}
            />
          </Suspense>
        </Dialog>
      )}
      {panel === 'settings' && (
        <Dialog title="Work options" onClose={() => setPanel(null)}>
          <Suspense fallback={<Spinner label="Opening work options…" />}>
            <TaskOptions task={task} onTask={onTask} onRefresh={onRefresh} />
          </Suspense>
          <Button
            onClick={() => {
              const event = [...events]
                .reverse()
                .find((item) => ['assistant_message', 'user_message'].includes(item.kind));
              if (event) setBranchEvent(event);
            }}
          >
            <GitBranch size={16} />
            Branch from latest message
          </Button>
        </Dialog>
      )}
      {panel === 'share' && (
        <Dialog title="Share a snapshot" wide onClose={() => setPanel(null)}>
          <Suspense fallback={<Spinner />}>
            <Share task={task} artifacts={artifacts} onChange={onRefresh} />
          </Suspense>
        </Dialog>
      )}
      {evidence && (
        <Dialog title={evidence.kind.replaceAll('_', ' ')} wide onClose={() => setEvidence(null)}>
          <h3>{evidence.summary}</h3>
          {['assistant_message', 'user_message'].includes(evidence.kind) ? (
            <Suspense fallback={<Spinner />}>
              <Markdown>{eventText(evidence)}</Markdown>
            </Suspense>
          ) : (
            <pre>{JSON.stringify(evidence.payload, null, 2)}</pre>
          )}
          {evidence.kind === 'user_message' && (
            <MessageAttachmentList
              workspaceId={task.workspaceId}
              paths={data(evidence.payload).attachments}
            />
          )}
        </Dialog>
      )}
      {preview && (
        <Dialog title={preview.name} onClose={() => setPreview(null)}>
          <Suspense fallback={<Spinner label="Opening result" />}>
            <ResultPreview key={preview.id} artifact={preview} />
          </Suspense>
          <Button
            onClick={() => {
              setPreview(null);
              onComputer('files');
            }}
          >
            Open files and download
            <ArrowUpRight size={15} />
          </Button>
        </Dialog>
      )}
      {noteSource && task.projectId && (
        <Suspense fallback={<Spinner />}>
          <ProjectNoteEditor
            projectId={task.projectId}
            source={noteSource}
            onClose={() => setNoteSource(null)}
            onSaved={onRefresh}
          />
        </Suspense>
      )}
      {branchEvent && (
        <Dialog title="Continue from this point" wide onClose={() => setBranchEvent(null)}>
          <Suspense fallback={<Spinner label="Opening continuation options…" />}>
            <Trajectory
              task={task}
              event={branchEvent}
              onCreated={(result) => {
                setBranchEvent(null);
                setPanel(null);
                onTask(result);
                onRefresh();
              }}
            />
          </Suspense>
        </Dialog>
      )}
    </section>
  );
}
