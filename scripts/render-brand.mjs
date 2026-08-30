/**
 * Write the canonical brand SVGs from assets/brand/geometry.mjs.
 *
 *   node scripts/render-brand.mjs [--check]
 *
 * The .svg files are BUILD OUTPUT, not sources. They exist because a designer,
 * a store listing form and a social template all want a file they can open,
 * and because "hand me the logo" should never be answered with "import this
 * module". Generating them means they cannot drift from the thing the product
 * actually draws.
 *
 * --check fails if what is committed no longer matches the geometry, which is
 * what `npm run verify:brand` wants.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { markSvg } from '../assets/brand/geometry.mjs'

const check = process.argv.includes('--check')

/**
 * The lockup, assembled from the mark plus a text element.
 *
 * Unlike the mark, the WORDMARK is allowed to name a font: it is used in
 * marketing surfaces that this repo renders itself through headless Chrome,
 * where the font is loaded and the output is a raster. It is not shipped as a
 * live SVG to third parties.
 */
function lockupSvg() {
  const mark = markSvg('full', { ground: false })
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>$/, '')
    .replace(/<title>.*?<\/title>/, '')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 128" width="560" height="128" role="img" aria-label="Watchside">` +
    `<title>Watchside</title>` +
    `<g>${mark}</g>` +
    `<text x="150" y="82" font-family="Outfit, Poppins, Inter, sans-serif" font-size="72" font-weight="600" letter-spacing="-2" fill="#F5F5F7">watchside</text>` +
    `</svg>`
  )
}

const FILES = [
  ['assets/brand/watchside-mark.svg', markSvg('full')],
  ['assets/brand/watchside-mark-small.svg', markSvg('small')],
  ['assets/brand/watchside-mark-bare.svg', markSvg('full', { ground: false })],
  ['assets/brand/watchside-wordmark.svg', lockupSvg()],
]

let drift = 0
for (const [path, body] of FILES) {
  const next = `${body}\n`
  if (check) {
    let current = null
    try {
      current = readFileSync(resolve(path), 'utf8')
    } catch {
      /* absent counts as drift */
    }
    const same = current === next
    if (!same) drift += 1
    console.log((same ? 'ok    ' : 'DRIFT ') + path)
    continue
  }
  mkdirSync(dirname(resolve(path)), { recursive: true })
  writeFileSync(resolve(path), next, 'utf8')
  console.log('wrote ' + path.padEnd(42) + next.length + ' bytes')
}

if (check && drift) {
  console.error(`\n${drift} brand file(s) do not match the geometry. Run: npm run brand:svg`)
  process.exit(1)
}
if (check) console.log('\nAll brand SVGs match assets/brand/geometry.mjs.')

