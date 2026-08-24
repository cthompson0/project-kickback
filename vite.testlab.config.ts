import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The Test Lab: a development-only web app, deliberately a SEPARATE Vite app.
 *
 * This is the strongest isolation available. The extension is built from
 * `src/content/index.tsx` and `src/background/index.ts`; neither imports
 * anything under `src/testlab`, so no simulator code can reach `dist/` at all -
 * not behind a flag, not behind a dead branch, not as a string. There is
 * nothing in a shipped build to accidentally enable.
 *
 * `VITE_KICKBACK_MODE=test_lab` is set here rather than in a .env file so the
 * lab cannot be started in any other mode, and so `setJoinNavigator` - the one
 * production seam the lab uses - is inert everywhere else.
 *
 * The dev server is history-fallback by default, which the lab relies on: it
 * writes the observer's channel into the URL (`/lirik`) because that is where
 * `getCurrentChannel` reads it from.
 */
const version = JSON.parse(readFileSync('public/manifest.json', 'utf8')).version

export default defineConfig({
  root: 'src/testlab',
  // Root-relative so `/lirik` resolves the same assets `/` does.
  base: '/',
  define: {
    __KICKBACK_VERSION__: JSON.stringify(version),
    'import.meta.env.VITE_KICKBACK_MODE': JSON.stringify('test_lab'),
  },
  plugins: [react()],
  server: {
    port: 5199,
    // Opened for a developer; the verify script sets KB_LAB_NO_OPEN.
    open: process.env.KB_LAB_NO_OPEN !== '1',
  },
  build: {
    // Never `dist/`. A lab build must not be mistakable for an extension build.
    outDir: '../../dist-testlab',
    emptyOutDir: true,
  },
})
