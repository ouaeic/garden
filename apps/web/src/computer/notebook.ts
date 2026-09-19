import { responseError } from '../client';

export const NOTEBOOK_PREVIEW_BYTES = 32 * 1024 * 1024;
const IMAGE_BYTES = 4 * 1024 * 1024;

export function notebookObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function notebookText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return Array.isArray(value) && value.every((part) => typeof part === 'string')
    ? value.join('')
    : null;
}

export interface Notebook {
  cells: unknown[];
  language: string;
  kernel: string;
}

export function parseNotebook(text: string): Notebook {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      'This notebook is not complete, valid JSON. Download the original to inspect it.'
    );
  }
  const notebook = notebookObject(value);
  if (notebook?.nbformat !== 4 || !Array.isArray(notebook.cells))
    throw new Error(
      'This preview needs a version-4 notebook with a cell list. Download the original to open it in your notebook application.'
    );
  const metadata = notebookObject(notebook.metadata);
  const language = notebookObject(metadata?.language_info)?.name;
  const kernel = notebookObject(metadata?.kernelspec)?.display_name;
  return {
    cells: notebook.cells,
    language: typeof language === 'string' ? language.slice(0, 160) : '',
    kernel: typeof kernel === 'string' ? kernel.slice(0, 160) : ''
  };
}

/** Bound actual streamed bytes even when a server omits or misstates its length. */
export async function readNotebookResponse(response: Response): Promise<string> {
  if (!response.ok) throw await responseError(response);
  const tooLarge = () =>
    new Error(
      'This notebook is too large to preview here. Download the original to open all cells and outputs.'
    );
  if (Number(response.headers.get('content-length')) > NOTEBOOK_PREVIEW_BYTES) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) throw new Error('The notebook response was empty.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > NOTEBOOK_PREVIEW_BYTES) throw tooLarge();
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function notebookImage(data: unknown): string | null {
  const bundle = notebookObject(data);
  if (!bundle) return null;
  for (const mime of ['image/png', 'image/jpeg']) {
    const text = notebookText(bundle[mime]);
    if (!text || text.length > IMAGE_BYTES * 1.4) continue;
    const encoded = text.replace(/\s/g, '');
    if (
      encoded.length > Math.ceil(IMAGE_BYTES / 3) * 4 ||
      encoded.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    )
      continue;
    const prefix = atob(encoded.slice(0, 16));
    if (
      mime === 'image/png'
        ? prefix.startsWith('\x89PNG\r\n\x1a\n')
        : prefix.startsWith('\xff\xd8\xff')
    )
      return `data:${mime};base64,${encoded}`;
  }
  return null;
}

export function notebookAttachments(value: unknown): ReadonlyMap<string, string> {
  const images = new Map<string, string>();
  for (const [name, bundle] of Object.entries(notebookObject(value) ?? {})) {
    const image = notebookImage(bundle);
    if (image) images.set(`attachment:${name}`, image);
  }
  return images;
}
