/**
 * ESLint flat config (ESLint 9).
 * Server and tooling run under Node globals; the client runs in the browser
 * and speaks JSX. Rules are @eslint/js recommended — error catching, not style.
 */
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      'node_modules/**',
      'client/dist/**',
      'client/dist-smoke/**',
      'server/uploads/**',
      'package-lock.json',
    ],
  },

  // Server + root configs + tools (Node)
  {
    files: ['*.js', 'server/**/*.js', 'tools/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      // Route handlers and CLI tools log to stdout/stderr by design.
      'no-console': 'off',
    },
  },

  // Client (browser + JSX)
  {
    files: ['client/**/*.js', 'client/**/*.jsx'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...js.configs.recommended.rules,
      // Classic React rules only. The newer compiler-era rules bundled with
      // eslint-plugin-react-hooks v7 (set-state-in-effect, purity, refs, …)
      // flag this codebase's standard async data-fetching patterns, so they
      // stay off until the effects are migrated to their stricter shape.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-console': 'off',
    },
  },
];
