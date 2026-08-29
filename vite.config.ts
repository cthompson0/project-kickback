import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Content-script bundle: the Watchside panel that runs inside a Twitch tab.
 *
 * Content scripts are not ES modules, so this is emitted as one IIFE with no
 * code splitting. Everything in `public/` (manifest, icons, popup) is copied to
 * `dist/` as-is, which makes `dist/` directly loadable as an unpacked extension.
 *
 * The service worker is built separately - see vite.background.config.ts.
 */
/** Read from the manifest so the shipped version has exactly one source. */
const version = JSON.parse(readFileSync('public/manifest.json', 'utf8')).version

/**
 * Which engine this bundle is for.
 *
 * Folded into the source as a string literal, so src/platforms/browser/index.ts
 * picks its adapter at build time and the other engine's adapter is dropped by
 * tree-shaking rather than shipped and skipped over at runtime.
 *
 * Defaults to chromium on purpose: a build with no flag set should produce the
 * shipping product, not a broken one.
 */
const browserTarget = process.env.WATCHSIDE_BROWSER === 'gecko' ? 'gecko' : 'chromium'

/**
 * Where the bundles land.
 *
 * Overridable so a Firefox build can be produced WITHOUT disturbing dist/,
 * which is the Chromium output and the thing the Chrome Web Store package is
 * built from. Defaults to dist/, so the Chromium path is byte-for-byte what it
 * was.
 */
const outDir = process.env.WATCHSIDE_OUT_DIR ?? 'dist'

export default defineConfig({
  define: {
    __KICKBACK_VERSION__: JSON.stringify(version),
    'import.meta.env.VITE_WATCHSIDE_BROWSER': JSON.stringify(browserTarget),
  },
  plugins: [react()],
  build: {
    outDir,
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
