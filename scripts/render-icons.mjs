/**
 * Rasterise the canonical Watchside mark into every size the brand needs.
 *
 * The mark is DATA, in assets/brand/geometry.mjs. Chrome cannot use an SVG for
 * an extension icon, so this renders that one source at each required size
 * through the same browser engine that will later display the result - which is
 * the only renderer whose opinion matters.
 *
 * Deterministic: same geometry in, same bytes out. Nothing is traced, sampled
 * or hand-touched, so the mark can be edited in one place forever.
 *
 *   node scripts/render-icons.mjs [--check]
 *
 * --check re-renders into memory and compares against what is committed,
 * failing if they have drifted. That is what `npm run verify:brand` runs; the
 * bare form writes the files.
 *
 * TWO SOURCES, ONE PER SIZE BAND
 *
 * geometry.mjs picks the variant: the solid silhouette at 16, the full mark
 * with its face from 32 up. That split exists because it was measured - see
 * SMALL_UP_TO there - and this script simply asks which one a size wants
 * rather than knowing anything about it.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { launch } from './cdp.mjs'
import { ICON_SIZES, iconPath, markSvg, variantFor } from '../assets/brand/geometry.mjs'

const OUT = iconPath

const check = process.argv.includes('--check')

/**
 * The wrapper page. The SVG is inlined rather than linked so there is no
 * second network request to race, and the body is stripped of every default
 * margin so the capture rectangle is exactly the artwork.
 */
function pageFor(svg, size) {
  const style =
    'html,body{margin:0;padding:0;background:transparent}' +
    'svg{display:block;width:' + size + 'px;height:' + size + 'px}'
  return (
    'data:text/html;charset=utf-8,' +
    encodeURIComponent('<!doctype html><meta charset="utf-8"><style>' + style + '</style>' + svg)
  )
}

async function main() {
  const browser = await launch({ width: 1200, height: 1200 })
  const rendered = new Map()

  try {
    for (const size of ICON_SIZES) {
      const svg = markSvg(variantFor(size), { size })
      const page = await browser.newPage(pageFor(svg, size))
      await page.waitForLoad()
      await page.setViewport(size, size)

      // A device scale factor of 1 with a viewport equal to the icon size
      // means one CSS pixel is one PNG pixel: no downsampling step exists to
      // soften the result.
      const shot = await page.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
        captureBeyondViewport: true,
      })
      rendered.set(size, Buffer.from(shot.data, 'base64'))
    }
  } finally {
    await browser.close()
  }

  let drift = 0
  for (const size of ICON_SIZES) {
    const path = resolve(OUT(size))
    const next = rendered.get(size)
    if (check) {
      let current = null
      try {
        current = readFileSync(path)
      } catch {
        /* absent counts as drift */
      }
      const same = current !== null && current.equals(next)
      if (!same) drift += 1
      console.log(
        (same ? 'ok    ' : 'DRIFT ') + OUT(size).padEnd(34) + variantFor(size) + ' mark',
      )
      continue
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, next)
    console.log(
      'wrote ' + OUT(size).padEnd(34) + variantFor(size) + ' mark  ' + next.length + ' bytes',
    )
  }

  if (check && drift) {
    console.error(
      '\n' + drift + ' icon(s) do not match assets/brand/geometry.mjs. Run: npm run brand:icons',
    )
    process.exit(1)
  }
  if (check) console.log('\nAll ' + ICON_SIZES.length + ' icons match assets/brand/geometry.mjs.')
}

await main()
