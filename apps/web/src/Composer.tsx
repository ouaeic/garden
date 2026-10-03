import { lazy, Suspense, useId, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  CloudUpload,
  LoaderCircle,
  Paperclip,
  X,
  Mic,
  Square,
  SlidersHorizontal,
  ChevronDown
} from './icons';
import type { Task, TaskReasoningEffort } from '@garden/contracts';
import { permissionModeSummary } from './asking-rules';
import { effortLabel } from './reasoning-options';
import { isWorking } from './model';
import { isNativeClient } from './client';
import ModelPicker from './ModelPicker.js';
import ComposerPopover, { supportsPromptPopover } from './ComposerPopover';
import { ConfirmButton } from './management';
import { Button, Dialog, ErrorNotice } from './ui';
import { MAX_TASK_SPEND_USD } from './usage-model.js';
import { useComposer } from './use-composer';
import type { ComposerProps } from './composer-types';
import './composer-context.css';
import './composer-controls.css';
export type { ComposerProps } from './composer-types';
const PromptModelChoices = lazy(() => import('./PromptModels'));
const LocalFolderAttachments = lazy(() => import('./LocalFolderAttachments.js'));
const DictationSetup = lazy(() => import('./DictationSetup'));
const draftLabels: Record<string, string> = {
  'Draft synced': 'Saved',
  'Saving draft…': 'Saving…',
  'Saved on this device · waiting to sync': 'On device',
  'Recovered draft from this device': 'Recovered',
  'Draft not synced': 'Not synced',
  'Draft not saved': 'Not saved',
  'Choose a draft version': 'Conflict',
  'Send not confirmed · retry safely below': 'Unconfirmed',
  'Work sent · draft not synced': 'Not synced'
};

