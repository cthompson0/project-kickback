import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts on purpose: that file describes the Chrome
// extension bundle and its rollup input would confuse the test runner.
/** The same constant the real bundles are built with. */
const version = JSON.parse(readFileSync('public/manifest.json', 'utf8')).version

/**
 * Two projects, because the suite answers two different kinds of question.
 *
 * WHY THIS SPLIT EXISTS
 *
 * Everything under tests/extension and tests/db runs in `node` and renders
 * React with `renderToStaticMarkup`. That is fast, deterministic and entirely
 * sufficient for markup, contracts and SQL - and it CANNOT run a React effect.
 * No effect in this codebase had ever executed inside a test, which is exactly
 * how the group-chat autoscroll defect shipped: its bug was that an effect
 * stopped re-running, and nothing in 1712 passing tests could observe that.
 * See docs/reports/friends-beta-investigation-2026-08-27.md §3.
 *
 * So tests/dom runs in jsdom, where mounting is real, effects fire, and
 * `storage` events and scroll containers exist. It is deliberately narrow:
 * only behaviour that needs a live DOM belongs there. Everything else stays in
 * the node project, which must not get slower to buy coverage it already has.
 *
 * The existing project is unchanged - same include, same environment, same
 * timeouts - so nothing that passed before can fail for a new reason.
 */
export default defineConfig({
  define: { __KICKBACK_VERSION__: JSON.stringify(version) },
  test: {
    projects: [
      {
        define: { __KICKBACK_VERSION__: JSON.stringify(version) },
        test: {
          name: 'node',
          include: ['tests/extension/**/*.test.ts', 'tests/extension/**/*.test.tsx', 'tests/db/**/*.test.ts', 'tests/testlab/**/*.test.{ts,tsx}'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        define: { __KICKBACK_VERSION__: JSON.stringify(version) },
        test: {
          name: 'dom',
          include: ['tests/dom/**/*.test.tsx', 'tests/dom/**/*.test.ts'],
          environment: 'jsdom',
          setupFiles: ['tests/dom/setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
})
