import { isNativeClient, nativePreviewOrigins, nativeServerOrigin } from './client';

const previewPath = (url: URL): boolean =>
  /^\/__garden\/preview\/[0-9a-f]{32}(?:\/|$)/.test(url.pathname);
const address = (value: string): URL => {
  const url = new URL(value, typeof window === 'undefined' ? undefined : window.location.origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('The preview address is not a web address.');
  return url;
};

/** Storage is enabled only in a browser origin separate from the owner API. */
export function previewIsolated(value: string): boolean {
  try {
    const url = address(value);
    if (!previewPath(url)) return false;
    if (isNativeClient()) {
      const bridge = nativePreviewOrigins();
      return bridge !== null && (url.origin === bridge.remote || url.origin === bridge.local);
    }
    return typeof window !== 'undefined' && url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

export function previewUrl(value: string, embedded = true): string {
  const url = address(value);
  if (embedded && isNativeClient() && previewPath(url)) {
    const bridge = nativePreviewOrigins();
    if (bridge && url.origin === bridge.remote)
      return `${bridge.local}${url.pathname}${url.search}${url.hash}`;
    if (url.origin === nativeServerOrigin()) return `${url.pathname}${url.search}${url.hash}`;
  }
  return url.href;
}
