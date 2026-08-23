import { defineConfig } from 'vite'

/**
 * Service-worker bundle: the only part of Kickback that holds a session or
 * talks to Supabase.
 *
 * Built as a second pass so it does not share a chunk with the content script.
 * emptyOutDir is false because the content build has already populated dist/.
 */
export default defineConfig({
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
