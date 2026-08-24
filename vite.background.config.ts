import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

/**
 * Service-worker bundle: the only part of Kickback that holds a session or
 * talks to Supabase.
 *
 * Built as a second pass so it does not share a chunk with the content script.
 * emptyOutDir is false because the content build has already populated dist/.
 */
/** Read from the manifest so the shipped version has exactly one source. */
const version = JSON.parse(readFileSync('public/manifest.json', 'utf8')).version

export default defineConfig({
  define: { __KICKBACK_VERSION__: JSON.stringify(version) },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome120',
    modulePreload: false,
    rollupOptions: {
      input: 'src/background/index.ts',
      output: {
        format: 'iife',
        entryFileNames: 'kickback-background.js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
