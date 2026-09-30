// The configuration eslint.config.js cannot be: every `.mjs` in this repository is ignored there
// because the type-aware parser has no tsconfig project to resolve one against, and the effect was
// that `scripts/check-*.mjs` - the checkers that gate what ships to an owner's box - and every
// `apps/desktop/verify-*.mjs` release verifier were linted by nothing at all.
//
// So this is the untyped half: the recommended rule set only, no project service, run from
// .github/workflows/verify.yml rather than from `pnpm check`. Keeping it out of `pnpm check` is
// deliberate - a couple of dozen files that change a few times a year do not deserve a second
// eslint pass in front of every commit an owner makes.
import eslint from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  eslint.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      // These files read other people's source, so a literal run of spaces in a pattern is the
      // subject rather than a typo: `scripts/check-repository.mjs` matches shell case arms by their
      // two-space indent, and `{2}` would say less about what is being looked for.
      'no-regex-spaces': 'off'
    }
  },
  {
    // Browser probes run DOM callbacks inside the page alongside their Node harness.
    files: [
      'scripts/browser-*.mjs',
      'scripts/test-account-connections.mjs',
      'scripts/test-analysis-*.mjs',
      'scripts/test-notebook-editor.mjs',
      'scripts/test-password-workflows.mjs',
      'scripts/test-pdf-viewer.mjs',
      'scripts/test-private-diagnostics.mjs',
      'scripts/test-project-cleanup.mjs',
      'scripts/test-project-git.mjs',
      'scripts/test-svg-preview.mjs',
      'scripts/test-voice-reconnect.mjs',
      'scripts/test-web-layout.mjs'
    ],
    languageOptions: { globals: globals.browser }
  }
];
