# Garden artwork

The selected oak sprig and botanical wordmark were created with the built-in image generation tool.
The brief was monochrome botanical pixel art: an oak sprig with no surround for the app icon, and
lowercase “garden” lettering with oak leaves incorporated into the letters for the wordmark.

The PNGs preserve the selected originals. `scripts/build-brand.mjs` traces their light-ink
silhouettes into SVG, exports the web icons, and runs the native icon generator. The web wordmark
uses the interface's current text colour. Native and installed web icons use Garden's dark palette.

Regenerate from the repository root with Node 24 and the pinned pnpm:

```sh
node scripts/build-brand.mjs
```

This uses the browser runtime already installed for the workspace runner's browser tests, the
pinned Tauri CLI, and ImageMagick for the alpha-free iOS PNG export.
