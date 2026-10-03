import { useEffect, useMemo, useRef, useState } from 'react';
import type { Artifact, ResultNote } from '@garden/contracts';
import { responseError } from './client.js';
import { message } from './computer/format.js';
import { Maximize2, X } from './icons';
import { useExpandedView } from './use-expanded-view';
import { Markable, MarkButton } from './result-notes';
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

/** Reports its height, answers what lies under a point, and hands links to the parent. */
const BRIDGE = `<script>(()=>{const post=(m)=>parent.postMessage(Object.assign({garden:1},m),'*');
const size=()=>post({type:'height',value:Math.ceil(document.documentElement.getBoundingClientRect().height)});
addEventListener('load',size);new ResizeObserver(size).observe(document.documentElement);
addEventListener('message',(e)=>{const d=e.data||{};if(d.garden!==1||d.type!=='probe')return;
const el=document.elementFromPoint(d.x*innerWidth,d.y*document.documentElement.scrollHeight-scrollY);
const t=(el&&(el.closest('[data-label]')?.getAttribute('data-label')||el.innerText||el.textContent||''))||'';
post({type:'probe',id:d.id,text:t.replace(/\\s+/g,' ').trim().slice(0,300)})});
addEventListener('click',(e)=>{const a=e.target.closest&&e.target.closest('a[href]');if(!a)return;
const h=a.getAttribute('href');if(h&&!h.startsWith('#')){e.preventDefault();post({type:'open',href:a.href})}},true);})();</script>`;

const themeStyle = (): string => {
  const style = getComputedStyle(document.documentElement);
  const value = (name: string) => style.getPropertyValue(name).trim();
  return `<style>:root{--garden-bg:${value('--bg')};--garden-fg:${value('--text')};--garden-tint:${value('--tint')};--garden-muted:${value('--muted')};--garden-font:${value('--font-sans')};color-scheme:${style.colorScheme || 'light'}}</style>`;
};

export const viewDocument = (html: string, theme = ''): string =>
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${POLICY}"><meta name="viewport" content="width=device-width,initial-scale=1">${theme}${BRIDGE}${html}`;

interface Circle {
  x: number;
  y: number;
  radius: number;
}

/**
 * A result the model chose to show rather than describe: its own HTML, live, at the size the work
 * needs. Mark turns the pointer into a pen - press to circle a place, then say what is wrong or
 * wanted there - and every comment travels with the next message.
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
  const [marking, setMarking] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const probes = useRef(new Map<string, (text: string) => void>());
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
      if (data.type === 'probe' && typeof data.id === 'string') {
        probes.current.get(data.id)?.(typeof data.text === 'string' ? data.text : '');
        probes.current.delete(data.id);
      }
      if (data.type === 'open' && typeof data.href === 'string' && /^https?:\/\//.test(data.href))
        window.open(data.href, '_blank', 'noopener,noreferrer');
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  const srcDoc = useMemo(() => (html === null ? '' : viewDocument(html, themeStyle())), [html]);

  /** What the view shows under a point, asked of the view itself and never waited on for long. */
  const probe = (circle: Circle): Promise<string> =>
    new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      probes.current.set(id, resolve);
      frame.current?.contentWindow?.postMessage(
        { garden: 1, type: 'probe', id, x: circle.x, y: circle.y },
        '*'
      );
      setTimeout(() => {
        if (probes.current.delete(id)) resolve('');
      }, 400);
    });

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
            <MarkButton marking={marking} onToggle={() => setMarking((value) => !value)} />
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
          <Markable
            on={artifact.name}
            notes={notes}
            onNote={onNote ?? (() => undefined)}
            marking={marking}
            probe={probe}
          >
            <iframe
              ref={frame}
              title={artifact.name}
              srcDoc={srcDoc}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              className="result-view-frame"
            />
          </Markable>
        </div>
      )}
    </article>
  );
}
