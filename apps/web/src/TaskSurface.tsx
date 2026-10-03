import ProjectPanel from './ProjectPanel';
import { setSurfaceLocation, useProjectView, useProjectTool } from './surface-location';
import { computerTool, type ComputerTool } from './computer-tools';
import { RunRows, useRuns } from './runs';
import { processName } from './process-display';
import { useVisibleClock } from './visible-clock';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  AudioLines,
  FileText,
  GitBranch,
  History,
  MessageSquare,
  MoreHorizontal,
  Pause,
  Square,
  Play,
  Share2
} from './icons';
import type {
  Artifact,
  Task,
  TaskEvent,
  Workspace,
  ConversationSource,
  DirectionContext,
  ResultNote
} from '@garden/contracts';
import type { Bootstrap, Decision, Draft } from './model';
import {
  activeQuestion,
  answerIsStreaming,
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
import { loadEventPage, type StreamConnection } from './stream';
import { useTaskRecord } from './useTaskRecord';
import { Button, Dialog, ErrorNotice, Spinner } from './ui';
import { DecisionCard } from './DecisionQueue';
import { createQuestionAnswerSender } from './task-actions';
import { TaskOutputs, TaskProgress } from './TaskCanvas';
import Sources from './Sources';
import Thread, { exchangesOf, OwnerLine } from './Thread';
import { Commentable, withNote } from './result-notes';
import { currentWork } from './current-work';
import { completionChecks, evidenceSource } from './completion-checks';
import MessageAttachmentList from './MessageAttachmentList';
import './presentation.css';
import './conversation.css';
import './task-surface.css';
import StatusSprite, { stageOf } from './life/StatusSprite';
import { effortLabel } from './reasoning-options';
import { resourceWaitReason } from './resource-wait';
const ProjectNoteEditor = lazy(() =>
  import('./ProjectNotes').then((module) => ({ default: module.ProjectNoteEditor }))
);
const PrivateDiagnostics = lazy(() => import('./PrivateDiagnostics'));
const VoiceSession = lazy(() => import('./voice/VoiceSession'));

/**
 * The live-updates lamp as the owner should see it. The stream reopens routinely - after a proxy
 * timeout, a wake, a finished page - and each reopen passes through `connecting` for a moment;
 * showing that would blink the lamp for nothing. A reconnect only shows once it has lasted a few
 * seconds, and a lost connection shows at once.
 */
function useSteadyConnection(connection: StreamConnection) {
  const [shown, setShown] = useState(connection);
  useEffect(() => {
    if (connection !== 'connecting' && connection !== 'reconnecting') {
      setShown(connection);
      return;
    }
    const timer = setTimeout(() => setShown(connection), 3000);
    return () => clearTimeout(timer);
  }, [connection]);
  return shown;
}
const Computer = lazy(() => import('./Computer'));
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
  onComputer: (tool: ComputerTool) => void;
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
    connection: liveConnection,
    reload
  } = useTaskRecord({
    taskId: task.id,
    workspaceId: workspace.id,
    onTask,
    onRefresh
  });
  const connection = useSteadyConnection(liveConnection);
  const [preview, setPreview] = useState<Artifact | null>(null);
  const [panel, setPanel] = useState<
    'direction' | 'history' | 'plan' | 'settings' | 'share' | 'models' | 'stop' | 'voice' | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [composerLocked, setComposerLocked] = useState(false);
  const [historyMore, setHistoryMore] = useState(false);
  const [view, selectView] = useProjectView();
  const [selectedTool] = useProjectTool(task.projectId ?? task.id);
  const [filesOpened, setFilesOpened] = useState(view === 'files');
  const [toolsOpened, setToolsOpened] = useState(view === 'tools');
  useEffect(() => {
    if (view === 'files') setFilesOpened(true);
    if (view === 'tools') setToolsOpened(true);
  }, [view]);
  const tool = selectedTool === 'files' ? 'browser' : computerTool(selectedTool);

  const [historyPage, setHistoryPage] = useState<TaskEvent[]>([]);
  useEffect(() => {
    if (!initialPage) return;
    setHistoryPage(initialPage.events);
    setHistoryMore(initialPage.hasMore);
  }, [initialPage]);
  const [evidence, setEvidence] = useState<TaskEvent | null>(null);
  const [directionContext, setDirectionContext] = useState<DirectionContext | null>(
    draft?.controls?.context ?? null
  );
  const [deliverAnswer] = useState(createQuestionAnswerSender);
  const [noteSource, setNoteSource] = useState<ConversationSource | null>(null);
  const [branchEvent, setBranchEvent] = useState<TaskEvent | null>(null);
  const presentation = currentWork(storedPresentation, events);
  const addNote = (note: ResultNote) => {
    setDirectionContext((current) => withNote(current, note));
    requestAnimationFrame(() =>
      document.getElementById(`intent-${task.id}`)?.focus({ preventScroll: true })
    );
  };
  const notes = directionContext?.kind === 'notes' ? directionContext.notes : [];
  // This conversation's own jobs, live in the flow of the conversation; an open panel reads them itself.
  const runs = useRuns(view === 'work' ? `/v1/tasks/${task.id}/processes` : null);
  /*
   * The run summary's elapsed figure is a live clock, not a snapshot. Re-rendering on a half
   * minute keeps it honest while a task runs; a finished task's duration is fixed and the tick
   * is wasted, so this only runs while the work could still be accruing time.
   */
  const running = !isFinished(task);
  const clock = useVisibleClock(running, 30_000, task.updatedAt);
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
  const writing = answer.partial && answerIsStreaming(currentEvents, task.status);
  const exchanges = exchangesOf(events);
  const currentDirection =
    [...exchanges].reverse().find((exchange) => exchange.direction.sequence <= directionSequence)
      ?.direction ?? exchanges.at(-1)?.direction;
  const earlier = exchanges.filter(
    (exchange) => currentDirection && exchange.direction.sequence < currentDirection.sequence
  );
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
  const waitingReason =
    task.status === 'awaiting_resource' ? resourceWaitReason(events, task.resourceWait) : null;
  const displayStatus =
    waitingReason?.label ??
    taskStatusLabel(
      { ...task, deliveryStatus: presentation?.delivery?.status ?? task.deliveryStatus },
      completionEvent
        ? {
            openSteps: openPhases,
            interrupted: completion.interrupted === true,
            verification: text(verification.status) || null
          }
        : undefined
    );
  const question = activeQuestion(events, task);

  const questionData = data(question?.payload);
  const taskDecisions = decisions.filter((decision) => decision.taskId === task.id);
  const latestActivity = [...events]
    .reverse()
    .find((event) =>
      ['tool_started', 'status', 'notice', 'warning', 'error', 'assistant_reasoning'].includes(
        event.kind
      )
    );
  const previousStatus = useRef(task.status);
  const [justFinished, setJustFinished] = useState(false);
  useEffect(() => {
    const before = previousStatus.current;
    previousStatus.current = task.status;
    if (before === task.status || task.status !== 'completed') return;
    setJustFinished(true);
    const timer = setTimeout(() => setJustFinished(false), 1200);
    return () => clearTimeout(timer);
  }, [task.status]);
  const elapsed = isFinished(task)
    ? duration(task.createdAt, task.completedAt ?? task.updatedAt)
    : duration(task.createdAt, new Date(clock).toISOString());
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
      onRefresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  /** The composer's answer path: it reports a failure itself and keeps what was typed. */
  async function answerFromComposer(value: string) {
    if (!question) return;
    onTask(await deliverAnswer(task.id, question.id, value));
    onRefresh();
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
  // While the agent waits on a plain question, the composer is where it is answered.
  const answering =
    question && taskDecisions.length === 0 && data(questionData.handoff).kind !== 'challenge'
      ? { question: text(questionData.question, question.summary), onAnswer: answerFromComposer }
      : null;
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
          <article className="question-card text-box" id={`question-${task.id}`}>
            <div className="eyebrow">
              <MessageSquare size={14} />
              Needs your answer
            </div>
            <h2>{text(questionData.question, question.summary)}</h2>
            {text(questionData.why) && <p>{text(questionData.why)}</p>}
            {text(questionData.continueWith) && task.status === 'running' && (
              <p className="muted">Working meanwhile: {text(questionData.continueWith)}</p>
            )}
            {data(questionData.handoff).kind !== 'challenge' && (
              <p className="muted question-hint">Answer below, or pick one.</p>
            )}
            {data(questionData.handoff).kind === 'challenge' && (
              <Button className="primary" onClick={() => onComputer('browser')}>
                Open browser verification
              </Button>
            )}
            <div className="answer-choices">
              {strings(questionData.options).map((option) => (
                <Button
                  key={option}
                  className="answer-choice cursor-row"
                  disabled={busy}
                  onClick={() => answerQuestion(option)}
                >
                  {option}
                </Button>
              ))}
            </div>
          </article>
        )}
      </aside>
    ) : null;
  const checkLine =
    completionEvent && acceptance.length
      ? verification.status === 'verified'
        ? `${checks.label}`
        : verification.status === 'checks_failed'
          ? 'Checks failed'
          : verification.status === 'checks_did_not_run'
            ? 'Checks could not run'
            : ''
      : '';
  const risks = completionEvent ? strings(verification.remainingRisks) : [];
  const resultAnswer = answer.markdown ? (
    <article className="garden-answer">
      <Suspense fallback={<Spinner label="Opening the result…" />}>
        <Commentable on="the answer" onNote={addNote}>
          <Markdown artifacts={artifacts} onArtifact={showArtifact} imageMode="links">
            {answer.markdown}
          </Markdown>
        </Commentable>
      </Suspense>
      {writing ? (
        <div className="writing-indicator typing-cursor" role="status">
          Writing…
        </div>
      ) : (
        <footer className="answer-footer">
          {checkLine && (
            <button className="text-button" onClick={() => selectView('activity')}>
              {checkLine}
            </button>
          )}
          {completion.interrupted === true && <span>Stopped before it was finished</span>}
          <Button
            className="quiet-button"
            onClick={() => navigator.clipboard.writeText(answer.markdown).catch(setError)}
          >
            Copy
          </Button>
        </footer>
      )}
      {!writing && risks.length > 0 && (
        <ul className="answer-risks" aria-label="Still to consider">
          {risks.slice(0, 4).map((risk, index) => (
            <li key={index}>{risk}</li>
          ))}
        </ul>
      )}
    </article>
  ) : attentionPanel ? null : (
    <p className="garden-working-note" role="status">
      <span className="eyebrow">{statusLabel[task.status]}</span>
      <span>
        {presentation?.progress.current?.title ??
          latestActivity?.summary ??
          (isFinished(task) ? 'No answer was recorded.' : 'Starting…')}
      </span>
    </p>
  );
  return (
    <section className="garden-task workspace-view-work">
      <div className="run-summary">
        <h2 className="sr-only">{task.title}</h2>
        <div
          className={`status-line ${isWorking(task) || pendingDelivery ? 'active' : ''} ${justFinished ? 'finish-flash' : ''}`}
        >
          <StatusSprite stage={stageOf(task)} />
          <button
            className="run-status-button"
            onClick={() => selectView('activity')}
            title="View checks and activity"
          >
            {displayStatus}
          </button>
          {task.queuedMessageCount > 0 && (
            <span className="badge">{task.queuedMessageCount} queued</span>
          )}
          <span className="muted run-cost">
            <span title="Settled provider cost for this conversation">
              {money(task.spentUsd)}
              {task.maxSpendUsd !== null && ` of ${money(task.maxSpendUsd)}`}
            </span>
            {elapsed && ` · ${elapsed}`}
          </span>
        </div>
        <div className="row">
          {/* Only a connection that is not live is worth a word; a live one is the default. */}
          {connection !== 'connected' && connection !== 'idle' && (
            <span
              className={`connection power-lamp ${connection} ${connection === 'closed' ? '' : 'is-waiting'}`}
              title="Live updates for this conversation; the work itself continues either way"
            >
              <i />
              <span>{connection === 'closed' ? 'Disconnected' : 'Reconnecting'}</span>
            </span>
          )}
          <Button
            className="run-tool"
            aria-label="Work options"
            title="Share, models, autonomy and branching"
            onClick={() => setPanel('settings')}
          >
            <MoreHorizontal size={19} />
          </Button>
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
      <div className="garden-task-scroll" role="region" aria-label="Project output">
        <div className="garden-parent-navigation">
          {(!onDiscuss || task.parentTaskId) && (
            <Button
              className="quiet-button"
              onClick={() => (task.parentTaskId ? onOpenTask(task.parentTaskId) : onBack())}
            >
              <ArrowLeft size={16} />
              {task.parentTaskId ? 'Return to parent work' : 'All work'}
            </Button>
          )}
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
          context="Could not complete this conversation action."
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
              <Thread
                exchanges={earlier}
                workspaceId={task.workspaceId}
                artifacts={artifacts}
                onRevisit={setBranchEvent}
                {...(onDiscuss
                  ? { onDiscuss: (eventId: string) => onDiscuss({ taskId: task.id, eventId }) }
                  : {})}
              />
              {currentDirection && !task.parentMissionId && (
                <OwnerLine
                  event={currentDirection}
                  workspaceId={task.workspaceId}
                  artifacts={artifacts}
                  onRevisit={setBranchEvent}
                />
              )}
              {runs.active.length > 0 && (
                <section className="conversation-runs" aria-label="Running for this conversation">
                  <RunRows
                    processes={runs.active}
                    observedAt={runs.list?.observedAt}
                    limit={3}
                    onOpen={() => {
                      selectView('tools');
                      setSurfaceLocation({ tool: 'runs' });
                    }}
                  />
                </section>
              )}
              {task.spendPausedAt && (
                <Suspense fallback={null}>
                  <SpendBlock task={task} onResumed={reload} />
                </Suspense>
              )}
              <Suspense fallback={null}>
                <MediaJobs taskId={task.id} onDelivered={reload} />
              </Suspense>
              {presentation ? (
                <TaskOutputs
                  notes={notes}
                  onNote={addNote}
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
                          ...(directionSequence > 0 && !presentation.progress.phases.length
                            ? { outputs: [] }
                            : {})
                        }
                      : presentation
                  }
                  onArtifact={(id) => showArtifact(id)}
                  afterPreview={resultAnswer}
                />
              ) : (
                resultAnswer
              )}
              {presentation?.surface &&
                presentation.results.some(
                  (result) => !presentation.surface!.currentResultIds.includes(result.id)
                ) && (
                  <details
                    className="garden-previous-results garden-history"
                    name={`history-${task.id}`}
                  >
                    <summary>Earlier results</summary>
                    <p className="garden-history-context muted">
                      Files and app previews from before your latest message in this conversation.
                    </p>
                    <TaskOutputs
                      {...(onDiscuss
                        ? {
                            onDiscuss: (result) =>
                              onDiscuss(conversationResultSource(task.id, result))
                          }
                        : {})}
                      autoPreview={false}
                      compact={false}
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
          </div>
        )}
      </div>
      <ProjectPanel scope={task.title}>
        {view === 'activity' && (
          <section className="conversation-activity" aria-label="Conversation activity">
            <div className="section-heading">
              <h2>Activity</h2>
              <div className="row">
                <Button onClick={() => setPanel('plan')}>Edit plan</Button>
                <Button
                  onClick={() => {
                    setHistoryPage(events.slice(-250));
                    setHistoryMore((events.at(-250)?.sequence ?? events[0]?.sequence ?? 1) > 1);
                    setPanel('history');
                  }}
                >
                  <History size={15} />
                  Full activity
                </Button>
              </div>
            </div>
            {completionEvent &&
              (checks.evidence.length > 0 ||
                acceptance.length > 0 ||
                completion.interrupted === true ||
                !['verified', 'not_applicable'].includes(text(verification.status))) && (
                <section
                  className={`completion-record ${completion.interrupted || verification.status === 'unverified' || verification.status === 'checks_failed' || verification.status === 'checks_did_not_run' || verification.status === 'delivery_incomplete' ? 'needs-review' : ''}`}
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
                                    : verification.status === 'unverified'
                                      ? 'Verification needs review'
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
                    <details open>
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
            {/* The plan and what was done, then who helped, then what was read. */}
            {presentation && (
              <TaskProgress
                presentation={{ ...presentation, taskStatus: task.status }}
                showOutcome={!completionEvent}
                onPlan={() => setPanel('plan')}
                onEvidence={(id) => void inspectEvidence(id)}
              />
            )}
            <Suspense fallback={null}>
              <CodingMissions taskId={task.id} onOpenTask={onOpenTask} onChange={reload} />
            </Suspense>
            <SubagentLanes events={events} />
            {presentation?.surface && (
              <Sources
                surface={presentation.surface}
                onEvidence={(id) => void inspectEvidence(id)}
              />
            )}
          </section>
        )}
        {filesOpened && (
          <div id={`directories-${task.id}`} hidden={view !== 'files'}>
            <Suspense fallback={null}>
              <DirectoryPanel
                embedded
                key={task.id}
                taskId={task.id}
                openRequest={1}
                {...(!task.parentMissionId && !composerLocked
                  ? {
                      rerunWorkspaceId: task.workspaceId,
                      onRerunAnalysis: (
                        selection: Extract<DirectionContext, { kind: 'analysis' }>
                      ) => {
                        selectView('work');
                        setDirectionContext(selection);
                        requestAnimationFrame(() => {
                          const input = document.getElementById(`intent-${task.id}`);
                          input?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                          input?.focus({ preventScroll: true });
                        });
                      }
                    }
                  : {})}
              />
            </Suspense>
          </div>
        )}
        {toolsOpened && (
          <div hidden={view !== 'tools'}>
            <Suspense fallback={<Spinner />}>
              <Computer
                workspace={workspace}
                task={task}
                initialTool={tool}
                embedded
                visible={view === 'tools'}
                onAskAboutRun={(process) => {
                  selectView('work');
                  addNote({
                    on: `the run “${processName(process)}” (session ${process.sessionId})`,
                    note: ''
                  });
                }}
                onToolChange={(next) => setSurfaceLocation({ tool: next })}
                onChange={reload}
              />
            </Suspense>
          </div>
        )}
        {view === 'activity' && notices.length > 0 && (
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
      </ProjectPanel>
      {panel === 'voice' && (
        <Suspense fallback={<Spinner label="Opening live voice…" />}>
          <VoiceSession
            task={task}
            onClose={() => setPanel(null)}
            onTaskChanged={() => {
              void reload();
              onRefresh();
            }}
          />
        </Suspense>
      )}
      {panel === 'models' && (
        <Dialog title="Conversation models" onClose={() => setPanel(null)} wide>
          <Suspense fallback={<Spinner />}>
            <ProjectModels taskId={task.id} onChange={onRefresh} />
          </Suspense>
        </Dialog>
      )}
      <div className="garden-task-composer">
        {attentionPanel}
        <div>
          {task.parentMissionId && !answering ? (
            <div className="selected-context garden-mission-context">
              <p>This specialist uses the model and budget assigned by its parent work.</p>
              <small className="muted">
                {bootstrap.models.find((model) => model.id === task.modelId)?.displayName ??
                  task.modelId}
                {' · '}Effort {effortLabel(task.reasoningEffort ?? 'auto')}
              </small>
              <div className="row">
                {task.parentTaskId && (
                  <Button onClick={() => onOpenTask(task.parentTaskId!)}>
                    Continue in parent work
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <>
              <Suspense fallback={<Spinner />}>
                <Composer
                  workspace={workspace}
                  task={task}
                  bootstrap={bootstrap}
                  {...(draft ? { initialDraft: draft } : {})}
                  context={directionContext}
                  onContextChange={setDirectionContext}
                  onEditingChange={setComposerLocked}
                  onDraft={onDraft}
                  onSent={(result) => {
                    onTask(result);
                    setDirectionContext(null);
                    onRefresh();
                  }}
                  {...(answering ? { answer: answering } : {})}
                  toolbarExtra={
                    <Button
                      aria-label="Live voice"
                      title="Talk with the agent live"
                      onClick={() => setPanel('voice')}
                    >
                      <AudioLines size={18} />
                    </Button>
                  }
                />
              </Suspense>
            </>
          )}
        </div>
      </div>
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
            <Suspense fallback={null}>
              <PrivateDiagnostics key={task.id} taskId={task.id} />
            </Suspense>
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
            stay available. You can send a new message later to continue from the saved work.
          </p>
          <p className="muted">
            Long-running server jobs are managed separately in Tools → Jobs. Review them there if
            you want to stop them too. To pause the agent without ending this run, use Pause
            instead.
          </p>
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
          <div className="row">
            <Button onClick={() => setPanel('share')} aria-label="Share this work">
              <Share2 size={15} /> Share
            </Button>
            <Button onClick={() => setPanel('models')}>Models</Button>
          </div>
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
