import { useEffect, useRef, useState } from 'react';
import { TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import { message } from './format.js';

const MAX_CANVAS_PIXELS = 4_000_000;

/** Each scale has its own canvas so a cancelled renderer cannot paint into its successor. */
export function PdfPage({
  documentProxy,
  number,
  width,
  zoom
}: {
  documentProxy: PDFDocumentProxy;
  number: number;
  width: number;
  zoom: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    let render: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    const container = host.current;
    setLoading(true);
    setError('');
    void (async () => {
      const page = await documentProxy.getPage(number);
      if (!active || !container) return;
      const natural = page.getViewport({ scale: 1 });
      const cssScale = Math.max(0.1, width / natural.width) * zoom;
      const scale = Math.min(
        cssScale * Math.min(window.devicePixelRatio || 1, 2),
        Math.sqrt(MAX_CANVAS_PIXELS / (natural.width * natural.height))
      );
      const viewport = page.getViewport({ scale });
      const cssViewport = page.getViewport({ scale: cssScale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${cssViewport.width}px`;
      canvas.style.height = `${cssViewport.height}px`;
      canvas.setAttribute('aria-hidden', 'true');
      const text = document.createElement('div');
      text.className = 'pdf-text-layer';
      text.style.setProperty('--total-scale-factor', String(cssScale));
      container.replaceChildren(canvas, text);
      render = page.render({ canvas, viewport, background: '#ffffff' });
      textLayer = new TextLayer({
        container: text,
        textContentSource: page.streamTextContent(),
        viewport: cssViewport
      });
      await Promise.all([render.promise, textLayer.render()]);
      if (active) setLoading(false);
    })().catch((cause) => {
      if (active) {
        setError(message(cause));
        setLoading(false);
      }
    });
    return () => {
      active = false;
      render?.cancel();
      textLayer?.cancel();
      container?.replaceChildren();
    };
  }, [documentProxy, number, width, zoom]);
  return (
    <>
      <div className="pdf-page-content" ref={host} />
      {loading && (
        <span className="pdf-page-placeholder" role="status">
          Rendering page {number}…
        </span>
      )}
      {error && (
        <span className="pdf-page-error" role="alert">
          Page {number}: {error}
        </span>
      )}
    </>
  );
}
