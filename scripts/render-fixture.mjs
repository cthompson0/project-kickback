/**
 * Bundles and runs a TSX fixture in Node, for the browser-based gates.
 *
 * The layout gate needs the markup the real components produce, and the real
 * components are TSX that Node cannot import. Rather than keep a hand-written
 * copy of the markup - which is how a fixture ends up agreeing with a bug -
 * this builds the fixture with the project's own Vite config and imports the
 * result.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Builds `entry` for SSR and returns its module exports.
 *
 * React and react-dom stay external so the bundle uses the installed copies
 * rather than a second one compiled into itself.
 */
export async function loadFixture(entry) {
  const result = await build({
    logLevel: 'error',
    plugins: [react()],
    build: {
      write: false,
      ssr: true,
      minify: false,
      rollupOptions: {
        input: entry,
        external: [/^react($|\/)/, /^react-dom($|\/)/],
        output: { format: 'es' },
      },
    },
  })

  const output = (Array.isArray(result) ? result[0] : result).output
  const chunk = output.find((item) => item.type === 'chunk' && item.isEntry)
  if (!chunk) throw new Error(`no entry chunk built from ${entry}`)

  /*
   * Written inside node_modules, not the system temp directory.
   *
   * The bundle imports react and react-dom by bare name, and Node resolves
   * those by walking up from the importing file - so it has to sit under the
   * project. node_modules is already ignored by git and by the packager.
   */
  const dir = join('node_modules', '.kickback-fixtures')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `fixture-${process.pid}.mjs`)
  writeFileSync(file, chunk.code)

  try {
    return await import(pathToFileURL(file).href)
  } finally {
    rmSync(file, { force: true })
  }
}

/**
 * Builds `entry` for the browser and returns the bundle source.
 *
 * Nothing is external here: the code is injected into a blank page that has no
 * module resolution of its own, so React travels with it. Exposed as a global
 * rather than a module so a CDP evaluate can reach it.
 */
export async function loadBrowserBundle(entry, globalName) {
  const result = await build({
    logLevel: 'error',
    plugins: [react()],
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: entry,
        output: { format: 'iife', name: globalName },
      },
    },
  })

  const output = (Array.isArray(result) ? result[0] : result).output
  const chunk = output.find((item) => item.type === 'chunk' && item.isEntry)
  if (!chunk) throw new Error(`no entry chunk built from ${entry}`)
  return chunk.code
}
