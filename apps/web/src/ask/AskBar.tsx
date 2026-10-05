import { lazy, Suspense, useEffect, useState } from 'react';
import type { OwnerMove, Task, Workspace } from '@garden/contracts';
import type { Bootstrap } from '../model';
import { useComposer } from '../use-composer';
import { Close, Mic, Paperclip, Sprout, Stop, Tune, Up } from '../app/icons';
import { putTask, refreshSoon } from '../app/store';
import { isNativeClient } from '../client';
import { growth } from '../app/derive';
import { answer as answerQuestion } from '../app/actions';
import { onAskText, watchSent } from './ask-bus';
import { NEW_GOAL, seedDirection, setDirection, useDirection } from './direction';
import AskOptions, { settingsSummary, type AskSettings } from './AskOptions';
import './ask.css';

const DictationSetup = lazy(() => import('../DictationSetup'));
const LocalFolderAttachments = lazy(() => import('../LocalFolderAttachments'));

/**
 * One input, everywhere. On the desk it plants a new goal; inside a goal it speaks to that goal,
 * and while the goal is waiting on a question, what is typed here is the answer.
 *
 * The engine underneath is the composer's: encrypted drafts that survive a closed tab, uploads,
 * dictation, and a send that can be retried without starting the work twice.
 */
export default function AskBar({
  bootstrap,
  workspace,
  goal,
  moves,
  away
}: {
  bootstrap: Bootstrap;
  workspace: Workspace;
  goal: Task | null;
  moves: readonly OwnerMove[];
  /** True while a sheet is open over everything; the bar keeps its draft but cannot be reached. */
  away?: true | undefined;
}) {
  const [fresh, setFresh] = useState(false);
  const task = fresh ? null : goal;
  useEffect(() => setFresh(false), [goal?.id]);
  const question = task
    ? moves.find(
        (move): move is Extract<OwnerMove, { kind: 'question' }> =>
          move.kind === 'question' && move.taskId === task.id
      )
    : undefined;
  return (
    <AskForm
      key={task?.id ?? 'new'}
      away={away}
      bootstrap={bootstrap}
      workspace={workspace}
      task={task}
      question={question}
      canFresh={Boolean(goal) && !fresh}
      onFresh={() => setFresh(true)}
      onBack={goal && fresh ? () => setFresh(false) : undefined}
      running={bootstrap.tasks.filter((item) => growth(item, moves) === 'working').length}
    />
  );
}

