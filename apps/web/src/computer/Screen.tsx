import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopHolder, BrowserTabState, BrowserTabCleanup } from '@athanor/contracts';
import { Maximize2, Minimize2, Pin, X } from 'lucide-react';
import { remotePoint } from './screen-geometry';
import { useExpandedView } from '../use-expanded-view';
import { stepUp } from '../auth';
import { get, post, ApiError } from '../client.js';
import { jpegPayload, PAGE_VIEWPORT, socketAddress } from './transport.js';
import { message } from './format.js';

interface ScreenState {
  holder: DesktopHolder;
  width: number;
  height: number;
  generation?: number;
  title?: string;
  url?: string;
  activeApplication?: string;
  pendingDialog?: { type: string; message: string } | null;
  botWall?: { vendor?: string; reason?: string; url?: string; tabId?: string | null } | null;
  tabs?: BrowserTabState[];
  cleanup?: BrowserTabCleanup;
}
interface Snapshot {
  screenshotBase64?: string;
  holder: DesktopHolder;
  available?: boolean;
  message?: string;
  width?: number;
  height?: number;
  displayWidth?: number;
  displayHeight?: number;
  text?: string;
  tabs?: { tabId: string; title: string; active: boolean }[];
}
interface Ack {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export default function Screen({
  workspaceId,
  surface,
  taskId
}: {
  workspaceId: string;
  surface: 'browser' | 'desktop';
  taskId?: string;
}) {
  const [handoff, setHandoff] = useState<{
    id: string;
    kind: string;
    surface: string;
    title: string;
    tabId?: string;
    url?: string;
    route: 'answer' | 'approval';
  } | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [inputBusy, setInputBusy] = useState(false);
  const [strokePreview, setStrokePreview] = useState<Array<{ x: number; y: number }>>([]);
  const stroke = useRef<{
    pointerId: number;
    points: Array<{ x: number; y: number }>;
    generation?: number;
    tabId?: string;
  } | null>(null);
  useEffect(() => {
    if (!taskId) return;
    const abort = new AbortController();
    const refresh = async () => {
      try {
        const value = await get<typeof handoff>(`/v1/tasks/${taskId}/intervention`, {
          signal: abort.signal
        });
        if (!abort.signal.aborted) setHandoff(value?.surface === surface ? value : null);
      } catch (cause) {
        if (!abort.signal.aborted) setError(message(cause));
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [taskId, surface]);
  const [state, setState] = useState<ScreenState>({ holder: 'agent', ...PAGE_VIEWPORT });
  const stateRef = useRef(state);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('Connecting…');
  const [error, setError] = useState('');
  const [address, setAddress] = useState('');
  const [text, setText] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [launch, setLaunch] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const { ref: viewer, expanded, toggle: toggleExpanded } = useExpandedView<HTMLDivElement>();
  const socket = useRef<WebSocket | null>(null);
  const pending = useRef(new Map<string, Ack>());
  const base = `/v1/workspaces/${workspaceId}/${surface}`;
  const clear = useCallback(() => {
    const c = canvas.current;
    if (c) c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
  }, []);
  const control = useCallback(
    (frame: Record<string, unknown>) =>
      new Promise<void>((resolve, reject) => {
        if (socket.current?.readyState !== WebSocket.OPEN) {
          reject(
            new Error('The screen is disconnected. Wait for reconnection before sending input.')
          );
          return;
        }
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => {
          pending.current.delete(requestId);
          reject(new Error('Input was not acknowledged. Check the screen before trying it again.'));
        }, 15_000);
        pending.current.set(requestId, { resolve, reject, timer });
        setInputBusy(true);
        socket.current.send(JSON.stringify({ ...frame, requestId }));
      }).finally(() => setInputBusy(pending.current.size > 0)),
    []
  );
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    }
  };
  const action = (value: Record<string, unknown>) => control({ type: 'action', action: value });
  const inspect = async () => {
    const next = await post<Snapshot>(`${base}/snapshot`);
    setSnapshot(
      next.holder === 'secure_input' || stateRef.current.holder === 'secure_input' ? null : next
    );
    if (next.available === false)
      throw new Error(next.message ?? 'This computer does not have a desktop available.');
  };
  useEffect(() => {
    let active = true;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let backoff = 1000;
    let decoder: VideoDecoder | null = null;
    let generation = 0;
    let paint = 0;
    let privacyEpoch = 0;
    let jpegQueue = Promise.resolve();
    const closeDecoder = () => {
      if (decoder && decoder.state !== 'closed') decoder.close();
      decoder = null;
    };
    const update = (next: ScreenState) => {
      backoff = 1000;
      setConnected(true);
      setStatus('Live');
      setError('');
      if (next.generation !== undefined && next.generation !== generation) {
        generation = next.generation;
        closeDecoder();
        clear();
      }
      const previousHolder = stateRef.current.holder;
      stateRef.current = next;
      setState(next);
      if (next.holder === 'secure_input') {
        paint += 1;
        privacyEpoch += 1;
        clear();
        setSnapshot(null);
        if (previousHolder !== 'secure_input') setText('');
      }
      if (next.url) setAddress(next.url);
    };
    const drawJpeg = async (data: Uint8Array, x = 0, y = 0, width?: number, height?: number) => {
      const version = ++paint;
      const image = await createImageBitmap(
        new Blob([new Uint8Array(data)], { type: 'image/jpeg' })
      );
      if (active && version === paint && stateRef.current.holder !== 'secure_input') {
        const c = canvas.current;
        if (c) {
          const s = stateRef.current;
          if (c.width !== s.width || c.height !== s.height) {
            c.width = s.width;
            c.height = s.height;
          }
          c.getContext('2d')?.drawImage(image, x, y, width ?? c.width, height ?? c.height);
        }
      }
      image.close();
    };
    const connect = async () => {
      try {
        const value = await get<{ runnerUrl: string; token: string }>(
          `/v1/workspaces/${workspaceId}/${surface}-token`,
          { retry: 0 }
        );
        if (!active) return;
        const ws = new WebSocket(socketAddress(value.runnerUrl, `${base}/stream`), [
          'athanor-capability',
          value.token
        ]);
        socket.current = ws;
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
          if (!active) return;
          setStatus('Opening screen…');
          if (surface === 'desktop') {
            ws.send(
              JSON.stringify({ type: 'hello', canDecodeVideo: typeof VideoDecoder !== 'undefined' })
            );
            resize();
          }
        };
        ws.onmessage = (e) => {
          if (!active) return;
          try {
            if (typeof e.data === 'string') {
              const frame = JSON.parse(e.data) as {
                type: string;
                state?: ScreenState;
                requestId?: string;
                message?: string;
              };
              if (frame.type === 'state' && frame.state) update(frame.state);
              if (frame.requestId) {
                const item = pending.current.get(frame.requestId);
                if (item) {
                  clearTimeout(item.timer);
                  pending.current.delete(frame.requestId);
                  if (frame.type === 'control_error')
                    item.reject(new Error(frame.message ?? 'Input was refused.'));
                  else item.resolve();
                }
              }
              if (frame.type === 'control_error' && !frame.requestId)
                setError(frame.message ?? 'Screen control failed.');
              return;
            }
            const buffer = e.data as ArrayBuffer;
            if (surface === 'browser') {
              if (stateRef.current.holder !== 'secure_input')
                void drawJpeg(new Uint8Array(buffer)).catch((err) => {
                  if (active) setError(message(err));
                });
              return;
            }
            if (buffer.byteLength === 0) return;
            const view = new DataView(buffer);
            const kind = view.getUint8(0);
            if (kind === 0x02) {
              const config = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 1))) as {
                codec: string;
                format: string;
                generation: number;
                width: number;
                height: number;
              };
              if (config.generation !== generation) return;
              closeDecoder();
              if (config.format === 'annexb' && typeof VideoDecoder !== 'undefined') {
                decoder = new VideoDecoder({
                  output(frame) {
                    const c = canvas.current;
                    if (
                      active &&
                      generation === config.generation &&
                      stateRef.current.holder !== 'secure_input' &&
                      c
                    ) {
                      if (c.width !== config.width || c.height !== config.height) {
                        c.width = config.width;
                        c.height = config.height;
                      }
                      c.getContext('2d')?.drawImage(frame, 0, 0);
                    }
                    frame.close();
                  },
                  error(err) {
                    if (active) {
                      setError(message(err));
                      ws.send(JSON.stringify({ type: 'hello', canDecodeVideo: false }));
                    }
                  }
                });
                try {
                  decoder.configure({ codec: config.codec, optimizeForLatency: true });
                } catch {
                  closeDecoder();
                  ws.send(JSON.stringify({ type: 'hello', canDecodeVideo: false }));
                }
              }
            } else if (
              kind === 0x10 &&
              buffer.byteLength > 18 &&
              view.getUint32(14) === generation &&
              decoder?.state === 'configured'
            ) {
              decoder.decode(
                new EncodedVideoChunk({
                  type: view.getUint8(13) & 1 ? 'key' : 'delta',
                  timestamp: Number(view.getBigUint64(5)),
                  data: new Uint8Array(buffer, 18)
                })
              );
            } else if (kind === 0x11) {
              const frame = jpegPayload(buffer, generation);
              const frameGeneration = generation;
              const framePrivacyEpoch = privacyEpoch;
              if (frame && stateRef.current.holder !== 'secure_input') {
                // Region updates must paint in order; discarding an older region leaves stale pixels.
                jpegQueue = jpegQueue
                  .then(async () => {
                    if (
                      active &&
                      generation === frameGeneration &&
                      privacyEpoch === framePrivacyEpoch
                    )
                      await drawJpeg(frame.data, frame.x, frame.y, frame.width, frame.height);
                  })
                  .catch((err) => {
                    if (active) setError(message(err));
                  });
              }
            }
          } catch (e) {
            setError(message(e));
          }
        };
        ws.onerror = () => {
          if (active) setStatus('Connection interrupted');
        };
        ws.onclose = (event) => {
          closeDecoder();
          if (!active) return;
          setConnected(false);
          setStatus('Reconnecting…');
          if (event.code !== 1000 && event.code !== 1008)
            setError(event.reason || 'The screen connection closed before it was ready.');
          for (const item of pending.current.values()) {
            clearTimeout(item.timer);
            item.reject(new Error('The connection closed before input was acknowledged.'));
          }
          pending.current.clear();
          reconnect = setTimeout(() => {
            void connect();
          }, backoff);
          backoff = Math.min(30_000, backoff * 2);
        };
      } catch (e) {
        if (active) {
          setError(message(e));
          setStatus('Reconnecting…');
          reconnect = setTimeout(() => {
            void connect();
          }, backoff);
          backoff = Math.min(30_000, backoff * 2);
        }
      }
    };
    const resize = () => {
      if (surface !== 'desktop' || socket.current?.readyState !== WebSocket.OPEN) return;
      const width = Math.max(
        640,
        Math.min(1440, Math.round(canvas.current?.getBoundingClientRect().width ?? 1280))
      );
      socket.current.send(
        JSON.stringify({
          type: 'viewport',
          viewport: {
            cssWidth: width,
            cssHeight: Math.round(width * 0.625),
            devicePixelRatio: 1,
            mode: 'css'
          }
        })
      );
    };
    const observer = new ResizeObserver(resize);
    if (canvas.current) observer.observe(canvas.current);
    void connect();
    return () => {
      active = false;
      paint += 1;
      observer.disconnect();
      clearTimeout(reconnect);
      socket.current?.close();
      socket.current = null;
      closeDecoder();
      for (const item of pending.current.values()) {
        clearTimeout(item.timer);
        item.reject(new Error('Screen closed.'));
      }
      pending.current.clear();
      clear();
    };
  }, [base, clear, surface, workspaceId]);
  useEffect(() => {
    if (!connected || !taskId || surface !== 'browser') return;
    let tabId: string | null = null;
    try {
      tabId = sessionStorage.getItem(`garden:open-tab:${taskId}`);
      sessionStorage.removeItem(`garden:open-tab:${taskId}`);
    } catch {
      return;
    }
    if (tabId)
      void control({ type: 'holder', holder: 'user' })
        .then(() => control({ type: 'action', action: { type: 'select_tab', tabId } }))
        .catch((cause) => setError(message(cause)));
  }, [connected, control, taskId, surface]);
  const handoffTab =
    state.tabs?.find((tab) => tab.tabId === handoff?.tabId && /^https?:\/\//.test(tab.url)) ??
    state.tabs?.find(
      (tab) =>
        tab.active &&
        handoff?.kind === 'challenge' &&
        handoff.url &&
        /^https?:\/\//.test(tab.url) &&
        new URL(tab.url).origin === new URL(handoff.url).origin
    );
  async function beginHandoff() {
    await control({ type: 'holder', holder: 'user' });
    const tabId = handoff?.tabId ?? state.botWall?.tabId;
    if (surface === 'browser' && tabId) {
      if (handoff?.kind === 'challenge' && handoff.url && !handoffTab) {
        await action({ type: 'new_tab', url: handoff.url, activate: true });
      } else await action({ type: 'select_tab', tabId: handoffTab?.tabId ?? tabId });
    }
  }
  async function completeHandoff() {
    if (!handoff || !taskId) return;
    if (pending.current.size || stroke.current)
      throw new Error('Wait for your input to finish before continuing.');
    setHandoffBusy(true);
    try {
      const send = () =>
        handoff.route === 'answer'
          ? post(`/v1/tasks/${taskId}/answer`, {
              questionId: handoff.id,
              ...(state.tabs?.find((tab) => tab.active)?.tabId
                ? { tabId: state.tabs.find((tab) => tab.active)!.tabId }
                : {}),
              prompt: 'I completed the browser verification. Observe the page and continue.'
            })
          : post(`/v1/approvals/${handoff.id}/approve`, {});
      try {
        await send();
      } catch (cause) {
        if (
          !(cause instanceof ApiError) ||
          !['step_up_required', 'recent_authentication_required'].includes(cause.code)
        )
          throw cause;
        await stepUp();
        await send();
      }
      setHandoff(null);
      setStatus('Handoff complete — the conversation is continuing');
    } finally {
      setHandoffBusy(false);
    }
  }
  const controlling = connected && state.holder !== 'agent';
  return (
    <div className={`stack garden-screen-surface ${expanded ? 'expanded' : ''}`} ref={viewer}>
      {handoff && (
        <section className="computer-handoff" aria-label="Your action is needed">
          <span className="eyebrow">Needs you · this conversation</span>
          <h2>{handoff.title}</h2>
          <p>
            {handoff.kind === 'private_input'
              ? 'Take control, click the field, then enable Private input before typing. End private input when finished.'
              : handoff.kind === 'signature'
                ? 'Review the document and sign it yourself. You can draw directly on the screen with a mouse, touch, or pen.'
                : 'Complete the site’s verification in this browser. Garden will check the page again before continuing.'}
          </p>
          <div className="row">
            <button
              className="button"
              disabled={!connected || handoffBusy}
              onClick={() => void run(beginHandoff)}
            >
              {handoff.kind === 'challenge' && handoff.url && !handoffTab ? (
                'Reopen verification page'
              ) : (
                <>Take control{handoff.tabId ? ' of this tab' : ''}</>
              )}
            </button>
            <button
              className="button primary"
              disabled={
                !connected ||
                state.holder !== 'user' ||
                handoffBusy ||
                inputBusy ||
                strokePreview.length > 0
              }
              onClick={() => void run(completeHandoff)}
            >
              {handoffBusy ? 'Continuing…' : 'Done and continue'}
            </button>
          </div>
          <small>Your action will not be repeated by the agent.</small>
        </section>
      )}
      <div className="row">
        <strong>
          {state.title ||
            state.activeApplication ||
            (surface === 'browser' ? 'Browser' : 'Desktop')}
        </strong>
        <span className="muted" role="status">
          {status} ·{' '}
          {state.holder === 'agent'
            ? 'Agent has control'
            : state.holder === 'secure_input'
              ? 'Private input'
              : 'You have control'}
        </span>
        <button
          className="button"
          disabled={!connected || Boolean(handoff)}
          onClick={() =>
            void run(() =>
              control({ type: 'holder', holder: state.holder === 'agent' ? 'user' : 'agent' })
            )
          }
        >
          {state.holder === 'agent' ? 'Take control' : 'Return to agent'}
        </button>
        <button
          className="button"
          disabled={!controlling}
          onClick={() =>
            void run(() =>
              control({
                type: 'holder',
                holder: state.holder === 'secure_input' ? 'user' : 'secure_input'
              })
            )
          }
        >
          {state.holder === 'secure_input' ? 'End private input' : 'Private input'}
        </button>
        <button
          className="button"
          disabled={state.holder === 'secure_input'}
          onClick={() => void run(inspect)}
        >
          {surface === 'browser' ? 'Inspect page' : 'Inspect desktop'}
        </button>
        <button className="button" onClick={() => void run(toggleExpanded)}>
          {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          {expanded ? 'Exit full screen' : 'Full screen'}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {surface === 'browser' && state.holder !== 'secure_input' && (
        <div className="garden-browser-tabstrip" aria-label="Browser tabs">
          {(state.tabs ?? []).map((tab) => (
            <div className={`garden-browser-tab ${tab.active ? 'active' : ''}`} key={tab.tabId}>
              <button
                disabled={!controlling}
                aria-pressed={tab.active}
                title={tab.url}
                onClick={() => void run(() => action({ type: 'select_tab', tabId: tab.tabId }))}
              >
                {tab.title || tab.url || 'Untitled tab'}
              </button>
              <button
                className={tab.pinned ? 'pinned' : ''}
                aria-label={`${tab.pinned ? 'Unpin' : 'Keep'} ${tab.title || 'tab'}`}
                aria-pressed={tab.pinned}
                title={
                  tab.pinned
                    ? 'Kept open'
                    : tab.protectedReason === 'owner'
                      ? 'Your tabs stay open'
                      : 'Keep this tab open'
                }
                onClick={() =>
                  void run(async () => {
                    const result = await post<{ tabs: BrowserTabState[] }>(
                      `${base}/tabs/${encodeURIComponent(tab.tabId)}/retention`,
                      { pinned: !tab.pinned }
                    );
                    setState((current) => ({ ...current, tabs: result.tabs }));
                  })
                }
              >
                <Pin size={12} />
              </button>
              <button
                aria-label={`Close ${tab.title || 'tab'}`}
                disabled={!controlling}
                onClick={() => void run(() => action({ type: 'close_tab', tabId: tab.tabId }))}
              >
                <X size={13} />
              </button>
            </div>
          ))}
          {state.cleanup && state.cleanup.closed > 0 && (
            <span
              className="garden-tab-cleanup"
              title="Eligible idle agent tabs close automatically. Your tabs and kept tabs stay open."
            >
              {state.cleanup.closed} idle tabs cleared
            </span>
          )}
        </div>
      )}
      {surface === 'browser' && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              action({
                type: 'navigate',
                url: /^[a-z][a-z\d+.-]*:/i.test(address) ? address : `https://${address}`
              })
            );
          }}
        >
          <button
            className="button"
            type="button"
            aria-label="Go back in the browser"
            disabled={!controlling}
            onClick={() => void run(() => action({ type: 'back' }))}
          >
            ←
          </button>
          <input
            className="field computer-address"
            aria-label="Browser address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            disabled={!controlling}
          />
          <button className="button" disabled={!controlling}>
            Go
          </button>
          <button
            type="button"
            className="button"
            disabled={!controlling}
            onClick={() => void run(() => action({ type: 'new_tab', activate: true }))}
          >
            New tab
          </button>
        </form>
      )}
      {state.botWall && (
        <p role="status">
          {state.botWall.vendor && state.botWall.vendor !== 'Unnamed bot wall'
            ? state.botWall.vendor
            : 'This site'}{' '}
          needs human verification. {state.botWall.url}
          {!handoff && (
            <button className="button" disabled={!connected} onClick={() => void run(beginHandoff)}>
              Open verification tab
            </button>
          )}
        </p>
      )}
      {state.pendingDialog && (
        <div className="computer-confirm">
          <p>{state.pendingDialog.message}</p>
          <button
            className="button"
            disabled={!controlling}
            onClick={() => void run(() => action({ type: 'dialog', response: 'dismiss' }))}
          >
            Dismiss
          </button>
          <button
            className="button"
            disabled={!controlling}
            onClick={() => void run(() => action({ type: 'dialog', response: 'accept' }))}
          >
            Accept
          </button>
        </div>
      )}
      <div className={`computer-screen ${state.holder === 'secure_input' ? 'private' : ''}`}>
        <canvas
          ref={canvas}
          width={PAGE_VIEWPORT.width}
          height={PAGE_VIEWPORT.height}
          tabIndex={controlling ? 0 : -1}
          aria-label={`Remote ${surface}. Take control, then click and type. Use the text input below on a phone.`}
          onPointerDown={(e) => {
            if (!controlling || state.holder === 'secure_input' || e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.focus();
            e.currentTarget.setPointerCapture(e.pointerId);
            stroke.current = {
              pointerId: e.pointerId,
              points: [
                remotePoint(
                  { x: e.clientX, y: e.clientY },
                  e.currentTarget.getBoundingClientRect(),
                  state
                )
              ],
              ...(state.generation !== undefined ? { generation: state.generation } : {}),
              ...(state.tabs?.find((tab) => tab.active)?.tabId
                ? { tabId: state.tabs.find((tab) => tab.active)!.tabId }
                : {})
            };
          }}
          onPointerMove={(e) => {
            const gesture = stroke.current;
            if (!gesture || gesture.pointerId !== e.pointerId) return;
            const point = remotePoint(
              { x: e.clientX, y: e.clientY },
              e.currentTarget.getBoundingClientRect(),
              state
            );
            const last = gesture.points.at(-1)!;
            if (Math.hypot(point.x - last.x, point.y - last.y) < 2) return;
            if (gesture.points.length >= 2047)
              gesture.points = gesture.points.filter((_, index) => index % 2 === 0);
            gesture.points.push(point);
            setStrokePreview([...gesture.points]);
          }}
          onPointerCancel={() => {
            stroke.current = null;
            setStrokePreview([]);
          }}
          onLostPointerCapture={() => {
            stroke.current = null;
            setStrokePreview([]);
          }}
          onPointerUp={(e) => {
            const gesture = stroke.current;
            stroke.current = null;
            setStrokePreview([]);
            if (
              !gesture ||
              gesture.pointerId !== e.pointerId ||
              !controlling ||
              state.holder === 'secure_input'
            )
              return;
            const end = remotePoint(
              { x: e.clientX, y: e.clientY },
              e.currentTarget.getBoundingClientRect(),
              state
            );
            if (
              gesture.points.length === 1 &&
              Math.hypot(end.x - gesture.points[0]!.x, end.y - gesture.points[0]!.y) < 3
            ) {
              void run(() =>
                action({
                  type: 'click_at',
                  ...end,
                  ...(surface === 'desktop' ? { button: 'left', clicks: 1 } : {})
                })
              );
            } else {
              gesture.points.push(end);
              const { pointerId: _pointer, ...input } = gesture;
              void run(() => control({ type: 'stroke', action: input }));
            }
          }}
          onKeyDown={(e) => {
            if (!controlling || ['Shift', 'Alt', 'Control', 'Meta'].includes(e.key)) return;
            e.preventDefault();
            const key = [
              e.ctrlKey ? 'Control' : '',
              e.altKey ? 'Alt' : '',
              e.metaKey ? 'Meta' : '',
              e.shiftKey && e.key.length > 1 ? 'Shift' : '',
              e.key === ' '
                ? 'Space'
                : e.key === 'Enter' && surface === 'desktop'
                  ? 'Return'
                  : e.key
            ]
              .filter(Boolean)
              .join('+');
            void run(() => action({ type: 'press', key }));
          }}
          onWheel={(e) => {
            if (!controlling) return;
            void run(() =>
              action(
                surface === 'browser'
                  ? {
                      type: 'scroll',
                      deltaX: Math.max(-5000, Math.min(5000, Math.round(e.deltaX))),
                      deltaY: Math.max(-5000, Math.min(5000, Math.round(e.deltaY)))
                    }
                  : { type: 'scroll', direction: e.deltaY < 0 ? 'up' : 'down', amount: 3 }
              )
            );
          }}
        />
        {strokePreview.length > 1 && (
          <svg
            className="computer-stroke-preview"
            viewBox={`0 0 ${state.width} ${state.height}`}
            aria-hidden="true"
          >
            <polyline points={strokePreview.map((point) => `${point.x},${point.y}`).join(' ')} />
          </svg>
        )}
        {!connected && snapshot?.screenshotBase64 && state.holder !== 'secure_input' && (
          <img
            className="computer-snapshot"
            src={`data:image/jpeg;base64,${snapshot.screenshotBase64}`}
            alt={`Captured ${surface}; reconnect for live control`}
          />
        )}
        {state.holder === 'secure_input' && (
          <div className="computer-blackout">
            <strong>Private input</strong>
            <p>The screen is hidden. Send sensitive text below, then end private input.</p>
          </div>
        )}
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const value = text;
          void run(async () => {
            if (state.holder === 'secure_input') setText('');
            await action({ type: 'text_input', text: value });
            setText((current) => (current === value ? '' : current));
          });
        }}
      >
        <input
          className="field computer-address"
          type={state.holder === 'secure_input' ? 'password' : 'text'}
          autoComplete="off"
          aria-label="Text to send to focused field"
          placeholder="Type into the focused field…"
          value={text}
          disabled={!controlling}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="button" disabled={!controlling || !text}>
          Send text
        </button>
        <button
          type="button"
          className="button"
          disabled={!controlling}
          onClick={() =>
            void run(() =>
              action({ type: 'press', key: surface === 'desktop' ? 'Return' : 'Enter' })
            )
          }
        >
          Enter
        </button>
        <button
          type="button"
          className="button"
          disabled={!controlling}
          onClick={() => void run(() => action({ type: 'press', key: 'Tab' }))}
        >
          Tab
        </button>
        {(['up', 'down'] as const).map((direction) => (
          <button
            key={direction}
            type="button"
            className="button"
            disabled={!controlling || state.holder === 'secure_input'}
            onClick={() =>
              void run(() =>
                action(
                  surface === 'browser'
                    ? { type: 'scroll', deltaX: 0, deltaY: direction === 'up' ? -500 : 500 }
                    : { type: 'scroll', direction, amount: 5 }
                )
              )
            }
          >
            Scroll {direction}
          </button>
        ))}
      </form>
      {snapshot && (
        <details open>
          <summary>Page information</summary>
          {snapshot.tabs && (
            <div className="row">
              {snapshot.tabs.map((tab) => (
                <span className="row" key={tab.tabId}>
                  <button
                    className="button"
                    disabled={!controlling}
                    aria-pressed={tab.active}
                    onClick={() => void run(() => action({ type: 'select_tab', tabId: tab.tabId }))}
                  >
                    {tab.title || 'Untitled tab'}
                  </button>
                  <button
                    className="button"
                    disabled={!controlling}
                    aria-label={`Close ${tab.title || 'tab'}`}
                    onClick={() => void run(() => action({ type: 'close_tab', tabId: tab.tabId }))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <pre className="computer-log">
            {snapshot.text || snapshot.message || 'The current screen is available above.'}
          </pre>
        </details>
      )}
      {surface === 'desktop' && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              post(`${base}/launch`, { executable: launch, args: [], cwd: 'workspace', env: {} })
            );
          }}
        >
          <input
            className="field computer-address"
            aria-label="Application executable"
            placeholder="Application executable, e.g. chromium"
            value={launch}
            onChange={(e) => setLaunch(e.target.value)}
          />
          <button className="button" disabled={state.holder !== 'agent' || !launch}>
            Open application
          </button>
        </form>
      )}
    </div>
  );
}
