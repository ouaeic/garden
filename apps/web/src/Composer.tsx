import { lazy, Suspense, useId, useState } from 'react';
import { ArrowUpRight, Paperclip, X, Mic, Square, SlidersHorizontal } from 'lucide-react';
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
export type { ComposerProps } from './composer-types';
const PromptModelChoices = lazy(() => import('./PromptModels'));
const LocalFolderAttachments = lazy(() => import('./LocalFolderAttachments.js'));
const DictationSetup = lazy(() => import('./DictationSetup'));

export default function Composer(props: ComposerProps) {
  const permissionHelpId = useId();
  const { workspace, task = null, bootstrap, scope, toolbarExtra } = props;
  const [advancedModels, setAdvancedModels] = useState(false);
  const {
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
      {scope && <div className="scope-label">This direction includes your selected context.</div>}
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
        <div className="row">
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
          {toolbarExtra && <div className="toolbar-extra">{toolbarExtra}</div>}
          {typeof MediaRecorder !== 'undefined' && (
            <Button
              aria-label={recording ? 'Stop dictation' : 'Dictate direction'}
              onClick={dictate}
              disabled={editingDisabled || uploading || (voiceBusy && !recording)}
            >
              {recording ? <Square size={16} /> : <Mic size={18} />}
            </Button>
          )}
        </div>
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
          {pendingSend
            ? 'Retry send'
            : task
              ? isWorking(task)
                ? interrupt
                  ? 'Update run'
                  : 'Queue next'
                : 'Send'
              : 'Begin'}
          <ArrowUpRight size={18} />
        </Button>
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
          <Button
            aria-label="Model choices for this direction"
            aria-expanded={advancedModels}
            title="Model choices for this direction"
            onClick={() => setAdvancedModels((open) => !open)}
          >
            <SlidersHorizontal size={14} />
          </Button>
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
              <option value="provider_zdr">Private</option>
              <option value="external">External</option>
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
          {task && isWorking(task) && (
            <label className="garden-route-control">
              <span>Apply</span>
              <select
                value={interrupt ? 'now' : 'next'}
                disabled={editingDisabled || uploading || voiceBusy}
                onChange={(event) => setInterrupt(event.target.value === 'now')}
                aria-label="Apply this direction"
              >
                <option value="now">Now</option>
                <option value="next">Next run</option>
              </select>
            </label>
          )}
        </div>
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
      {saved && (
        <small className="draft-status" role="status">
          {saved}
        </small>
      )}
    </form>
  );
}
