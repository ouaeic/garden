export const bytes = (value: number) =>
  value < 1024
    ? `${value} B`
    : value < 1024 ** 2
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1024 ** 2).toFixed(1)} MB`;
export const message = (error: unknown) =>
  error instanceof Error ? error.message : 'This operation could not complete.';

export function decodeEditableText(content: Uint8Array): string | null {
  if (content.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

export function mimeTypeForFile(name: string): string {
  const types: Record<string, string> = {
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    ipynb: 'application/x-ipynb+json',
    html: 'text/html',
    htm: 'text/html',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    mp4: 'video/mp4',
    webm: 'video/webm'
  };
  return types[name.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

export function artifactRequest(
  file: { path: string; text: string; original: string; truncated: boolean },
  taskId: string | null
): { path: string; mimeType: string; taskId?: string } | null {
  if (file.truncated || file.text !== file.original) return null;
  return {
    path: file.path,
    mimeType: mimeTypeForFile(file.path),
    ...(taskId ? { taskId } : {})
  };
}
