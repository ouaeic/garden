import { useEffect, useMemo, useRef, useState } from 'react';
import type { Artifact, ResultNote } from '@garden/contracts';
import { responseError } from './client.js';
import { message } from './computer/format.js';
import { Maximize2, X } from './icons';
import { useExpandedView } from './use-expanded-view';
import { CommentButton, FrameComments } from './result-notes';
import bridgeSource from './marks-bridge.js?raw';
import { Button } from './ui';
import './result-view.css';

/*
 * Scripts run, the network does not. The frame has an opaque origin (no allow-same-origin), no
 * forms, popups or top navigation, and its own policy refuses every fetch, socket and remote
 * asset - so a view can draw, compute and respond, and cannot send anything anywhere.
 */
const POLICY =
  "default-src 'none'; script-src 'unsafe-inline' blob: data:; style-src 'unsafe-inline' data:; " +
  "img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; " +
  "form-action 'none'; base-uri 'none'";

/** Reports its height, hands links to the parent, and anchors and draws the owner's comments. */
const BRIDGE = `<script>window.__gardenFrame='view'</script><script type="module">${bridgeSource}</script>`;

const themeStyle = (): string => {
  const style = getComputedStyle(document.documentElement);
  const value = (name: string) => style.getPropertyValue(name).trim();
  return `<style>:root{--garden-bg:${value('--bg')};--garden-fg:${value('--text')};--garden-tint:${value('--tint')};--garden-muted:${value('--muted')};--garden-font:${value('--font-sans')};color-scheme:${style.colorScheme || 'light'}}</style>`;
};

export const viewDocument = (html: string, theme = ''): string =>
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${POLICY}"><meta name="viewport" content="width=device-width,initial-scale=1">${theme}${BRIDGE}${html}`;

/**
 * A result the model chose to show rather than describe: its own HTML, live, at the size the work
 * needs. Select its words, or press Comment and then anything in it, to pin a comment there; every
 * comment travels with the next message.
 */
export default function ResultView({
  artifact,
  notes = [],
  onNote
}: {
  artifact: Pick<Artifact, 'id' | 'name' | 'mimeType' | 'sizeBytes' | 'version'>;
  notes?: readonly ResultNote[];
  onNote?: (note: ResultNote) => void;
}) {
  const url = `/v1/artifacts/${artifact.id}/content`;
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [height, setHeight] = useState(360);
  const [commenting, setCommenting] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const { ref: stage, expanded, toggle } = useExpandedView<HTMLElement>();

  useEffect(() => {
    setHtml(null);
    setError('');
    const controller = new AbortController();
    void fetch(url, { credentials: 'include', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw await responseError(response);
        const text = await response.text();
        if (!controller.signal.aborted) setHtml(text);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(message(cause));
      });
    return () => controller.abort();
  }, [url, artifact.version]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (data.garden !== 1) return;
      if (data.type === 'height' && typeof data.value === 'number')
        setHeight(Math.max(120, Math.min(data.value, 6000)));
      if (data.type === 'open' && typeof data.href === 'string' && /^https?:\/\//.test(data.href))
        window.open(data.href, '_blank', 'noopener,noreferrer');
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  const srcDoc = useMemo(() => (html === null ? '' : viewDocument(html, themeStyle())), [html]);

  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  return (
    <article className={`result-view${expanded ? ' expanded' : ''}`} ref={stage}>
      <header className="result-view-bar">
        <span className="eyebrow">{artifact.name.replace(/\.html?$/i, '')}</span>
        <div className="row">
          {onNote && (
            <CommentButton
              commenting={commenting}
              onToggle={() => setCommenting((value) => !value)}
            />
          )}
          <Button
            onClick={() => void toggle()}
            aria-label={expanded ? 'Exit full screen' : 'Full screen'}
          >
            {expanded ? <X size={15} /> : <Maximize2 size={15} />}
          </Button>
        </div>
      </header>
      {html === null ? (
        <p className="muted result-view-loading">Opening the view…</p>
      ) : (
        <div className="result-view-stage" style={expanded ? undefined : { height }}>
          <FrameComments
            frame={frame}
            on={artifact.name}
            notes={notes}
            onNote={onNote ?? (() => undefined)}
            commenting={commenting}
            onDone={() => setCommenting(false)}
          >
            <iframe
              ref={frame}
              title={artifact.name}
              srcDoc={srcDoc}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              className="result-view-frame"
            />
          </FrameComments>
        </div>
      )}
    </article>
  );
}
