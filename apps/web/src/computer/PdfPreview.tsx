/* eslint jsx-a11y/no-noninteractive-tabindex: ["error", {"roles": ["region"]}] -- Keyboard users must be able to scroll the labeled document region. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&url';
import { Button, Field } from '../ui.js';
import { message } from './format.js';
import { PdfPage } from './PdfPage.js';
import { pdfGeometry } from './pdf-geometry.js';
import './pdf-preview.css';

GlobalWorkerOptions.workerSrc = workerUrl;
const assetBase = '/pdfjs/';
/** Viewport lengths rendered ahead of and behind the visible pages. */
const OVERSCAN_VIEWPORTS = 2;

export default function PdfPreview({ url, name }: { url: string; name: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const scrollPosition = useRef(0);
  const [documentProxy, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageSizes, setPageSizes] = useState<Array<{ width: number; height: number }> | null>(null);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(600);
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [passwordPrompt, setPasswordPrompt] = useState<{
    reason: number;
    submit: (password: string) => void;
  } | null>(null);
  const [rendered, setRendered] = useState({ first: 0, last: 0 });
  const geometry = useMemo(
    () => pdfGeometry(pageSizes ?? [], width, zoom),
    [pageSizes, width, zoom]
  );
  const previousGeometry = useRef<{ url: string; geometry: typeof geometry } | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const first = Math.min(rendered.first, Math.max(0, pageCount - 1));
  const last = Math.min(rendered.last, Math.max(0, pageCount - 1));
  const pages = Array.from(
    { length: pageCount ? last - first + 1 : 0 },
    (_, index) => first + index + 1
  );

  useEffect(() => {
    setDocument(null);
    setPageCount(0);
    setPageSizes(null);
    setRendered({ first: 0, last: 0 });
    setCurrentPage(1);
    setPassword('');
    setError('');
    setPasswordPrompt(null);
    let active = true;
    const loading = getDocument({
      url,
      cMapUrl: `${assetBase}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${assetBase}standard_fonts/`,
      wasmUrl: `${assetBase}wasm/`,
      iccUrl: `${assetBase}iccs/`
    });
    loading.onPassword = (submit: (password: string) => void, reason: number) => {
      if (active) setPasswordPrompt({ submit, reason });
    };
    void loading.promise
      .then(async (value) => {
        if (!active) {
          await value.cleanup();
          return value;
        }
        setDocument(value);
        setPageCount(value.numPages);
        const first = await value.getPage(1);
        if (!active) return value;
        const initial = first.getViewport({ scale: 1 });
        const sizes = Array.from({ length: value.numPages }, () => ({
          width: initial.width,
          height: initial.height
        }));
        setPageSizes([...sizes]);
        // Publish geometry progressively so a long document can be read before its last page loads.
        for (let number = 2; number <= value.numPages && active; number += 1) {
          const page = await value.getPage(number);
          if (!active) break;
          const viewport = page.getViewport({ scale: 1 });
          sizes[number - 1] = { width: viewport.width, height: viewport.height };
          if (number % 16 === 0 || number === value.numPages) setPageSizes([...sizes]);
        }
        return value;
      })
      .catch((cause) => {
        if (active) setError(message(cause));
      });
    return () => {
      active = false;
      void loading.destroy();
    };
  }, [url]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width;
      if (measured) setWidth(measured);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Preserve the same point on the same page when its scale or measured geometry changes.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const previous = previousGeometry.current;
    if (!previous || previous.url !== url) element.scrollTo({ top: 0, left: 0 });
    else if (previous.geometry.count && geometry.count) {
      const index = Math.min(previous.geometry.pageAt(scrollPosition.current), geometry.count - 1);
      const fraction = Math.max(
        0,
        Math.min(
          1,
          (scrollPosition.current - previous.geometry.offsets[index]!) /
            previous.geometry.heights[index]!
        )
      );
      element.scrollTop = geometry.offsets[index]! + fraction * geometry.heights[index]!;
    }
    scrollPosition.current = element.scrollTop;
    previousGeometry.current = { url, geometry };
  }, [url, geometry]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !documentProxy || !geometry.count) return;
    let frame = 0;
    const pass = () => {
      scrollPosition.current = element.scrollTop;
      const height = element.clientHeight;
      const first = geometry.pageAt(element.scrollTop - height * OVERSCAN_VIEWPORTS);
      const last = geometry.pageAt(element.scrollTop + height * (OVERSCAN_VIEWPORTS + 1));
      setRendered((old) => (old.first === first && old.last === last ? old : { first, last }));
      setCurrentPage(geometry.pageAt(element.scrollTop + height / 2) + 1);
    };
    const schedule = () => {
      scrollPosition.current = element.scrollTop;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(pass);
    };
    pass();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    element.addEventListener('scroll', schedule, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      element.removeEventListener('scroll', schedule);
    };
  }, [documentProxy, geometry]);

  const scrollToPage = (value: number) => {
    const element = scroller.current;
    if (!element || !geometry.count) return;
    setCurrentPage(value);
    element.scrollTo({ top: geometry.offsets[value - 1]! });
    scrollPosition.current = element.scrollTop;
  };

  return (
    <section className="pdf-viewer" aria-label={`${name} document`}>
      <div className="pdf-toolbar">
        <div className="pdf-page-control">
          <Field label="Page">
            <input
              type="number"
              min={1}
              max={pageCount || 1}
              value={currentPage}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isInteger(value) && value >= 1 && value <= pageCount)
                  scrollToPage(value);
              }}
            />
          </Field>
          <span>of {pageCount || '…'}</span>
        </div>
        <Field label="Zoom">
          <select
            aria-label="Zoom"
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          >
            <option value={1}>Fit width</option>
            <option value={1.5}>150%</option>
            <option value={2}>200%</option>
            <option value={3}>300%</option>
          </select>
        </Field>
        <div className="pdf-navigation">
          <Button
            aria-label="Previous page"
            disabled={currentPage <= 1}
            onClick={() => scrollToPage(Math.max(1, currentPage - 1))}
          >
            Previous
          </Button>
          <Button
            aria-label="Next page"
            disabled={!pageCount || currentPage >= pageCount}
            onClick={() => scrollToPage(Math.min(pageCount, currentPage + 1))}
          >
            Next
          </Button>
        </div>
        <a className="button" href={url} download={name}>
          Download PDF
        </a>
      </div>
      {passwordPrompt && (
        <form
          className="pdf-password"
          onSubmit={(event) => {
            event.preventDefault();
            passwordPrompt.submit(password);
            setPassword('');
            setPasswordPrompt(null);
          }}
        >
          <Field
            label={passwordPrompt.reason === 2 ? 'Incorrect password. Try again' : 'PDF password'}
          >
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <Button type="submit">Open document</Button>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error} You can download the complete PDF above.
        </p>
      )}
      {!documentProxy && !error && !passwordPrompt && <p role="status">Opening document…</p>}
      <div
        className="pdf-page-scroll"
        ref={scroller}
        tabIndex={0}
        role="region"
        aria-label="Document pages"
      >
        {pageSizes && <div aria-hidden="true" style={{ height: geometry.offsets[first] ?? 0 }} />}
        {pageSizes
          ? pages.map((number) => {
              const size = pageSizes[number - 1];
              const cssScale = Math.max(0.1, width / (size?.width ?? width)) * zoom;
              return (
                <div
                  className="pdf-page"
                  key={`${url}:${number}`}
                  role="region"
                  aria-label={`Page ${number}`}
                  data-page={number}
                  style={{
                    width: (size?.width ?? width) * cssScale,
                    height: (size?.height ?? size?.width ?? width) * cssScale
                  }}
                >
                  {documentProxy ? (
                    <PdfPage
                      documentProxy={documentProxy}
                      number={number}
                      width={width}
                      zoom={zoom}
                    />
                  ) : (
                    <span className="pdf-page-placeholder">Page {number}</span>
                  )}
                </div>
              );
            })
          : null}
        {pageSizes && (
          <div
            aria-hidden="true"
            style={{ height: Math.max(0, geometry.total - (geometry.offsets[last + 1] ?? 0)) }}
          />
        )}
      </div>
    </section>
  );
}
