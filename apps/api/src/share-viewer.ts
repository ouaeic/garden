/**
 * The page a share link opens, and the headers it opens under.
 *
 * The page is a shell: a title that names nothing, a `<noscript>` line, an empty `<main>`, and the
 * two assets the viewer needs. Everything a reader sees is decrypted in their browser from the key
 * in the fragment, so the HTML is the same bytes for every link and carries no content for a
 * crawler, a preview bot or a proxy to keep.
 *
 * The policy is set by HEADER and not by a `<meta>` tag, because `server.ts` registers helmet with
 * its policy off and a `<meta>` policy cannot carry `frame-ancestors`. `script-src 'self'` and no
 * inline script: the viewer is a built file under `/v1/shares/assets/`, which is the one prefix
 * the installed app's service worker hands to the network rather than answering with the app
 * shell. `connect-src 'self'` lets it fetch the ciphertext and nothing else. Inline styles let
 * decrypted static HTML keep its presentation in an opaque, scriptless srcdoc frame. That frame
 * prepends its own restrictive policy, allowing inline styles and local blob/data media only.
 * `frame-src blob:` also allows local file previews without making them same-origin documents.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@garden/core';

export const SHARE_PAGE_TITLE = 'A shared garden conversation';

/**
 * Sent with the viewer page. Listed as pairs so the tests can assert every one of them by name
 * rather than by the shape of one route's answer.
 */
export const shareViewerHeaders: ReadonlyArray<readonly [string, string]> = [
  [
    'content-security-policy',
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; " +
      "media-src blob:; font-src 'self'; connect-src 'self'; frame-src blob:; object-src 'none'; base-uri 'none'; " +
      "form-action 'none'; frame-ancestors 'none'"
  ],
  ['referrer-policy', 'no-referrer'],
  ['x-content-type-options', 'nosniff'],
  ['cache-control', 'no-store'],
  ['x-robots-tag', 'noindex, nofollow, noarchive']
];

/** Sent with every public data answer - the blob, an artifact, and every 404 on those routes. */
export const shareDataHeaders: ReadonlyArray<readonly [string, string]> = [
  ['referrer-policy', 'no-referrer'],
  ['x-content-type-options', 'nosniff'],
  ['cache-control', 'no-store'],
  ['x-robots-tag', 'noindex, nofollow, noarchive']
];

/** The two files the page loads, by the only names the page will ask for. */
export const SHARE_VIEWER_FILES: Record<string, { type: string }> = {
  'share.js': { type: 'text/javascript; charset=utf-8' },
  'share.css': { type: 'text/css; charset=utf-8' }
};

export interface ViewerAsset {
  bytes: Buffer;
  type: string;
  /** A content digest, which is what makes an immutable cache header honest on a fixed name. */
  version: string;
}

/**
 * Where the built viewer is unless the operator said otherwise: the web package's own build
 * output, two directories over. The same relative walk holds from `src/` under `tsx` and from
 * `dist/` under node, which is why it is stated from this module rather than from the working
 * directory.
 */
export const defaultViewerDir = (): string =>
  fileURLToPath(new URL('../../web/dist/share/', import.meta.url));

/**
 * Reads the viewer's files once and keeps them. A build replaces the files and a restart follows
 * every deploy, so there is nothing to watch; a missing file is reported as absent rather than
 * thrown, because the page still has to answer - with a shell that says the viewer is not built -
 * and the tests build no web bundle at all.
 */
export const loadViewerAssets = async (directory: string): Promise<Map<string, ViewerAsset>> => {
  const assets = new Map<string, ViewerAsset>();
  for (const [name, { type }] of Object.entries(SHARE_VIEWER_FILES)) {
    try {
      const bytes = await readFile(new URL(name, `file://${directory.replace(/\/?$/, '/')}`));
      assets.set(name, { bytes, type, version: sha256(bytes).slice(0, 16) });
    } catch {
      // Absent: reported by the page's version query as `missing` and by the asset route as 404.
    }
  }
  return assets;
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/**
 * The page. Generic by construction: nothing in it is derived from the link, so the same bytes
 * answer every share, and a fetch by anything that is not a browser learns only that a viewer
 * exists.
 */
export const shareViewerHtml = (assets: Map<string, ViewerAsset>): string => {
  const version = (name: string): string => assets.get(name)?.version ?? 'missing';
  const title = escapeHtml(SHARE_PAGE_TITLE);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="color-scheme" content="dark light">',
    `<meta property="og:title" content="${title}">`,
    '<meta property="og:description" content="Opened and read in your browser; the box that serves it cannot read it.">',
    `<title>${title}</title>`,
    `<link rel="stylesheet" href="/v1/shares/assets/share.css?v=${version('share.css')}">`,
    '</head>',
    '<body>',
    '<noscript><p class="share-noscript">This conversation is decrypted in your browser with the key after the # in the link, so it needs JavaScript to read.</p></noscript>',
    '<main id="root"><p class="share-loading">Opening…</p></main>',
    `<script type="module" src="/v1/shares/assets/share.js?v=${version('share.js')}"></script>`,
    '</body>',
    '</html>',
    ''
  ].join('\n');
};

/**
 * The page a dead link opens. The same bytes for a link that never existed, one that expired, one
 * the owner closed and a box that has sharing turned off, because telling those apart is exactly
 * what an enumerating caller would be asking.
 */
export const shareNotFoundHtml = (): string =>
  [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    '<meta name="referrer" content="no-referrer">',
    '<title>Not found</title>',
    '</head>',
    '<body><main><h1>Not found</h1><p>There is nothing at this address.</p></main></body>',
    '</html>',
    ''
  ].join('\n');
