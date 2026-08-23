import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Content-script bundle: the Kickback panel that runs inside a Twitch tab.
 *
 * Content scripts are not ES modules, so this is emitted as one IIFE with no
 * code splitting. Everything in `public/` (manifest, icons, popup) is copied to
 * `dist/` as-is, which makes `dist/` directly loadable as an unpacked extension.
 *
 * The service worker is built separately - see vite.background.config.ts.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome120',
    modulePreload: false,
    rollupOptions: {
      input: 'src/content/index.tsx',
      output: {
        format: 'iife',
        entryFileNames: 'kickback-content.js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
