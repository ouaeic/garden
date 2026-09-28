import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Square, VolumeX } from 'lucide-react';
import type {
  Task,
  VoiceModels,
  VoiceModelOption,
  VoiceSession as Session,
  VoiceStartRequest,
  VoiceWorkProposal,
  VoiceReasoningEffort
} from '@garden/contracts';
import { get, post, del } from '../client';
import { money, statusLabel } from '../model';
import { Button, Dialog, ErrorNotice, Field, Spinner } from '../ui';
import AudioReceipts from '../AudioReceipts';
import { createVoiceSessionController } from './voice-session';
import { VOICE_MAX_SPEND_USD } from './audio-constants';

const terminal = (session: Session) =>
  ['ended', 'expired', 'lost', 'usage_uncertain'].includes(session.status);

function VoiceSessionPanel({
  task,
  onClose,
  onTaskChanged
}: {
  task: Task;
  onClose: () => void;
  onTaskChanged: () => void;
}) {
  const [catalogue, setCatalogue] = useState<VoiceModels | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [current, setCurrent] = useState<Session | null>(null);
  const [selected, setSelected] = useState('');
  const [voice, setVoice] = useState('');
  const [effort, setEffort] = useState<VoiceReasoningEffort>('low');
  const [cap, setCap] = useState('');
  const [minutes, setMinutes] = useState('5');
  const [consent, setConsent] = useState(false);
  const [shareTaskContext, setShareTaskContext] = useState(false);
  const [discussion, setDiscussion] = useState<{ summary: string; updatedAt: string } | null>(null);
  const [status, setStatus] = useState<
    'idle' | 'starting' | 'connecting' | 'reconnecting' | 'active' | 'stopped'
  >('idle');
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);
  const [transcripts, setTranscripts] = useState<
    Array<{ epoch: number; text: string; final: boolean }>
  >([]);
  const [proposals, setProposals] = useState<VoiceWorkProposal[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [clock, setClock] = useState(Date.now());
  const [historyReady, setHistoryReady] = useState(false);
  const controller = useRef<ReturnType<typeof createVoiceSessionController> | null>(null);
  const mounted = useRef(true);
  const refreshVersion = useRef(0);
  const sessionRevision = useRef(0);
  const controllerVersion = useRef(0);
  const controllerRunning = useRef(false);
  const proposalRevision = useRef(0);
  const selectedSession = useRef<string | null>(null);
  const operation = useRef(false);
  selectedSession.current = current?.id ?? null;
  const option = catalogue?.options.find((item) => item.id === selected);
  const running = ['starting', 'connecting', 'reconnecting', 'active'].includes(status);
  const acceptSession = useCallback(
    (session: Session, select = true) => {
      if (!mounted.current) return;
      if (session.taskId !== task.id || session.workspaceId !== task.workspaceId)
        throw new Error('The voice response belongs to another task.');
      sessionRevision.current++;
      if (select) setCurrent(session);
      setSessions((rows) => [session, ...rows.filter((row) => row.id !== session.id)]);
    },
    [task.id, task.workspaceId]
  );
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    const revision = sessionRevision.current;
    const rows = await get<Session[]>(`/v1/tasks/${task.id}/voice-sessions`);
    const note = await get<{ summary: string; updatedAt: string } | null>(
      `/v1/tasks/${task.id}/voice-discussion`
    );
    if (
      !mounted.current ||
      version !== refreshVersion.current ||
      revision !== sessionRevision.current
    )
      return;
    if (rows.some((row) => row.taskId !== task.id || row.workspaceId !== task.workspaceId))
      throw new Error('The voice history belongs to another task.');
    setSessions(rows);
    setDiscussion(note);
    setHistoryReady(true);
    setCurrent((previous) =>
      previous && (!terminal(previous) || previous.cleanupPending || controllerRunning.current)
        ? (rows.find((row) => row.id === previous.id) ?? previous)
        : (rows.find((row) => !terminal(row) || row.pendingUsd > 0) ?? rows[0] ?? null)
    );
  }, [task.id, task.workspaceId]);
  const selectModel = (model: VoiceModelOption) => {
    setSelected(model.id);
    setVoice(model.defaultVoice);
    setEffort(model.defaultEffort);
    setCap((current) =>
      current.trim() ? current : String(Math.ceil(model.minimumReservationUsd * 100) / 100)
    );
    setConsent(false);
  };
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    void get<VoiceModels>('/v1/voice/models', { signal: abort.signal }).then(
      (result) => {
        if (abort.signal.aborted) return;
        setCatalogue(result);
        const first = result.options.find((model) => model.available);
        if (first) selectModel(first);
      },
      (cause: unknown) => {
        if (!abort.signal.aborted) setError(cause);
      }
    );
    void refresh().catch((cause: unknown) => {
      if (!abort.signal.aborted) setError(cause);
    });
    const leave = () => {
      void controller.current?.stop();
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') leave();
    };
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      mounted.current = false;
      abort.abort();
      leave();
      window.removeEventListener('pagehide', leave);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [refresh]);
  useEffect(() => {
    if (!running && !current?.cleanupPending) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, current?.cleanupPending]);
  useEffect(() => {
    if (!current || (terminal(current) && !current.cleanupPending) || status === 'active') return;
    let disposed = false;
    const timer = setTimeout(
      () =>
        void refresh().catch((cause: unknown) => {
          if (!disposed) setError(cause);
        }),
      2000
    );
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [current, refresh, status]);
  useEffect(() => {
    setProposals((rows) =>
      rows.filter((row) => row.sessionId === current?.id && row.taskId === task.id)
    );
    proposalRevision.current++;
    if (!current?.id) return;
    const abort = new AbortController();
    void get<VoiceWorkProposal[]>(`/v1/voice-sessions/${current.id}/proposals`, {
      signal: abort.signal
    }).then(
      (rows) => {
        if (!abort.signal.aborted)
          setProposals((recent) =>
            [
              ...recent,
              ...rows.filter(
                (proposal) =>
                  proposal.sessionId === current.id &&
                  proposal.taskId === task.id &&
                  !recent.some((row) => row.id === proposal.id)
              )
            ].slice(0, 20)
          );
      },
      (cause: unknown) => {
        if (!abort.signal.aborted) setError(cause);
      }
    );
    return () => abort.abort();
  }, [current?.id, task.id]);
  const start = () => {
    if (!option || running || controllerRunning.current || !historyReady || unresolved) return;
    const amount = Number(cap);
    const seconds = Number(minutes) * 60;
    const privacyRoute = option.privacyRoutes.includes('provider_zdr')
      ? 'provider_zdr'
      : 'external';
    if (
      !option.available ||
      !voice ||
      !option.voices.includes(voice) ||
      !option.supportedEfforts.includes(effort)
    ) {
      setError(new Error('Choose an available voice model and its supported controls.'));
      return;
    }
    if (
      !cap.trim() ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > VOICE_MAX_SPEND_USD ||
      amount < option.minimumReservationUsd
    ) {
      setError(
        new Error(
          `Choose a limit from ${money(option.minimumReservationUsd)} to ${money(VOICE_MAX_SPEND_USD)}. The account and task limits also apply.`
        )
      );
      return;
    }
    if (!Number.isInteger(seconds) || seconds < 30 || seconds > option.maxDurationSeconds) {
      setError(new Error('Choose a session length within this model’s supported range.'));
      return;
    }
    if ((option.requiresExternalConsent || privacyRoute === 'external') && !consent) {
      setError(new Error('Review the provider retention terms before starting voice.'));
      return;
    }
    setError(null);
    setCurrent(null);
    setTranscripts([]);
    setProposals([]);
    setMuted(false);
    controllerRunning.current = true;
    const version = ++controllerVersion.current;
    const relevant = () => mounted.current && version === controllerVersion.current;
    const live = createVoiceSessionController(task.id, {
      onSession: (session) => acceptSession(session, relevant()),
      onStatus: (next) => {
        if (relevant()) {
          controllerRunning.current = next !== 'stopped';
          setStatus(next);
          if (next === 'stopped') void refresh().catch(setError);
        }
      },
      onMuted: (next) => {
        if (relevant()) setMuted(next);
      },
      onLevel: (next) => {
        if (relevant()) setLevel(next);
      },
      onError: (cause) => {
        if (relevant()) setError(cause);
      },
      onTranscript: (epoch, value, final) => {
        if (relevant())
          setTranscripts((rows) =>
            [...rows.filter((row) => row.epoch !== epoch), { epoch, text: value, final }].slice(-8)
          );
      },
      onProposal: (proposal) => {
        if (relevant()) {
          proposalRevision.current++;
          setProposals((rows) =>
            rows.some((row) => row.id === proposal.id && row.status !== 'pending')
              ? rows
              : [proposal, ...rows.filter((row) => row.id !== proposal.id)].slice(0, 20)
          );
        }
      }
    });
    controller.current = live;
    void live.start({
      modelId: option.id,
      voice: voice as VoiceStartRequest['voice'],
      reasoningEffort: effort,
      privacyRoute,
      maxSpendUsd: amount,
      lifetimeSeconds: seconds,
      expectedRouteProof: option.routeProof,
      shareTaskContext
    });
  };
  const unresolved =
    sessions.some((session) => !terminal(session) || session.cleanupPending) ||
    Boolean(current && (!terminal(current) || current.cleanupPending));
  const endSaved = (session: Session) => {
    if (operation.current) return;
    operation.current = true;
    setBusy('stop');
    setError(null);
    void post<Session>(
      `/v1/tasks/${task.id}/voice-sessions/${session.id}/stop`,
      {},
      { retry: 1, keepalive: true }
    )
      .then((next) => acceptSession(next, selectedSession.current === session.id))
      .catch((cause: unknown) => {
        if (mounted.current) setError(cause);
      })
      .finally(() => {
        operation.current = false;
        if (mounted.current) setBusy(null);
      });
  };
  const elapsed = current?.connectedAt
    ? Math.max(
        0,
        Math.floor(
          ((current.endedAt ? Date.parse(current.endedAt) : clock) -
            Date.parse(current.connectedAt)) /
            1000
        )
      )
    : 0;
  const external =
    option?.requiresExternalConsent || !option?.privacyRoutes.includes('provider_zdr');
  return (
    <Dialog
      title="Live voice"
      onClose={() => {
        void controller.current?.stop();
        onClose();
      }}
    >
      <div className="garden-voice-panel stack">
        <p className="garden-voice-task">
          <strong>{task.title}</strong>
          <span className="muted">{statusLabel[task.status]} · voice stays with this work</span>
        </p>
        {!catalogue && !error && <Spinner label="Checking live voice models…" />}
        {!historyReady && Boolean(error) && (
          <Button onClick={() => void refresh().catch(setError)}>Retry session check</Button>
        )}
        {!running && (
          <>
            {catalogue && !catalogue.options.some((model) => model.available) && (
              <p role="status">
                {catalogue.reason ||
                  'No live voice model is available from your configured provider. Add a supported native provider connection in Settings.'}
              </p>
            )}
            {option && (
              <div className="stack">
                <Field label="Voice model">
                  <select
                    value={selected}
                    onChange={(event) => {
                      const next = catalogue?.options.find(
                        (model) => model.id === event.target.value
                      );
                      if (next) selectModel(next);
                    }}
                  >
                    {catalogue?.options.map((model) => (
                      <option key={model.id} value={model.id} disabled={!model.available}>
                        {model.displayName}
                        {model.available ? '' : ' · unavailable'}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="garden-voice-controls">
                  <Field label="Voice">
                    <select value={voice} onChange={(event) => setVoice(event.target.value)}>
                      {option.voices.map((name) => (
                        <option key={name}>{name}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label={`Effort · ${effort}`}>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, option.supportedEfforts.length - 1)}
                      step={1}
                      value={Math.max(0, option.supportedEfforts.indexOf(effort))}
                      disabled={option.supportedEfforts.length < 2}
                      aria-valuetext={effort}
                      onChange={(event) =>
                        setEffort(option.supportedEfforts[Number(event.target.value)]!)
                      }
                    />
                  </Field>
                  <Field label="Session limit (USD)">
                    <input
                      type="number"
                      min={option.minimumReservationUsd}
                      max={VOICE_MAX_SPEND_USD}
                      step="any"
                      value={cap}
                      placeholder="Choose a limit"
                      onChange={(event) => setCap(event.target.value)}
                    />
                  </Field>
                  <Field label="End after (minutes)">
                    <input
                      type="number"
                      min={0.5}
                      max={option.maxDurationSeconds / 60}
                      step={0.5}
                      value={minutes}
                      onChange={(event) => setMinutes(event.target.value)}
                    />
                  </Field>
                </div>
                <p className="muted">
                  Held capacity per response: {money(option.minimumReservationUsd)}. This is the
                  amount that must be available for the full request bound, not the actual charge.
                  Confirmed provider usage replaces the reservation.
                </p>
                <p className="muted">
                  Natural pauses reset the continuous audio bound. Voice ends if a single stretch of
                  microphone audio reaches {option.maxInputSegmentSeconds} seconds.
                </p>
                <details>
                  <summary>Provider pricing</summary>
                  <ul>
                    {option.pricing.map((line, index) => (
                      <li key={index}>
                        {line.billable.replaceAll('_', ' ')}
                        {line.variant ? ` · ${line.variant}` : ''}:{' '}
                        {money(line.unit === 'token' ? line.costUsd * 1000000 : line.costUsd)} per{' '}
                        {line.unit === 'token' ? 'million tokens' : line.unit}
                      </li>
                    ))}
                  </ul>
                </details>
                {external ? (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={consent}
                      onChange={(event) => setConsent(event.target.checked)}
                    />
                    <span>
                      I agree to send live audio under the provider’s retention terms. Zero data
                      retention is not guaranteed.
                    </span>
                  </label>
                ) : (
                  <p className="muted">This route requires provider zero data retention.</p>
                )}
                <label className="check">
                  <input
                    type="checkbox"
                    checked={shareTaskContext}
                    onChange={(event) => setShareTaskContext(event.target.checked)}
                  />
                  <span>
                    Include this conversation and save discussion notes. The selected voice provider
                    can read its opening request, recent messages and saved notes. Other
                    conversations, files and private form inputs stay out.
                  </span>
                </label>
                <Button
                  className="primary"
                  onClick={start}
                  disabled={
                    !historyReady || unresolved || !cap.trim() || (Boolean(external) && !consent)
                  }
                >
                  <Mic size={17} />{' '}
                  {shareTaskContext && discussion ? 'Continue live voice' : 'Start live voice'}
                </Button>
              </div>
            )}
          </>
        )}
        {(running || current) && (
          <section className="garden-voice-active" aria-label="Voice session controls">
            <div className="row between">
              <strong role="status">
                {status === 'starting'
                  ? 'Preparing microphone…'
                  : status === 'connecting'
                    ? 'Connecting voice…'
                    : status === 'reconnecting'
                      ? 'Reconnecting · microphone paused…'
                      : running
                        ? muted
                          ? 'Microphone muted'
                          : 'Microphone active'
                        : (current?.status.replaceAll('_', ' ') ?? 'Stopped')}
              </strong>
              <span>
                {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
              </span>
            </div>
            {running && <meter min={0} max={0.25} value={level} aria-label="Microphone level" />}
            {current && (
              <p className="muted">
                {money(current.settledUsd)} used · {money(current.pendingUsd)} pending ·{' '}
                {money(current.maxSpendUsd)} limit
              </p>
            )}
            {current?.note && <p role="status">{current.note}</p>}
            {!running && current && !terminal(current) && (
              <p className="muted">This saved session is not connected to this tab.</p>
            )}
            <div className="row">
              {status === 'active' && (
                <>
                  <Button onClick={() => controller.current?.setMuted(!muted)}>
                    {muted ? <Mic size={16} /> : <MicOff size={16} />}
                    {muted ? 'Unmute' : 'Mute'}
                  </Button>
                  <Button onClick={() => controller.current?.interrupt()}>
                    <VolumeX size={16} /> Interrupt reply
                  </Button>
                </>
              )}
              {(running || (current && (!terminal(current) || current.cleanupPending))) && (
                <Button
                  busy={busy === 'stop'}
                  onClick={() => {
                    if (controller.current && controllerRunning.current) {
                      void controller.current.stop();
                      return;
                    }
                    if (!current) return;
                    endSaved(current);
                  }}
                >
                  <Square size={15} /> End voice
                </Button>
              )}
            </div>
          </section>
        )}
        {discussion && (
          <details>
            <summary>Saved discussion</summary>
            <p className="muted">
              Model interpretation, not an exact transcript. Included in future voice sessions only
              when context is enabled.
            </p>
            <p
              style={{
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                maxHeight: '16rem',
                overflowY: 'auto'
              }}
            >
              {discussion.summary}
            </p>
            <Button
              disabled={running || unresolved || busy !== null}
              onClick={() => {
                setBusy('clear-discussion');
                void del(`/v1/tasks/${task.id}/voice-discussion`)
                  .then(() => setDiscussion(null))
                  .catch(setError)
                  .finally(() => setBusy(null));
              }}
            >
              Clear saved discussion
            </Button>
          </details>
        )}
        {sessions
          .filter(
            (session) =>
              session.id !== current?.id && (!terminal(session) || session.cleanupPending)
          )
          .map((session) => (
            <section
              key={session.id}
              className="garden-voice-active"
              aria-label="Saved voice session"
            >
              <p>
                Saved voice session · {session.status.replaceAll('_', ' ')} ·{' '}
                {money(session.pendingUsd)} pending
              </p>
              {session.note && <p className="muted">{session.note}</p>}
              <Button
                busy={busy === 'stop'}
                disabled={busy !== null}
                onClick={() => endSaved(session)}
              >
                End saved voice
              </Button>
            </section>
          ))}
        <p className="muted">
          Voice started here ends when you close this panel or leave this tab. Use End voice to
          close a saved session. Spoken work proposals need your confirmation below; approvals
          remain in the task.
        </p>
        {transcripts.length > 0 && (
          <div className="garden-voice-transcript" aria-label="Voice replies">
            {transcripts.map((reply) => (
              <p key={reply.epoch}>{reply.text}</p>
            ))}
          </div>
        )}
        {proposals
          .filter((proposal) => proposal.sessionId === current?.id && proposal.taskId === task.id)
          .map((proposal) => (
            <article key={proposal.id} className="garden-voice-proposal">
              <span className="eyebrow">Suggested direction · {proposal.status}</span>
              <p>{proposal.prompt}</p>
              <small className="muted">
                {proposal.modelId} ·{' '}
                {proposal.privacyRoute === 'provider_zdr'
                  ? 'Zero data retention'
                  : 'Provider retention'}{' '}
                ·{' '}
                {proposal.maxSpendUsd === null
                  ? 'Existing account limits'
                  : `${money(proposal.maxSpendUsd)} task limit`}
              </small>
              {proposal.status === 'pending' && (
                <div className="row">
                  {(['confirm', 'reject'] as const).map((action) => (
                    <Button
                      key={action}
                      className={action === 'confirm' ? 'primary' : ''}
                      busy={busy === proposal.id}
                      disabled={busy !== null}
                      onClick={() => {
                        if (operation.current || selectedSession.current !== proposal.sessionId)
                          return;
                        operation.current = true;
                        const revision = ++proposalRevision.current;
                        setBusy(proposal.id);
                        setError(null);
                        void post(
                          `/v1/voice-sessions/${proposal.sessionId}/proposals/${proposal.id}/${action}`,
                          { digest: proposal.digest }
                        )
                          .then(async () => {
                            if (mounted.current && selectedSession.current === proposal.sessionId) {
                              setProposals((rows) =>
                                rows.map((row) =>
                                  row.id === proposal.id
                                    ? {
                                        ...row,
                                        status: action === 'confirm' ? 'confirmed' : 'rejected'
                                      }
                                    : row
                                )
                              );
                              if (action === 'confirm') onTaskChanged();
                            }
                            const updated = await get<VoiceWorkProposal[]>(
                              `/v1/voice-sessions/${proposal.sessionId}/proposals`
                            );
                            if (
                              mounted.current &&
                              selectedSession.current === proposal.sessionId &&
                              revision === proposalRevision.current
                            ) {
                              setProposals((recent) => {
                                const scoped = updated.filter(
                                  (row) =>
                                    row.sessionId === proposal.sessionId && row.taskId === task.id
                                );
                                return [
                                  ...recent.map((row) =>
                                    row.status !== 'pending'
                                      ? row
                                      : (scoped.find((next) => next.id === row.id) ?? row)
                                  ),
                                  ...scoped.filter(
                                    (row) => !recent.some((next) => next.id === row.id)
                                  )
                                ].slice(0, 20);
                              });
                            }
                          })
                          .catch(setError)
                          .finally(() => {
                            operation.current = false;
                            if (mounted.current) setBusy(null);
                          });
                      }}
                    >
                      {action === 'confirm' ? 'Send this direction' : 'Dismiss'}
                    </Button>
                  ))}
                </div>
              )}
            </article>
          ))}
        {sessions
          .filter((session) => terminal(session) && session.pendingUsd > 0)
          .map((session) => (
            <AudioReceipts
              key={`${session.id}:${session.pendingUsd}`}
              sessionId={session.id}
              onSettled={() => void refresh().catch(setError)}
            />
          ))}
        <ErrorNotice error={error} />
      </div>
    </Dialog>
  );
}

export default function VoiceSession(props: {
  task: Task;
  onClose: () => void;
  onTaskChanged: () => void;
}) {
  return <VoiceSessionPanel key={props.task.id} {...props} />;
}
