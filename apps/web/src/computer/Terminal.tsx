import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { get } from '../client.js';
import { message } from './format.js';
import { socketAddress } from './transport.js';

const expiry = (token: string): number => {
  try {
    const payload: unknown = JSON.parse(
      atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))
    );
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'exp' in payload &&
      typeof payload.exp === 'number' &&
      Number.isFinite(payload.exp)
    )
      return payload.exp * 1000;
    return Date.now() + 60_000;
  } catch {
    return Date.now() + 60_000;
  }
};

export default function Terminal({
  workspaceId,
  visible
}: {
  workspaceId: string;
  visible: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const fit = useRef<FitAddon | null>(null);
  const terminal = useRef<XTerm | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState('Connecting…');
  const [error, setError] = useState('');
  const [connection, setConnection] = useState(0);
  useEffect(() => {
    if (!element.current) return;
    let active = true;
    let renewal: ReturnType<typeof setTimeout> | undefined;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, monospace',
      scrollback: 5000,
      theme: {
        background: '#101613',
        foreground: '#e6e8df',
        cursor: '#e6e8df',
        selectionBackground: '#3b4942'
      }
    });
    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(element.current);
    addon.fit();
    terminal.current = term;
    fit.current = addon;
    const resize = () => {
      if (element.current?.getBoundingClientRect().width) {
        addon.fit();
        if (socket.current?.readyState === WebSocket.OPEN)
          socket.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element.current);
    const input = term.onData((data) => {
      if (socket.current?.readyState === WebSocket.OPEN)
        socket.current.send(JSON.stringify({ type: 'input', data }));
    });
    const token = () =>
      get<{ token: string; runnerUrl: string }>(`/v1/workspaces/${workspaceId}/terminal-token`, {
        retry: 0
      });
    const schedule = (exp: number) => {
      clearTimeout(renewal);
      renewal = setTimeout(
        () => {
          void token()
            .then((value) => {
              if (active && socket.current?.readyState === WebSocket.OPEN)
                socket.current.send(JSON.stringify({ type: 'renew', token: value.token }));
            })
            .catch((e) => {
              if (active) setError(`Session renewal failed: ${message(e)}`);
            });
        },
        Math.max(1000, exp - Date.now() - 60_000)
      );
    };
    setError('');
    setStatus('Connecting…');
    void token()
      .then((value) => {
        if (!active) return;
        const ws = new WebSocket(
          socketAddress(value.runnerUrl, `/v1/workspaces/${workspaceId}/terminal`),
          ['garden-capability', value.token]
        );
        socket.current = ws;
        ws.onopen = () => {
          if (!active) return;
          setStatus('Connected');
          resize();
          term.focus();
          schedule(expiry(value.token));
        };
        ws.onmessage = (e) => {
          if (!active) return;
          try {
            const frame = JSON.parse(String(e.data)) as {
              type: string;
              data?: string;
              exitCode?: number;
              exp?: number;
            };
            if (frame.type === 'data' && frame.data) term.write(frame.data);
            if (frame.type === 'exit') setStatus(`Shell exited (${frame.exitCode ?? 'unknown'})`);
            if (frame.type === 'renewed' && frame.exp) schedule(frame.exp * 1000);
          } catch {
            setError('The terminal sent an unreadable response.');
          }
        };
        ws.onerror = () => {
          if (active) setError('The terminal connection could not be established.');
        };
        ws.onclose = () => {
          clearTimeout(renewal);
          if (active) setStatus('Disconnected');
        };
      })
      .catch((e) => {
        if (active) {
          setStatus('Disconnected');
          setError(message(e));
        }
      });
    return () => {
      active = false;
      clearTimeout(renewal);
      observer.disconnect();
      input.dispose();
      socket.current?.close();
      socket.current = null;
      term.dispose();
      terminal.current = null;
      fit.current = null;
    };
  }, [workspaceId, connection]);
  useEffect(() => {
    if (visible) {
      const timer = requestAnimationFrame(() => {
        fit.current?.fit();
        const term = terminal.current;
        if (term && socket.current?.readyState === WebSocket.OPEN)
          socket.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      });
      return () => cancelAnimationFrame(timer);
    }
    return undefined;
  }, [visible]);
  return (
    <div className="stack">
      <div className="row">
        <span role="status" className="muted">
          {status}
        </span>
        <button
          className="button"
          disabled={status === 'Connected' || status === 'Connecting…'}
          onClick={() => setConnection((value) => value + 1)}
        >
          Open new shell
        </button>
        {status === 'Connected' && (
          <button className="button" onClick={() => socket.current?.close()}>
            Close shell
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div ref={element} className="computer-terminal" aria-label="Interactive terminal" />
    </div>
  );
}