function AskForm({
  bootstrap,
  workspace,
  task,
  question,
  canFresh,
  onFresh,
  onBack,
  running,
  away
}: {
  away: true | undefined;
  bootstrap: Bootstrap;
  workspace: Workspace;
  task: Task | null;
  question: Extract<OwnerMove, { kind: 'question' }> | undefined;
  canFresh: boolean;
  onFresh: () => void;
  onBack: (() => void) | undefined;
  running: number;
}) {
  const initialDraft = bootstrap.drafts.find(
    (draft) => draft.workspaceId === workspace.id && (draft.taskId ?? null) === (task?.id ?? null)
  );
  const scope = task?.id ?? NEW_GOAL;
  seedDirection(scope, initialDraft?.controls?.context);
  const context = useDirection(scope);
  const composer = useComposer({
    workspace,
    bootstrap,
    task,
    context,
    onContextChange: (next) => setDirection(scope, next),
    ...(initialDraft ? { initialDraft } : {}),
    onDraft: () => undefined,
    onSent: (sent) => {
      putTask(sent);
      setDirection(scope, null);
      if (!task) watchSent(sent.id);
      refreshSoon(800);
    },
    ...(question
      ? {
          answer: {
            question: question.question,
            onAnswer: async (text: string) => {
              await answerQuestion(question.taskId, question.questionId, text);
            }
          }
        }
      : {})
  });
  const {
    body,
    attachments,
    busy,
    uploading,
    error,
    recording,
    voiceBusy,
    editingDisabled,
    dictationSetup,
    dictationState,
    pendingTask,
    pendingSend,
    fileInput,
    input,
    changeBody,
    removeAttachment,
    upload,
    send,
    dictate,
    startDictation,
    setDictationSetup,
    cancelUpload,
    cancelDictation,
    recoverAsDraft,
    saved,
    draftConflict,
    resolveDraft,
    retryDraftSync,
    models,
    modelId,
    modelChoices,
    reasoningEffort,
    efforts,
    cap,
    securityMode,
    privacyRoute,
    interrupt,
    changeModel,
    changeEffort,
    changeCap,
    changeSecurityMode,
    changePrivacy,
    setInterrupt
  } = composer;
  const [optionsOpen, setOptionsOpen] = useState(false);
  const settings: AskSettings = {
    models,
    modelId,
    automatic: !task && Boolean(modelChoices.main?.automatic),
    efforts,
    reasoningEffort,
    cap,
    securityMode,
    privacyRoute: privacyRoute === 'external' ? 'external' : 'provider_zdr',
    privacyLocked: bootstrap.instance.enforceZeroDataRetention,
    interrupt
  };
  const summary = settingsSummary(settings, task?.securityMode ?? workspace.securityMode);
  // A synced draft is the normal state and is only announced; trouble is shown.
  const quiet = saved === 'Draft synced' || saved === 'Saving draft…';

  useEffect(() => {
    const focus = () => input.current?.focus();
    addEventListener('garden:rerun-analysis', focus);
    return () => removeEventListener('garden:rerun-analysis', focus);
  }, [input]);
  useEffect(() => {
    const stop = onAskText((text) => {
      changeBody(text);
      input.current?.focus();
    });
    return () => void stop();
  }, [changeBody, input]);

  const typing = body.trim().length > 8;
  const offline = workspace.status !== 'running';
  const placeholder = question
    ? `Answer: ${question.question}`
    : task
      ? 'Tell this goal something'
      : 'What should garden grow?';
  return (
    <form
      className={`ask ${typing ? 'is-typing' : ''}`}
      inert={away}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {dictationSetup && (
        <Suspense fallback={null}>
          <DictationSetup onClose={() => setDictationSetup(false)} onStart={startDictation} />
        </Suspense>
      )}
      {optionsOpen && !question && (
        <AskOptions
          settings={settings}
          forTask={Boolean(task)}
          running={Boolean(task && ['queued', 'planning', 'running'].includes(task.status))}
          disabled={editingDisabled}
          onModel={changeModel}
          onEffort={changeEffort}
          onCap={changeCap}
          onKeys={changeSecurityMode}
          onPrivacy={changePrivacy}
          onInterrupt={setInterrupt}
          onAttach={
            uploading || voiceBusy
              ? undefined
              : () => {
                  setOptionsOpen(false);
                  fileInput.current?.click();
                }
          }
          onClose={() => setOptionsOpen(false)}
        />
      )}
      <div className="ask-above" aria-live="polite">
        {typing && !task && (
          <>
            <span className="hint">
              {offline
                ? 'Your computer is asleep'
                : running
                  ? `Starts now beside ${running} growing`
                  : 'Starts now'}
            </span>
            <span className="hint">Anything big comes back as a deal first</span>
          </>
        )}
        {summary && !question && (
          <button type="button" className="hint hint-button" onClick={() => setOptionsOpen(true)}>
            <Tune /> {summary}
          </button>
        )}
        {canFresh && !typing && (
          <button type="button" className="hint hint-button" onClick={onFresh}>
            <Sprout /> Plant a new goal instead
          </button>
        )}
        {onBack && !typing && (
          <button type="button" className="hint hint-button" onClick={onBack}>
            Back to this goal
          </button>
        )}
        {context && (
          <span className="hint">
            {context.kind === 'analysis'
              ? `Rerun “${context.name || 'this analysis'}” with your changes`
              : context.kind === 'notes'
                ? `${context.notes.length} comment${context.notes.length === 1 ? '' : 's'} will go with this`
                : `“${context.text.replace(/\s+/g, ' ').slice(0, 48)}${context.text.length > 48 ? '…' : ''}” will go with this`}
            <button
              type="button"
              aria-label={
                context.kind === 'analysis'
                  ? 'Do not rerun it'
                  : context.kind === 'notes'
                    ? 'Drop the comments'
                    : 'Drop the passage'
              }
              onClick={() => setDirection(scope, null)}
            >
              <Close />
            </button>
          </span>
        )}
        {attachments.map((file) => (
          <span key={file.path} className="hint attachment">
            {file.name}
            <button
              type="button"
              aria-label={`Remove ${file.name}`}
              disabled={editingDisabled || uploading}
              onClick={() => removeAttachment(file.path)}
            >
              <Close />
            </button>
          </span>
        ))}
        {uploading && (
          <span className="hint">
            Uploading…{' '}
            <button type="button" className="hint-link" onClick={cancelUpload}>
              Cancel
            </button>
          </span>
        )}
        {voiceBusy && (
          <span className="hint">
            {dictationState === 'requesting'
              ? 'Waiting for the microphone…'
              : recording
                ? 'Listening…'
                : 'Writing it down…'}{' '}
            <button type="button" className="hint-link" onClick={cancelDictation}>
              Cancel
            </button>
          </span>
        )}
        {pendingSend && !pendingTask && !busy && (
          <span className="hint">
            The last send was not confirmed. Sending again reuses it.{' '}
            <button type="button" className="hint-link" onClick={() => void recoverAsDraft()}>
              Keep as a draft
            </button>
          </span>
        )}
        {draftConflict && (
          <span className="hint is-warn" title={draftConflict.body || '(No text)'}>
            A newer draft exists on another device.{' '}
            <button
              type="button"
              className="hint-link"
              disabled={busy}
              onClick={() => void resolveDraft('device')}
            >
              Keep mine
            </button>{' '}
            <button
              type="button"
              className="hint-link"
              disabled={busy}
              onClick={() => void resolveDraft('server')}
            >
              Use other draft
            </button>
          </span>
        )}
        {pendingTask && (
          <span className="hint">
            Sent, but the draft did not clear.{' '}
            <button type="button" className="hint-link" disabled={busy} onClick={retryDraftSync}>
              Retry and open it
            </button>
          </span>
        )}
        {saved && !draftConflict && !pendingTask && (
          <span className={`hint${quiet ? ' sr-only' : ''}`} role="status" aria-label={saved}>
            {saved}
          </span>
        )}
        {error ? (
          <span className="hint is-error">
            {error instanceof Error ? error.message : 'That did not send. Try again.'}
          </span>
        ) : null}
      </div>
      <div className="ask-field">
        <Sprout className="ask-mark" />
        <label className="sr-only" htmlFor="ask-input">
          {question
            ? `Your answer to: ${question.question}`
            : task
              ? `Direction for ${task.title}`
              : 'What should garden grow?'}
        </label>
        {/* Drawn rather than a placeholder: a textarea's own hint wraps, and the field grows with it. */}
        <span className="ask-input">
          <textarea
            id="ask-input"
            ref={input}
            rows={1}
            value={body}
            maxLength={200_000}
            disabled={editingDisabled || voiceBusy}
            onChange={(event) => changeBody(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          {!body && (
            <span className="ask-hint" aria-hidden="true">
              {placeholder}
            </span>
          )}
        </span>
        <input
          ref={fileInput}
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-label="Attach files"
          onChange={(event) => upload(event.target.files)}
        />
        {!question && (
          <button
            type="button"
            className="icon-btn ask-tune"
            aria-label="Options for this message"
            aria-expanded={optionsOpen}
            aria-controls="ask-options"
            onClick={() => setOptionsOpen((open) => !open)}
          >
            <Tune />
          </button>
        )}
        {!question && (
          <button
            type="button"
            className="icon-btn ask-attach"
            aria-label="Attach files"
            disabled={editingDisabled || uploading || voiceBusy}
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip />
          </button>
        )}
        {isNativeClient() && !question && (
          <Suspense fallback={null}>
            <LocalFolderAttachments
              disabled={editingDisabled || uploading || voiceBusy}
              remaining={Math.max(0, 20 - attachments.length)}
              onFiles={upload}
              onCancel={cancelUpload}
            />
          </Suspense>
        )}
        {typeof MediaRecorder !== 'undefined' && (
          <button
            type="button"
            className="icon-btn"
            aria-label={recording ? 'Stop dictation' : 'Dictate'}
            disabled={editingDisabled || uploading || (voiceBusy && !recording)}
            onClick={dictate}
          >
            {recording ? <Stop /> : <Mic />}
          </button>
        )}
        <button
          type="submit"
          className="send"
          aria-label={question ? 'Answer' : task ? 'Send to this goal' : 'Plant'}
          disabled={
            !(body.trim() || context?.kind === 'notes') ||
            uploading ||
            voiceBusy ||
            Boolean(pendingTask) ||
            offline ||
            busy
          }
        >
          <Up />
        </button>
      </div>
    </form>
  );
}
