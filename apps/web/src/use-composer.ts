import { useEffect, useRef, useState } from 'react';
import type {
  Task,
  TaskReasoningEffort,
  ProjectModelChoices,
  ProjectModelPreferences
} from '@garden/contracts';
import type { Draft, DraftAttachment } from './model';
import { defaultPrivacy, isWorking, text, data } from './model';
import { get, patch, post, request } from './client';
import { effortChoices } from './reasoning-options';
import { useAutosizeTextarea } from './use-autosize-textarea';
import {
  dictationSession,
  spendCap,
  transcriptionPayload,
  uploadAttachments,
  type DictationState
} from './composer-operations';
import { DraftConflict, DraftSync } from './draft-sync';
import { draftStorage, keepsDeviceDrafts, recoveryFor, writeDraft } from './draft-storage';
import type { DictationConsent } from './dictation-preflight';
import type { ComposerProps } from './composer-types';
import { directionPrompt } from './direction-context';

/** Owns draft persistence, delivery recovery and input operations for one composer scope. */
export function useComposer({
  workspace,
  project,
  execution,
  source,
  task = null,
  bootstrap,
  initialDraft,
  context: suppliedContext,
  onContextChange,
  onEditingChange,
  onSent,
  onDraft
}: ComposerProps) {
  const context =
    suppliedContext === undefined ? (initialDraft?.controls?.context ?? null) : suppliedContext;
  const [body, setBody] = useState(initialDraft?.body ?? '');
  const [attachments, setAttachments] = useState<DraftAttachment[]>(
    initialDraft?.attachments ?? []
  );
  const [modelId, setModelId] = useState(initialDraft?.controls?.modelId ?? '');
  const [modelChoices, setModelChoices] = useState<ProjectModelChoices>(
    initialDraft?.controls?.modelChoices ?? {}
  );
  const [projectMain, setProjectMain] = useState<string | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<TaskReasoningEffort>(
    initialDraft?.controls?.reasoningEffort ?? task?.reasoningEffort ?? 'auto'
  );
  const [privacyRoute, setPrivacyRoute] = useState(
    initialDraft?.controls?.privacyRoute ?? task?.privacyRoute ?? defaultPrivacy(bootstrap)
  );
  const [securityMode, setSecurityMode] = useState<Task['securityMode']>(
    initialDraft?.controls?.securityMode ??
      task?.securityMode ??
      project?.securityMode ??
      workspace.securityMode
  );
  const [cap, setCap] = useState(initialDraft?.controls?.spendCap ?? '');
  const [interrupt, setInterrupt] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(
    initialDraft?.recoveryId ? 'Recovered draft from this device' : ''
  );
  const [draftConflict, setDraftConflict] = useState<Draft | null>(null);
  const [dictationState, setDictationState] = useState<DictationState>('idle');
  const [dictationSetup, setDictationSetup] = useState(false);
  const [pendingTask, setPendingTask] = useState<Task | null>(null);
  const [pendingSend, setPendingSend] = useState(Boolean(recoveryFor(initialDraft)?.submission));
  const fileInput = useRef<HTMLInputElement>(null);
  const input = useAutosizeTextarea(body);
  const voice = useRef<ReturnType<typeof dictationSession> | null>(null);
  const voiceState = useRef<DictationState>('idle');
  const dictationConsent = useRef<DictationConsent | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const changed = useRef(false);
  const sending = useRef(false);
  const mounted = useRef(true);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRevision = useRef(0);
  const pendingDraft = useRef<Draft | null>(null);
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const [draftWrites] = useState(
    () =>
      new DraftSync({
        draft: initialDraft ?? {
          workspaceId: workspace.id,
          taskId: task?.id ?? null,
          body: '',
          attachments: []
        },
        recovery: recoveryFor(initialDraft),
        storage: draftStorage,
        write: writeDraft,
        onStatus: (status, cause) => {
          if (!mounted.current || sending.current) return;
          setSaved(
            status === 'pending_delivery'
              ? 'Send not confirmed · retry safely below'
              : status === 'synced'
                ? 'Draft synced'
                : status === 'device'
                  ? keepsDeviceDrafts()
                    ? 'Saved on this device · waiting to sync'
                    : 'Draft not synced'
                  : status === 'saving'
                    ? 'Saving draft…'
                    : status === 'conflict'
                      ? 'Choose a draft version'
                      : 'Draft not saved'
          );
          if (status === 'conflict' && cause instanceof DraftConflict)
            setDraftConflict(cause.server);
          else if (status === 'unsaved') setError(cause);
        },
        onSynced: (draft) => {
          if (pendingDraft.current && draft.revision !== undefined)
            pendingDraft.current.revision = draft.revision;
          onDraftRef.current(pendingDraft.current ?? draft);
        }
      })
  );
  useEffect(() => {
    const sync = () => {
      void draftWrites.flush().catch(() => undefined);
    };
    sync();
    window.addEventListener('online', sync);
    return () => window.removeEventListener('online', sync);
  }, [draftWrites]);
  useEffect(() => {
    if (!task && !project) return;
    const controller = new AbortController();
    let currentPreferences: ProjectModelPreferences | null = null;
    const apply = (current: ProjectModelPreferences) => {
      if (controller.signal.aborted || current.revision < (currentPreferences?.revision ?? 0))
        return;
      currentPreferences = current;
      setProjectMain(
        current.purposes.find((item) => item.purpose === 'main')?.effective?.id ?? null
      );
    };
    const load = () => {
      void get<ProjectModelPreferences>(
        project
          ? `/v1/projects/${project.id}/model-preferences`
          : `/v1/tasks/${task!.id}/model-preferences`,
        {
          signal: controller.signal
        }
      )
        .then(apply)
        .catch(() => undefined);
    };
    const updated = (event: Event) => {
      const next = (event as CustomEvent<ProjectModelPreferences>).detail;
      if (
        next.projectTaskId !== (currentPreferences?.projectTaskId ?? project?.id ?? task!.projectId)
      )
        return;
      apply(next);
    };
    load();
    window.addEventListener('garden-model-preferences', updated);
    return () => {
      controller.abort();
      window.removeEventListener('garden-model-preferences', updated);
    };
  }, [task?.id, project?.id]);
  const conversationDraft: NonNullable<Draft['controls']>['conversation'] =
    !task && project
      ? {
          projectId: project.id,
          execution: execution ?? 'independent',
          ...(source ? { source } : {})
        }
      : undefined;
  const contextSignature = JSON.stringify(context);
  const previousContext = useRef(JSON.stringify(initialDraft?.controls?.context ?? null));
  useEffect(() => {
    if (previousContext.current !== contextSignature) {
      changed.current = true;
      previousContext.current = contextSignature;
    }
  }, [contextSignature]);
  const conversationSignature = JSON.stringify(conversationDraft);
  const previousConversation = useRef(conversationSignature);
  useEffect(() => {
    if (previousConversation.current !== conversationSignature) {
      changed.current = true;
      previousConversation.current = conversationSignature;
    }
  }, [conversationSignature]);
  useEffect(() => {
    if (!changed.current || sending.current || busy) return;
    const draft: Draft = {
      workspaceId: workspace.id,
      taskId: task?.id ?? null,
      body,
      attachments,
      controls: {
        modelId,
        reasoningEffort,
        securityMode,
        privacyRoute,
        spendCap: cap,
        ...(context ? { context } : {}),
        ...(conversationDraft ? { conversation: conversationDraft } : {}),
        ...(!task ? { modelChoices } : {})
      }
    };
    onDraftRef.current(draft);
    pendingDraft.current = draft;
    const revision = ++draftRevision.current;
    void draftWrites.stage(draft).catch(() => undefined);
    draftTimer.current = setTimeout(() => {
      setSaved('Saving draft…');
      void draftWrites
        .flush()
        .then(() => {
          if (mounted.current && !sending.current && revision === draftRevision.current)
            setSaved('Draft synced');
          if (pendingDraft.current === draft) pendingDraft.current = null;
        })
        .catch((err: unknown) => {
          if (
            mounted.current &&
            !sending.current &&
            revision === draftRevision.current &&
            !keepsDeviceDrafts()
          )
            setError(err);
        });
    }, 650);
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, [
    body,
    conversationSignature,
    contextSignature,
    attachments,
    modelId,
    modelChoices,
    reasoningEffort,
    securityMode,
    privacyRoute,
    cap,
    workspace.id,
    task?.id,
    busy,
    draftWrites
  ]);
  useEffect(() => {
    mounted.current = true;
    voice.current = dictationSession({
      getStream: () => navigator.mediaDevices.getUserMedia({ audio: true }),
      createRecorder: (stream) => new MediaRecorder(stream),
      transcribe: async (audio, signal) => {
        const consent = dictationConsent.current;
        if (!consent) throw new Error('Review dictation options before recording.');
        const payload = await transcriptionPayload(audio, signal);
        signal.throwIfAborted();
        const result = await post<unknown>(
          '/v1/audio/transcriptions',
          { ...payload, ...consent },
          { signal }
        );
        return text(data(result).text);
      },
      onText: (transcript) => {
        changed.current = true;
        setBody((current) => [current, transcript].filter(Boolean).join('\n'));
        input.current?.focus();
      },
      onError: setError,
      onState: (state) => {
        if (state === 'idle') dictationConsent.current = null;
        voiceState.current = state;
        setDictationState(state);
      }
    });
    return () => {
      mounted.current = false;
      uploadController.current?.abort();
      voice.current?.dispose();
      voiceState.current = 'idle';
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (pendingDraft.current && !sending.current) {
        void draftWrites.save(pendingDraft.current).catch(() => undefined);
      }
    };
  }, []);
  async function upload(files: FileList | readonly File[] | null): Promise<boolean> {
    if (
      !files?.length ||
      sending.current ||
      uploadController.current ||
      voiceState.current !== 'idle' ||
      pendingTask
    )
      return false;
    setUploading(true);
    setError(null);
    const controller = new AbortController();
    uploadController.current = controller;
    try {
      await uploadAttachments(
        Array.from(files),
        attachments.length,
        controller.signal,
        (path, file, signal) =>
          request(`/v1/workspaces/${workspace.id}/file?path=${encodeURIComponent(path)}`, {
            method: 'PUT',
            body: file,
            headers: { 'Content-Type': 'application/octet-stream' },
            signal
          }),
        (attachment) => {
          if (!mounted.current) return;
          changed.current = true;
          setAttachments((current) => [...current, attachment]);
        }
      );
      return true;
    } catch (err) {
      if (mounted.current && !controller.signal.aborted) setError(err);
      return false;
    } finally {
      if (uploadController.current === controller) uploadController.current = null;
      if (mounted.current) setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  const clearedDraft = (): Draft => ({
    workspaceId: workspace.id,
    taskId: task?.id ?? null,
    body: '',
    attachments: []
  });
  async function finishDelivery(result: Task) {
    try {
      await draftWrites.finishSubmission(clearedDraft());
      if (mounted.current) {
        setPendingTask(null);
        setPendingSend(false);
        setSaved('');
        onSent(result);
      }
    } catch (cause) {
      if (mounted.current) {
        setPendingTask(result);
        setSaved('Work sent · draft not synced');
        setError(
          new Error(
            'Your work was sent, but its saved draft could not be cleared. Retry draft sync to open it.',
            { cause }
          )
        );
      }
    }
  }
  async function resolveDraft(choice: 'device' | 'server') {
    setBusy(true);
    try {
      const draft = await draftWrites.resolve(choice);
      if (choice === 'server') {
        changed.current = false;
        pendingDraft.current = null;
        setBody(draft.body);
        setAttachments(draft.attachments);
        setModelId(draft.controls?.modelId ?? '');
        setModelChoices(draft.controls?.modelChoices ?? {});
        setReasoningEffort(draft.controls?.reasoningEffort ?? task?.reasoningEffort ?? 'auto');
        setPrivacyRoute(
          draft.controls?.privacyRoute ?? task?.privacyRoute ?? defaultPrivacy(bootstrap)
        );
        setSecurityMode(
          draft.controls?.securityMode ??
            task?.securityMode ??
            project?.securityMode ??
            workspace.securityMode
        );
        setCap(draft.controls?.spendCap ?? '');
        previousContext.current = JSON.stringify(draft.controls?.context ?? null);
        onContextChange?.(draft.controls?.context ?? null);
      }
      setDraftConflict(null);
      setError(null);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    if (
      dictationSetup ||
      !(body.trim() || context?.kind === 'notes') ||
      sending.current ||
      uploadController.current ||
      voiceState.current !== 'idle' ||
      workspace.status !== 'running' ||
      pendingTask
    )
      return;
    if (!navigator.onLine) {
      setError(new Error('You are offline. Your draft is kept; reconnect before sending.'));
      return;
    }
    let limit: number | undefined;
    let prompt: string;
    try {
      limit = spendCap(cap);
      prompt = directionPrompt(body, context, task?.workspaceId ?? workspace.id);
    } catch (cause) {
      setError(cause);
      return;
    }
    sending.current = true;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    ++draftRevision.current;
    setBusy(true);
    setError(null);
    const payload = {
      prompt,
      attachments: attachments.map((file) => file.path),
      ...(modelId ? { modelId } : {}),
      ...(!task && Object.keys(modelChoices).length ? { modelChoices } : {}),
      reasoningEffort,
      securityMode,
      privacyRoute,
      ...(limit !== undefined ? { maxSpendUsd: limit } : {}),
      ...(task ? { interrupt } : { workspaceId: workspace.id }),
      ...(!task && project
        ? {
            projectId: project.id,
            execution: execution ?? 'independent',
            ...(source ? { source } : {})
          }
        : {})
    };
    const previous = draftWrites.pendingSubmission;
    const signature = previous?.signature ?? JSON.stringify(payload);
    const submittedPayload: unknown = previous ? JSON.parse(previous.signature) : payload;
    try {
      if (!previous && context?.kind === 'analysis') {
        const { checkAnalysisSelection } = await import('./computer/analysis-selection');
        await checkAnalysisSelection(context);
      }
      await draftWrites.flush();
      const key = await draftWrites.prepareSubmission(
        signature,
        pendingDraft.current ?? {
          workspaceId: workspace.id,
          taskId: task?.id ?? null,
          body,
          attachments,
          controls: {
            modelId,
            modelChoices,
            reasoningEffort,
            securityMode,
            privacyRoute,
            spendCap: cap,
            ...(context ? { context } : {}),
            ...(conversationDraft ? { conversation: conversationDraft } : {})
          }
        }
      );
      setPendingSend(true);
      const result = await post<Task>(
        task ? `/v1/tasks/${task.id}/messages` : '/v1/tasks',
        submittedPayload,
        {
          idempotencyKey: key,
          ...(previous ? { headers: { 'idempotency-replay-only': 'true' } } : {})
        }
      );
      changed.current = false;
      pendingDraft.current = null;
      if (mounted.current) {
        setBody('');
        setAttachments([]);
      }
      onDraftRef.current(clearedDraft());
      await finishDelivery(result);
    } catch (err) {
      if (mounted.current) {
        setError(err);
        if (err instanceof DraftConflict) setDraftConflict(err.server);
      }
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function dictate() {
    if (voiceState.current === 'recording') {
      voice.current?.stop();
      return;
    }
    if (sending.current || uploadController.current || pendingTask || voiceState.current !== 'idle')
      return;
    setError(null);
    setDictationSetup(true);
  }
  function changeSecurityMode(next: Task['securityMode']) {
    changed.current = true;
    setSecurityMode(next);
    setError(null);
    if (!task || !isWorking(task)) return;
    setBusy(true);
    void patch<Task>(`/v1/tasks/${task.id}/security-mode`, { securityMode: next })
      .then((updated) => {
        if (mounted.current) onSent(updated);
      })
      .catch((cause: unknown) => {
        if (mounted.current) {
          setSecurityMode(task.securityMode);
          setError(cause);
        }
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  }
  const recording = dictationState === 'recording';
  const voiceBusy = dictationState !== 'idle';
  const editingDisabled = busy || Boolean(pendingTask) || pendingSend;
  useEffect(() => {
    onEditingChange?.(editingDisabled);
  }, [editingDisabled, onEditingChange]);
  const models = bootstrap.models.filter((model) => model.privacyRoute === privacyRoute);
  const projectModel = models.find((model) => model.id === (projectMain || task?.modelId));
  const selectedModel = models.find(
    (model) => model.id === (modelId || projectMain || task?.modelId)
  );
  const efforts = effortChoices(selectedModel?.reasoning);
  function changeBody(value: string) {
    changed.current = true;
    setBody(value);
  }
  function removeAttachment(filePath: string) {
    changed.current = true;
    setAttachments((current) => current.filter((item) => item.path !== filePath));
  }
  function changeModel(value: string) {
    changed.current = true;
    setModelId(value === '__automatic' ? '' : value);
    if (!task)
      setModelChoices((current) => {
        const next = { ...current };
        if (!value) delete next.main;
        else
          next.main = {
            automatic: value === '__automatic',
            preference: current.main?.preference ?? 'balanced',
            modelId: value === '__automatic' ? '' : value
          };
        return next;
      });
    setReasoningEffort('auto');
  }
  function changeModelChoices(choices: ProjectModelChoices) {
    changed.current = true;
    setModelChoices(choices);
    setModelId(choices.main?.automatic === false ? choices.main.modelId : '');
    if (JSON.stringify(choices.main) !== JSON.stringify(modelChoices.main))
      setReasoningEffort('auto');
  }
  function changePrivacy(value: 'external' | 'provider_zdr') {
    changed.current = true;
    setPrivacyRoute(value);
    setModelId('');
    setModelChoices((current) => {
      const next = { ...current };
      delete next.main;
      return next;
    });
    setReasoningEffort('auto');
  }
  function changeEffort(value: TaskReasoningEffort) {
    changed.current = true;
    setReasoningEffort(value);
  }
  function changeCap(value: string) {
    changed.current = true;
    setCap(value);
  }
  function startDictation(consent: DictationConsent, maxSeconds: number) {
    dictationConsent.current = consent;
    setDictationSetup(false);
    void voice.current?.start({ maxMilliseconds: maxSeconds * 1000 });
  }
  async function recoverAsDraft() {
    await draftWrites.abandonSubmission();
    setPendingSend(false);
    setError(null);
  }
  function retryDraftSync() {
    if (sending.current || !pendingTask) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    void finishDelivery(pendingTask).finally(() => {
      sending.current = false;
      if (mounted.current) setBusy(false);
    });
  }
  const cancelUpload = () => uploadController.current?.abort();
  const cancelDictation = () => voice.current?.cancel();
  return {
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
  };
}
