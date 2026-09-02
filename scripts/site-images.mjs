/**
 * Turns the real Store screenshots into web-sized WebP for watchside.app.
 *
 *   node scripts/site-images.mjs
 *
 * WHY THIS EXISTS
 *
 * The landing page has to show the actual product, and the only honest images
 * of it are the Store captures: 1280x800 PNGs of the real extension on real
 * Twitch, at 400-620 KB each. Three of those is over 1.5 MB, on a page whose
 * whole pitch is that Watchside is small and fast. Shipping them raw would have
 * made the page contradict itself.
 *
 * WHY CHROME AND NOT AN IMAGE LIBRARY
 *
 * sharp, jimp and friends are each a large native dependency added to a
 * repository that currently has none, for a job that runs a handful of times a
 * year. Chrome is already a build dependency here - scripts/cdp.mjs drives it
 * for the Store captures and the Firefox E2E suite - and a canvas encodes WebP
 * perfectly well. So this borrows the browser that is already required rather
 * than adding a toolchain that would not be.
 *
 * WHY THE OUTPUT IS COMMITTED
 *
 * So that `npm run build:site` needs no browser, no network and no image
 * toolchain. Same reasoning as assets/brand/icons/*.png, which are generated and
 * committed for exactly that reason. Regenerate by running this; the inputs
 * change about once a milestone.
 *
 * WHAT IS DELIBERATELY NOT DONE
 *
 * No cropping, no compositing, no retouching. These are the same frames the
 * Store listings use, including the extension's own "DEMO / mock data" badge.
 * The page is allowed to make the product look good; it is not allowed to make
 * it look like something it is not.
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { launch } from './cdp.mjs'

const SOURCE = join('assets', 'store', 'current', 'chrome')
const OUT = join('docs', 'web', 'watchside-app', 'static', 'img')

/**
 * What the page shows, and how wide it ever renders.
 *
 * `width` is the largest CSS width the image is displayed at, doubled for
 * high-density screens and then capped by the source. The hero is the only one
 * that gets the full 1280; the two supporting shots sit in a narrower column,
 * so encoding them at hero size would be paying for pixels nobody sees.
 */
const IMAGES = [
  { in: 'store-01-presence.png', out: 'presence', width: 1280, quality: 0.86 },
  { in: 'store-02-gravity-join.png', out: 'join', width: 1100, quality: 0.84 },
  { in: 'store-03-together.png', out: 'together', width: 1100, quality: 0.84 },
]

/*
 * store-04-find-friends.png is deliberately absent. It is a good screenshot,
 * but the invite field in it reads
 * `https://anoteros-labs.github.io/watchside/invite/?c=...` - the pre-domain
 * link - and a watchside.app page showing a github.io URL undermines the exact
 * thing this milestone is for.
 */

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await launch({ width: 1400, height: 900 })
  try {
    const page = await browser.newPage()
    let total = 0
    let before = 0

    for (const image of IMAGES) {
      const source = resolve(join(SOURCE, image.in))

      /*
       * Drawn through an <img> into a canvas, then re-encoded.
       *
       * The PNG goes in as a data URI rather than as the file:// URL it came
       * from, because Chrome gives every file:// document its own opaque origin
       * - so a file-loaded image taints the canvas and toDataURL throws
       * SecurityError. A data URI is same-origin with the page by definition,
       * which is the whole reason it is used here.
       */
      await page.goto('about:blank')
      const dataUri = 'data:image/png;base64,' + readFileSync(source).toString('base64')
      const encoded = await page.evaluate(
        async (href, width, quality) => {
          const img = new Image()
          img.src = href
          await img.decode()
          const scale = Math.min(1, width / img.naturalWidth)
          const canvas = document.createElement('canvas')
          canvas.width = Math.round(img.naturalWidth * scale)
          canvas.height = Math.round(img.naturalHeight * scale)
          const ctx = canvas.getContext('2d')
          ctx.imageSmoothingQuality = 'high'
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
          return {
            data: canvas.toDataURL('image/webp', quality),
            width: canvas.width,
            height: canvas.height,
          }
        },
        dataUri,
        image.width,
        image.quality,
      )

      if (!encoded.data.startsWith('data:image/webp')) {
        throw new Error(`${image.in}: the browser did not produce WebP`)
      }

      const bytes = Buffer.from(encoded.data.split(',')[1], 'base64')
      const target = join(OUT, `${image.out}.webp`)
      writeFileSync(target, bytes)

      const wasKb = statSync(source).size / 1024
      const isKb = bytes.length / 1024
      before += wasKb
      total += isKb
      console.log(
        `  ${image.out.padEnd(10)} ${String(encoded.width).padStart(4)}x${encoded.height}` +
          `  ${wasKb.toFixed(0).padStart(4)} KB -> ${isKb.toFixed(0).padStart(3)} KB` +
          `  (${(100 - (isKb / wasKb) * 100).toFixed(0)}% smaller)`,
      )
    }

    console.log(`\n  ${before.toFixed(0)} KB of PNG -> ${total.toFixed(0)} KB of WebP`)
    console.log(`  written to ${OUT}`)
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
