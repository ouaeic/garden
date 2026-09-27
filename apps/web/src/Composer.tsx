import { lazy, Suspense, useId, useState } from 'react';
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
  SlidersHorizontal
} from 'lucide-react';
import type { Task, TaskReasoningEffort } from '@athanor/contracts';
import { permissionModeSummary } from './asking-rules';
import { effortLabel } from './reasoning-options';
import { isWorking } from './model';
import { isNativeClient } from './client';
import ModelPicker from './ModelPicker.js';
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
      {context && (
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
        {task ? 'Add direction to this work' : 'Describe what you want to do'}
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
        placeholder={task ? 'Add a direction…' : 'Describe what you want to do…'}
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
          <Button
            aria-label="Attach files"
            title="Attach files"
            onClick={() => fileInput.current?.click()}
            disabled={editingDisabled || uploading || voiceBusy}
          >
            <Paperclip size={18} />
          </Button>
          {isNativeClient() && (
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
        <Button
          className="compact-prompt-settings"
          aria-label="Prompt settings"
          title={`${selectedModel?.displayName ?? projectModel?.displayName ?? 'Default model'} · ${securityMode} · Prompt settings`}
          aria-expanded={promptSettingsOpen}
          aria-controls={promptSettingsId}
          onClick={() => setPromptSettingsOpen((open) => !open)}
        >
          <SlidersHorizontal size={15} />
          <span className="composer-model-label">
            {selectedModel?.displayName ?? projectModel?.displayName ?? 'Default model'}
          </span>
          <span className="composer-mode-label">
            {securityMode[0]!.toUpperCase() + securityMode.slice(1)}
          </span>
        </Button>
        <div className="composer-submit">
          {saved && (
            <small className="draft-status" role="status" aria-label={saved} title={saved}>
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
              !body.trim() ||
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
      <div
        id={promptSettingsId}
        className={`prompt-settings-content${promptSettingsOpen ? ' is-open' : ''}`}
      >
        <div className="garden-model-controls">
          <div className="garden-model-settings">
            <div className="garden-model-select">
              <span>Model</span>
              <ModelPicker
                label="Model for this direction"
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
              />
            </div>
            <label className="garden-approval-select">
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
            {task && isWorking(task) && (
              <label className="garden-route-control">
                <span>Send</span>
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
        </div>
        <details className="garden-prompt-options">
          <summary>
            Options
            {cap && (
              <small>
                ${cap} {task ? 'extra limit' : 'limit'}
              </small>
            )}
            {reasoningEffort !== 'auto' && <small>{effortLabel(reasoningEffort)} effort</small>}
            {privacyRoute === 'external' && <small>External route</small>}
          </summary>
          <div className="garden-prompt-options-grid">
            <Button
              aria-label="Model choices for this direction"
              aria-expanded={advancedModels}
              title="Model choices for this direction"
              onClick={() => setAdvancedModels((open) => !open)}
            >
              <SlidersHorizontal size={14} />
              Advanced models
            </Button>

            <label className="garden-effort-control">
              <span>Effort</span>
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
            <label className="garden-route-control">
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
                <option value="provider_zdr">Zero provider retention</option>
                <option value="external">Provider retention allowed</option>
              </select>
            </label>
            <label className="garden-cap-control">
              <span>{task ? 'Extra limit' : 'Limit'}</span>
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
                placeholder="USD"
                aria-label={task ? 'Additional spend limit in USD' : 'Task spend limit in USD'}
              />
            </label>
          </div>
        </details>
      </div>
      {advancedModels && (
        <Dialog title="Model choices" onClose={() => setAdvancedModels(false)} wide>
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <PromptModelChoices
              projectId={props.project?.id}
              {...(task ? { taskId: task.id } : { taskId: '' })}
              disabled={editingDisabled}
              choices={modelChoices}
              privacyRoute={privacyRoute}
              onChange={changeModelChoices}
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
