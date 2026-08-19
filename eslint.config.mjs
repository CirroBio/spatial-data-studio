// ESLint, deliberately scoped to the React hooks rules and nothing else.
//
// Why hooks specifically: a wrong dependency array is invisible to tsc and surfaces
// only as runtime behaviour — a stale closure reading last render's value, or an
// effect re-running when it should not. frontend/src/App.tsx had the second kind: a
// bootstrap effect that refetched the whole function registry through a 5-attempt
// retry loop on every session switch, fixed by reading `activeSessionId` from a ref.
// The limit, stated honestly: exhaustive-deps would NOT have caught that one, because
// the effect genuinely referenced the value it listed. What it does catch is the
// missing-dependency half of the class — the half that fails silently rather than
// loudly — plus any dependency listed but never referenced.
//
// No `eslint:recommended`, no style or formatting rules: this config is a bug
// detector for hooks, not a repo-wide cleanup, and anything wider would bury the
// hook findings under hundreds of stylistic ones. `.mjs` because the root
// package.json is not `"type": "module"`, so a plain `eslint.config.js` would be
// loaded as CommonJS.
import reactHooks from 'eslint-plugin-react-hooks';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    // The two trees that hold components and hooks. Build configs, frontend/scripts,
    // frontend/e2e and docs-site have none, so they stay out of scope.
    files: ['frontend/src/**/*.{ts,tsx}', 'packages/viewer/src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      // No `project`/type-aware parsing: neither hooks rule needs type information,
      // and turning it on would make the lint as slow as a typecheck for no gain.
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // A hook called conditionally or outside a component corrupts React's hook
      // order at runtime. Always a bug, never a style opinion -> error.
      'react-hooks/rules-of-hooks': 'error',
      // Warn, not error, only because the tree already has violations and a hard
      // failure would leave CI red on the next push. Flip to 'error' (or run the
      // lint with --max-warnings 0) once they are cleared.
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
