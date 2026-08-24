import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts on purpose: that file describes the Chrome
// extension bundle and its rollup input would confuse the test runner.
/** The same constant the real bundles are built with. */
const version = JSON.parse(readFileSync('public/manifest.json', 'utf8')).version

export default defineConfig({
  define: { __KICKBACK_VERSION__: JSON.stringify(version) },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
