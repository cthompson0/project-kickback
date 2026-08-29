/**
 * Rasterise the canonical Watchside mark into the extension's icon sizes.
 *
 * The mark lives in assets/brand/watchside-mark.svg as real geometry. Chrome
 * cannot use an SVG for an extension icon, so this renders that one source at
 * each required size through the same browser engine that will later display
 * the result - which is the only renderer whose opinion matters.
 *
 * Deterministic: same SVG in, same bytes out. Nothing is traced, sampled or
 * hand-touched, so the mark can be edited in one place forever.
 *
 *   node scripts/render-icons.mjs [--check]
 *
 * --check re-renders into memory and compares against what is committed,
 * failing if they have drifted. That is what CI and `npm run verify:brand`
 * want; the bare form writes the files.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { launch } from './cdp.mjs'

const SOURCE = 'assets/brand/watchside-mark.svg'
const SIZES = [16, 32, 48, 128]
const OUT = (size) => `public/icons/icon-${size}.png`

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
  const svg = readFileSync(resolve(SOURCE), 'utf8')
  const browser = await launch({ width: 400, height: 400 })
  const rendered = new Map()

  try {
    for (const size of SIZES) {
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
  for (const size of SIZES) {
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
      console.log((same ? 'ok    ' : 'DRIFT ') + OUT(size))
      continue
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, next)
    console.log('wrote ' + OUT(size) + '  ' + next.length + ' bytes')
  }

  if (check && drift) {
    console.error(
      '\n' + drift + ' icon(s) do not match ' + SOURCE + '. Run: node scripts/render-icons.mjs',
    )
    process.exit(1)
  }
  if (check) console.log('\nAll icons match ' + SOURCE + '.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
