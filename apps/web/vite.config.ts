import { gzipSync } from 'node:zlib';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { pdfAssets } from './pdf-assets.js';
import { buildIdentity, webBuildId } from './build-identity.js';

/**
 * What the browser must download before it can paint the first screen: the entry chunk plus
 * everything it statically imports, gzipped. Lazy chunks are excluded because nothing waits on
 * them. A warning here would be worthless — a bundle regression is only ever noticed if it stops
 * the build — so this fails instead.
 *
 * Raised from 145 kB, deliberately and once. Measured: 143.9 kB before the work-log, approval and
 * settings changes and 148.0 kB after, all of it real code on the first screen — the evidence a
 * tool call left behind (`workEvidence` and the three renderers it feeds), the keys and focus the
 * approval card now answers, and the join that pairs a result with the arguments it answers.
 *
 * The other remedy was examined and does not exist here: the diff renderer is the one lump worth
 * deferring, and `TaskModals` needs it synchronously — putting a Suspense fallback inside the card
 * that asks before something irreversible is a worse trade than four kilobytes. The one saving that
 * did exist was taken: the two rules tables on "What it may do" are prose read by a lazily-loaded
 * settings page and were riding in because the composer imports the mode labels from the same
 * module, so they now live in `asking-rules.ts`.
 *
 * Raised from 150 kB, deliberately and once more, to pay for decomposing `App()`. Measured: 147.9 kB
 * before and 151.3 kB after — 203.0 kB raw against 192.4 kB, and the eager *module set* is unchanged
 * file for file, so not one byte of it is code that was previously lazy. It is plumbing: fifty state
 * cells that were locals in one closure, minified to single letters, are now the properties of
 * sixteen named hooks and cross four module boundaries, where a property name cannot be mangled.
 *
 * Taken rather than avoided, because the alternative was not taking it: the one lever that would
 * have paid for it is deferring the workbench itself, and that costs a round trip on the first paint
 * of every already-signed-in owner, which is the whole screen. And it is bought back several times
 * over on the budget below, which measures what the owner actually waits through — the first reply
 * fell 336.1 kB to 251.3 kB in the same change.
 */
const EAGER_BUDGET_BYTES = 153_000;

/**
 * What the browser must download before the owner can *read a reply*, which is not the same screen
 * and was never measured.
 *
 * The first paint is a text box; the first thing anybody came for is an answer in it, and that
 * answer is markdown. `Markdown.tsx` holds the renderer behind `lazy`, so none of it is in the
 * eager graph above — and 180 kB gzip of it therefore sat outside every budget this repository had.
 * The gate that could not see it is why `MarkdownBody` came to import the whole KaTeX chunk to
 * reach `property-information`: 86.5 kB gzip of a maths typesetter fetched on the first assistant
 * message whether or not it contained maths, with nothing in the build to say so.
 *
 * Measured over the same walk, from the entry *and* from the markdown renderer, so a chunk shared
 * by both is counted once. 338.5 kB gzip when this was first measured, 252.7 kB after the
 * `vendor-markdown` group below took the hast/unist utilities out of katex's chunk.
 */
const FIRST_MESSAGE_BUDGET_BYTES = 257_000;

/**
 * The module the first reply waits on. Named by source path rather than by chunk name because the
 * chunk is hashed and the group it lands in is exactly the thing under test.
 */
const FIRST_MESSAGE_ROOT = /[\\/]src[\\/]MarkdownBody\.tsx$/;

/**
 * The page both budgets above are measured from. An HTML entry's chunk is faced by the HTML file
 * itself rather than by the script it loads, which is why this names `index.html` and not
 * `src/main.tsx`.
 */
const APP_ENTRY = /[\\/]index\.html$/;

/**
 * The same walk, three times used: it measures the first paint, it measures the first reply, and it
 * writes the hashed names down for the service worker, which cannot guess them and precached an
 * index.html it could not run.
 */
