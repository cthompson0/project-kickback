import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts on purpose: that file describes the Chrome
// extension bundle and its rollup input would confuse the test runner.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