export default function Composer(props: ComposerProps) {
  const permissionHelpId = useId();
  const promptSettingsId = useId();
  const [promptSettingsOpen, setPromptSettingsOpen] = useState(false);
  const promptSettingsTrigger = useRef<HTMLButtonElement>(null);
  const promptSettingsPanel = useRef<HTMLDivElement>(null);
  const { workspace, task = null, bootstrap, toolbarExtra } = props;
  const [advancedModels, setAdvancedModels] = useState(false);
  const {
    context,
    body,
    attachments,
    modelId,
    modelChoices,
    reasoningEffort,
    privacyRoute,
    securityMode,
    cap,
    interrupt,
    busy,
    uploading,
    error,
    saved,
    draftConflict,
    dictationState,
    dictationSetup,
    pendingTask,
    pendingSend,
    fileInput,
    input,
    recording,
    voiceBusy,
    editingDisabled,
    models,
    projectModel,
    selectedModel,
    efforts,
    changeBody,
    removeAttachment,
    changeModel,
    changeModelChoices,
    changePrivacy,
    changeEffort,
    changeCap,
    changeSecurityMode,
    setInterrupt,
    setDictationSetup,
    upload,
    send,
    dictate,
    startDictation,
    resolveDraft,
    recoverAsDraft,
    retryDraftSync,
    cancelUpload,
    cancelDictation
  } = useComposer(props);
  const DraftIcon =
    saved === 'Draft synced'
      ? Check
      : saved === 'Saving draft…'
        ? LoaderCircle
        : saved === 'Saved on this device · waiting to sync'
          ? CloudUpload
          : CircleAlert;
  return (
    <form
      className={`intent-editor ${task ? 'follow-up' : ''}`}
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
      {context?.kind === 'notes' && (
        <ul className="composer-notes" aria-label="Your comments on the result">
          {context.notes.map((note, index) => (
            <li key={index}>
              <span className="composer-note-anchor">
                {note.quote
                  ? `“${note.quote.slice(0, 80)}${note.quote.length > 80 ? '…' : ''}”`
                  : note.region
                    ? `○ ${note.on}`
                    : note.on}
              </span>
              <span className="composer-note-text">{note.note || 'Look at this'}</span>
              {props.onContextChange && (
                <button
                  type="button"
                  aria-label="Remove this comment"
                  disabled={editingDisabled}
                  onClick={() => {
                    const rest = context.notes.filter((_, at) => at !== index);
                    props.onContextChange?.(rest.length ? { kind: 'notes', notes: rest } : null);
                  }}
                >
                  <X size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {context && context.kind !== 'notes' && (
        <section
          className="composer-context"
          aria-label={context.kind === 'analysis' ? 'Selected analysis' : 'Selected context'}
        >
          <div className="composer-context-copy">
            <span className="eyebrow">
              {context.kind === 'analysis' ? 'Rerun with changes' : 'Selected context'}
            </span>
            <p>{context.kind === 'analysis' ? context.name || 'Analysis run' : context.text}</p>
            {context.kind === 'analysis' && (
              <>
                <p className="muted">Describe the parameters or steps to change below.</p>
                <details>
                  <summary>Selected run</summary>
                  <code>{context.manifestPath}</code>
                  <p className="muted">
                    Garden will check this record and prepare a separate run, preserving the
                    original files.
                  </p>
                </details>
              </>
            )}
          </div>
          {props.onContextChange && (
            <Button
              disabled={editingDisabled}
              onClick={() => props.onContextChange?.(null)}
              aria-label="Clear selected context"
            >
              <X size={14} />
            </Button>
          )}
        </section>
      )}
      <label className="sr-only" htmlFor={`intent-${task?.id ?? 'new'}`}>
        {props.answer
          ? 'Your answer'
          : task
            ? 'Add direction to this work'
            : 'Describe what you want to do'}
      </label>
      <textarea
        id={`intent-${task?.id ?? 'new'}`}
        ref={input}
        value={body}
        disabled={editingDisabled || voiceBusy}
        maxLength={200000}
        rows={1}
        onChange={(event) => changeBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
        }}
        placeholder={
          props.answer
            ? 'Type your answer…'
            : context?.kind === 'notes'
              ? 'Anything else? Your comments are sent with this.'
              : task
                ? 'Reply, or ask for a change…'
                : 'Describe what you want to do…'
        }
      />
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((file) => (
            <span key={file.path}>
              {file.name}
              <button
                type="button"
                aria-label={`Remove ${file.name} from this direction`}
                disabled={editingDisabled || uploading || voiceBusy}
                onClick={() => removeAttachment(file.path)}
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="intent-toolbar">
        <div className="composer-tools">
          <input
            ref={fileInput}
            type="file"
            multiple
            disabled={editingDisabled || uploading || voiceBusy}
            className="sr-only"
            tabIndex={-1}
            aria-label="Attach files"
            onChange={(event) => upload(event.target.files)}
          />
          {!props.answer && (
            <Button
              aria-label="Attach files"
              title="Attach files"
              onClick={() => fileInput.current?.click()}
              disabled={editingDisabled || uploading || voiceBusy}
            >
              <Paperclip size={18} />
            </Button>
          )}
          {isNativeClient() && !props.answer && (
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
            <Button
              aria-label={recording ? 'Stop dictation' : 'Dictate direction'}
              title={recording ? 'Stop dictation' : 'Dictate direction'}
              onClick={dictate}
              disabled={editingDisabled || uploading || (voiceBusy && !recording)}
            >
              {recording ? <Square size={16} /> : <Mic size={18} />}
            </Button>
          )}
          {toolbarExtra}
        </div>
        {!props.answer && (
          <div className="composer-model-picker">
            <ModelPicker
              label="Model for this direction"
              triggerLabel={
                !task && modelChoices.main?.automatic
                  ? 'Automatic'
                  : (selectedModel?.displayName ??
                    (modelId ||
                      (props.project
                        ? 'Project default'
                        : task
                          ? 'Conversation model'
                          : 'Default model')))
              }
              loadDetails
              privacyRoute={privacyRoute}
              value={!task && modelChoices.main?.automatic ? '__automatic' : modelId}
              models={models}
              shortcuts={[
                {
                  value: '',
                  label: task
                    ? (projectModel?.displayName ?? 'Current conversation model')
                    : props.project
                      ? 'Use project default'
                      : 'Use global default'
                },
                ...(!task ? [{ value: '__automatic', label: 'Automatic for this project' }] : [])
              ]}
              disabled={editingDisabled || uploading || voiceBusy}
              onChange={changeModel}
              onAdvanced={() => setAdvancedModels(true)}
            />
          </div>
        )}
        {!props.answer && (
          <Button
            ref={promptSettingsTrigger}
            className="compact-prompt-settings"
            aria-label="Prompt settings"
            title={`${securityMode[0]!.toUpperCase() + securityMode.slice(1)} approvals · ${effortLabel(reasoningEffort)} effort${cap ? ` · $${cap} ${task ? 'extra limit' : 'limit'}` : ''}`}
            aria-expanded={promptSettingsOpen}
            aria-haspopup="dialog"
            aria-controls={promptSettingsId}
            popoverTarget={supportsPromptPopover ? promptSettingsId : undefined}
            onClick={
              supportsPromptPopover ? undefined : () => setPromptSettingsOpen((open) => !open)
            }
          >
            <SlidersHorizontal size={16} />
            <span className="composer-mode-label">
              {securityMode[0]!.toUpperCase() + securityMode.slice(1)}
            </span>
            <ChevronDown size={12} aria-hidden="true" />
          </Button>
        )}
        <div className="composer-submit">
          {saved && (
            // A synced draft is the normal state and says nothing; only trouble is shown.
            <small
              className={`draft-status${saved === 'Draft synced' || saved === 'Saving draft…' ? ' sr-only' : ''}`}
              role="status"
              aria-label={saved}
              title={saved}
            >
              <DraftIcon
                size={13}
                className={saved === 'Saving draft…' ? 'spin' : ''}
                aria-hidden="true"
              />
              <span aria-hidden="true">{draftLabels[saved] ?? 'Draft status'}</span>
            </small>
          )}
          <Button
            type="submit"
            className="primary"
            disabled={
              !(body.trim() || context?.kind === 'notes') ||
              uploading ||
              voiceBusy ||
              Boolean(pendingTask) ||
              workspace.status !== 'running'
            }
            busy={busy}
          >
            {busy
              ? pendingTask
                ? 'Opening…'
                : 'Sending…'
              : props.answer
                ? 'Answer'
                : pendingSend
                  ? 'Retry send'
                  : task
                    ? isWorking(task)
                      ? interrupt
                        ? 'Update run'
                        : 'Queue next'
                      : 'Send'
                    : 'Start'}
            {!busy && <ArrowUpRight size={18} />}
          </Button>
        </div>
      </div>
      {uploading && (
        <div className="row muted" role="status">
          Uploading…<Button onClick={cancelUpload}>Cancel upload</Button>
        </div>
      )}
      {voiceBusy && (
        <div className="row muted" role="status">
          {dictationState === 'requesting'
            ? 'Waiting for microphone access…'
            : recording
              ? 'Recording…'
              : 'Transcribing…'}
          <Button onClick={cancelDictation}>Cancel dictation</Button>
        </div>
      )}
      {pendingSend && !pendingTask && !busy && (
        <div className="draft-conflict" role="status">
          <p>
            The earlier send was not confirmed. Retry send looks up the saved receipt for that exact
            request. It does not start another task.
          </p>
          <ConfirmButton
            label="Keep as an unsent draft"
            description="The earlier request may already have created work. Check All work before sending this as a new request. Keep the text and discard its saved retry identity?"
            action={recoverAsDraft}
          />
        </div>
      )}
      {pendingTask && (
        <div className="row">
          <Button busy={busy} onClick={retryDraftSync}>
            Retry draft sync and open work
          </Button>
        </div>
      )}
      <ComposerPopover
        id={promptSettingsId}
        anchor={promptSettingsTrigger}
        panel={promptSettingsPanel}
        open={promptSettingsOpen}
        onOpenChange={setPromptSettingsOpen}
      >
        <div className="composer-settings-grid">
          <label className="composer-setting">
            <span>Approvals</span>
            <select
              aria-label="Approvals for this prompt"
              title={permissionModeSummary(securityMode)}
              aria-describedby={permissionHelpId}
              value={securityMode}
              disabled={editingDisabled}
              onChange={(event) => changeSecurityMode(event.target.value as Task['securityMode'])}
            >
              <option value="review">Review</option>
              <option value="balanced">Balanced</option>
              <option value="autonomous">Autonomous</option>
            </select>
            <span className="sr-only" id={permissionHelpId}>
              {permissionModeSummary(securityMode)}
            </span>
          </label>
          <label className="composer-setting">
            <span>Reasoning</span>
            <select
              aria-label="Model reasoning effort"
              title={
                efforts.length < 2
                  ? selectedModel
                    ? 'This model does not expose adjustable effort'
                    : 'Select a model to choose its effort'
                  : 'Reasoning effort'
              }
              value={efforts.includes(reasoningEffort) ? reasoningEffort : 'auto'}
              disabled={editingDisabled || efforts.length < 2}
              onChange={(event) => changeEffort(event.target.value as TaskReasoningEffort)}
            >
              {efforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effortLabel(effort)}
                </option>
              ))}
            </select>
          </label>
          <label className="composer-setting">
            <span>Privacy</span>
            <select
              value={privacyRoute}
              disabled={
                editingDisabled ||
                uploading ||
                voiceBusy ||
                bootstrap.instance.enforceZeroDataRetention
              }
              onChange={(event) =>
                changePrivacy(event.target.value === 'external' ? 'external' : 'provider_zdr')
              }
            >
              <option value="provider_zdr">Zero retention</option>
              <option value="external">Retention allowed</option>
            </select>
          </label>
          <label className="composer-setting">
            <span>{task ? 'Extra budget · USD' : 'Budget · USD'}</span>
            <input
              type="number"
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault();
              }}
              min="0.01"
              max={MAX_TASK_SPEND_USD}
              disabled={editingDisabled || uploading || voiceBusy}
              step="0.01"
              value={cap}
              onChange={(event) => changeCap(event.target.value)}
              placeholder={task ? 'No increase' : 'Default limit'}
              aria-label={task ? 'Additional spend limit in USD' : 'Task spend limit in USD'}
            />
          </label>
          {task && isWorking(task) && (
            <label className="composer-setting">
              <span>Message timing</span>
              <select
                value={interrupt ? 'now' : 'next'}
                disabled={editingDisabled || uploading || voiceBusy}
                onChange={(event) => setInterrupt(event.target.value === 'now')}
                aria-label="Message timing"
              >
                <option value="now">Send now</option>
                <option value="next">Queue for next run</option>
              </select>
            </label>
          )}
        </div>
        {task && (
          <Button
            className="composer-models-link"
            aria-label="Model choices for this direction"
            onClick={() => {
              promptSettingsPanel.current?.hidePopover();
              setPromptSettingsOpen(false);
              promptSettingsTrigger.current?.focus();
              setAdvancedModels(true);
            }}
          >
            More model choices <ArrowUpRight size={16} />
          </Button>
        )}
      </ComposerPopover>
      {advancedModels && (
        <Dialog
          title="Model choices"
          className="prompt-model-dialog"
          onClose={() => setAdvancedModels(false)}
          wide
        >
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <PromptModelChoices
              projectId={props.project?.id}
              {...(task ? { taskId: task.id } : { taskId: '' })}
              disabled={editingDisabled}
              choices={modelChoices}
              saved={saved}
              onClose={() => setAdvancedModels(false)}
              privacyRoute={privacyRoute}
              onChange={task ? () => changeModel('') : changeModelChoices}
            />
          </Suspense>
        </Dialog>
      )}
      <ErrorNotice error={error} />
      {draftConflict && (
        <div className="draft-conflict" role="alert">
          <strong>A newer draft exists on another device.</strong>
          <p>Your text is kept here. Choose which version to continue with.</p>
          <details>
            <summary>View the other draft</summary>
            <pre>{draftConflict.body || '(No text)'}</pre>
          </details>
          <div className="row">
            <Button disabled={busy} onClick={() => void resolveDraft('device')}>
              Keep my draft
            </Button>
            <Button disabled={busy} onClick={() => void resolveDraft('server')}>
              Use other draft
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}
