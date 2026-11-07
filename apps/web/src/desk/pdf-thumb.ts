import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&url';

GlobalWorkerOptions.workerSrc = workerUrl;
const assetBase = '/pdfjs/';

const drawn = new Map<string, Promise<string>>();

/**
 * The first page of a document as a picture, so a PDF on the desk looks like the PDF it is.
 *
 * Drawn once per file version at the width the desk asks for and kept for the session; the
 * document itself is closed as soon as its first page is on the canvas.
 */
export function pdfThumb(url: string, key: string, width: number): Promise<string> {
  const cacheKey = `${key}@${width}`;
  const held = drawn.get(cacheKey);
  if (held) return held;
  const work = (async () => {
    const loading = getDocument({
      url,
      cMapUrl: `${assetBase}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${assetBase}standard_fonts/`,
      wasmUrl: `${assetBase}wasm/`,
      iccUrl: `${assetBase}iccs/`
    });
    try {
      const pdf = await loading.promise;
      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const scale = (width * Math.min(2, window.devicePixelRatio || 1)) / base.width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, viewport, background: '#ffffff' }).promise;
      return canvas.toDataURL('image/png');
    } finally {
      void loading.destroy();
    }
  })();
  drawn.set(cacheKey, work);
  work.catch(() => drawn.delete(cacheKey));
  return work;
}