const eagerBundleGraph = (): Plugin => ({
  name: 'garden-eager-bundle-graph',
  apply: 'build',
  generateBundle(_options, bundle) {
    const byFileName = new Map(Object.values(bundle).map((item) => [item.fileName, item]));
    /*
     * The app's own entry, named by the module it was built from and not by being the first entry
     * in the bundle. "First entry" was correct while there was one; the share viewer is a second
     * build with its own configuration precisely so it never shares this graph, but the day one
     * is added to this configuration the first chunk marked `isEntry` is whichever the bundler
     * emitted first, and the eager budget would silently measure the wrong page.
     */
    const entry = Object.values(bundle).find(
      (item) => item.type === 'chunk' && item.isEntry && APP_ENTRY.test(item.facadeModuleId ?? '')
    );
    if (entry?.type !== 'chunk')
      this.error(
        `no entry chunk was built from ${APP_ENTRY.source}, so the eager budget measured nothing. ` +
          'Point APP_ENTRY at the page the app is served from now.'
      );

    /** Gzipped bytes of one emitted file, and the line the report prints for it. */
    const weigh = (fileName: string): { bytes: number; line: string } | undefined => {
      const item = byFileName.get(fileName);
      const source =
        item?.type === 'chunk' ? item.code : typeof item?.source === 'string' ? item.source : '';
      if (!source) return undefined;
      const bytes = gzipSync(source).byteLength;
      return { bytes, line: `${fileName} ${(bytes / 1000).toFixed(1)} kB` };
    };

    /** Everything reached by static import from `roots`, plus the stylesheets those chunks carry. */
    const graphFrom = (roots: string[], seen = new Set<string>()): Set<string> => {
      const walk = (fileName: string): void => {
        if (seen.has(fileName)) return;
        seen.add(fileName);
        const chunk = byFileName.get(fileName);
        if (chunk?.type !== 'chunk') return;
        for (const imported of chunk.imports) walk(imported);
        for (const css of chunk.viteMetadata?.importedCss ?? []) seen.add(css);
      };
      for (const root of roots) walk(root);
      return seen;
    };

    /** One budget, reported whether or not it holds, and failing the build when it does not. */
    const enforce = (label: string, files: Iterable<string>, budget: number, remedy: string) => {
      let total = 0;
      const parts: string[] = [];
      for (const fileName of files) {
        const weighed = weigh(fileName);
        if (!weighed) continue;
        total += weighed.bytes;
        parts.push(weighed.line);
      }
      const report = `${label} ${(total / 1000).toFixed(1)} kB gzip (budget ${(
        budget / 1000
      ).toFixed(1)} kB)\n  ${parts.sort().join('\n  ')}`;
      if (total > budget) this.error(`${report}\n${remedy}`);
      this.info?.(report);
    };

    const eager = graphFrom([entry.fileName]);
    enforce(
      'eager bundle',
      eager,
      EAGER_BUDGET_BYTES,
      'Move the new weight behind a dynamic import, or raise EAGER_BUDGET_BYTES deliberately.'
    );

    /*
     * The eager set is carried in as already-seen, so the first-reply figure is the whole download
     * and not the delta — this is what the owner waits through, and a shared chunk is paid for once.
     */
    const markdownRoot = Object.values(bundle).find(
      (item) =>
        item.type === 'chunk' && item.facadeModuleId && FIRST_MESSAGE_ROOT.test(item.facadeModuleId)
    );
    if (markdownRoot?.type !== 'chunk')
      this.error(
        `no chunk was built from ${FIRST_MESSAGE_ROOT.source}, so the first-reply budget measured nothing. ` +
          'Point FIRST_MESSAGE_ROOT at whatever renders an assistant message now.'
      );
    else
      enforce(
        'first reply',
        graphFrom([markdownRoot.fileName], new Set(eager)),
        FIRST_MESSAGE_BUDGET_BYTES,
        'A vendor the markdown renderer reaches has grown, or a lazy chunk has become a static import of it. ' +
          'Check the codeSplitting groups below before raising FIRST_MESSAGE_BUDGET_BYTES.'
      );

    this.emitFile({
      type: 'asset',
      fileName: 'asset-manifest.json',
      source: `${JSON.stringify(
        { eager: [...eager].sort().map((fileName) => `/${fileName}`) },
        null,
        2
      )}\n`
    });
  }
});

const buildId = webBuildId();
export default defineConfig({
  define: { __GARDEN_WEB_BUILD_ID__: JSON.stringify(buildId) },
  plugins: [react(), eagerBundleGraph(), pdfAssets(), buildIdentity(buildId)],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    hmr: { host: 'localhost', clientPort: 5173 },
    proxy: { '/v1': 'http://127.0.0.1:4100', '/healthz': 'http://127.0.0.1:4100' }
  },
  build: {
    sourcemap: true,
    // These vendors change on their own schedule rather than ours. Splitting them stops a deploy
    // from invalidating React for everyone who already has it, and keeps the eager/lazy split
    // legible in the build report.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            /*
             * Ahead of `vendor-katex`, and that order is the whole point.
             *
             * These are the hast/unist utilities react-markdown needs to turn a tree into
             * elements, and rehype-katex needs them too. Groups claim in order, so with only a
             * katex group declared they were swept into it — and `MarkdownBody` reaching
             * `property-information` therefore reached the whole 288 kB katex chunk *statically*.
             * Maths is behind a dynamic import (`katex-plugins.ts`) precisely so a message without
             * maths never pays for it, and this is what made that saving unreachable: 86.5 kB gzip
             * of KaTeX on the first assistant message, maths or no maths. Claimed here first, the
             * markdown renderer takes what it needs and katex stays lazy.
             */
            {
              name: 'vendor-markdown',
              test: /node_modules[\\/](hast-[^\\/]*|unist-[^\\/]*|hastscript|property-information|[^\\/]*-separated-tokens|web-namespaces)[\\/]/
            },
            { name: 'vendor-katex', test: /node_modules[\\/](katex|rehype-katex)[\\/]/ },
            {
              name: 'vendor-highlight',
              test: /node_modules[\\/](highlight\.js|rehype-highlight|lowlight)[\\/]/
            }
          ]
        }
      }
    }
  }
});
