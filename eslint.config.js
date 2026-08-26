import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'supabase/.generated']),
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // A leading underscore marks a parameter kept for its signature rather
      // than its value - JoinSource is carried for future analytics.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Test suite, build config and tooling all run in Node.
    //
    // `.tsx` as well as `.ts`: several suites render components, and matching
    // only `.ts` quietly left them linted by nothing at all.
    files: [
      'tests/**/*.{ts,tsx}',
      'scripts/**/*.mjs',
      'vite.config.ts',
      'vite.testlab.config.ts',
      'vitest.config.ts',
    ],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    /*
     * The browser-driving gates.
     *
     * These are Node scripts, but they carry functions that are serialised and
     * evaluated inside a page - so `document` and `window` are real there, and
     * Node's globals are not. Both sets apply.
     */
    files: [
      'scripts/verify-chat-wrapping.mjs',
      'scripts/verify-test-lab.mjs',
      'scripts/store-screenshots.mjs',
    ],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // Fixtures rendered by those gates: React components, browser globals.
    files: ['scripts/fixtures/**/*.tsx'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: globals.browser,
    },
  },
])
