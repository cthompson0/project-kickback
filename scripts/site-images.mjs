/**
 * Turns the canonical marketing masters into web-sized WebP for watchside.app.
 *
 *   node scripts/site-images.mjs
 *
 * WHY THIS EXISTS
 *
 * The landing page has to show the actual product, and the only honest images
 * of it are the real captures: 3200x2000 PNGs of the shipping extension on real
 * Twitch, at 1.2-2.9 MB each. Three of those is over 5 MB, on a page whose whole
 * pitch is that Watchside is small and fast. Shipping them raw would have made
 * the page contradict itself.
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
 * No cropping, no compositing, no retouching. Resize and re-encode, nothing
 * else, so the frame the page shows is the frame that was captured - the
 * extension's own DEMO badge and "demo mode - mock data" footer included. The
 * page is allowed to make the product look good; it is not allowed to make it
 * look like something it is not.
 *
 * The friends in these frames are fixtures and the badge says so. The channels
 * are real and public, and nothing on the page suggests any streamer uses,
 * endorses or has heard of Watchside.
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { launch } from './cdp.mjs'

const SOURCE = join('assets', 'marketing', 'current')
const OUT = join('docs', 'web', 'watchside-app', 'static', 'img')

/**
 * What the page shows, and how wide it ever renders.
 *
 * The sources are the canonical marketing masters - 3200x2000 captures of the
 * shipping extension against live Twitch, with the Twitch metadata harvested
 * minutes before the shutter. They replaced the 1280x800 Store frames, which
 * predate the metadata enrichment and show the plain monogram card the product
 * no longer uses.
 *
 * `width` is the largest CSS width the image is ever displayed at. The hero
 * spans the content column and gets 1280; the two supporting shots sit in a
 * narrower split, so encoding them at hero size would be paying for pixels
 * nobody sees.
 *
 * WHICH MASTER GOES WHERE, and why it is not the obvious one-to-one:
 *
 *   hero          gravity-join. The mechanism in one frame - a friend HERE on
 *                 this stream, three more gathered elsewhere, JOIN. That is
 *                 what the product IS, so it is what the first screenshot
 *                 shows.
 *   "already here"  here. The payoff: three friends on the stream you are on.
 *   "watch together"  together. The session itself, mid-conversation.
 *
 * marketing-01-presence.png is deliberately unused. It is a good frame and it
 * duplicates what the hero already says; the page has three screenshot slots,
 * and adding a fourth section to accommodate a fourth image would be building
 * page around assets rather than the other way round.
 */
const IMAGES = [
  { in: 'marketing-02-gravity-join.png', out: 'gravity-join', width: 1280, quality: 0.86 },
  { in: 'marketing-03-here.png', out: 'here', width: 1100, quality: 0.84 },
  { in: 'marketing-04-together.png', out: 'together', width: 1100, quality: 0.84 },
]

/**
 * Also at twice the size, for high-density screens.
 *
 * The masters are 3200 wide, so a 2x variant is real detail rather than an
 * upscale, and the panel's text is the whole subject - on a retina laptop the
 * 1x image is visibly soft exactly where the reader is trying to read.
 *
 * `srcset` is what keeps this from being a page-weight regression: a 1x screen
 * downloads only the 1x file and never sees these. The quality is lower than
 * the 1x because it can be - at twice the resolution the artefacts land below
 * what the eye resolves, and holding 0.86 there would roughly double the file
 * for no visible gain.
 */
const RETINA = { suffix: '@2x', scale: 2, quality: 0.72 }

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await launch({ width: 1400, height: 900 })
  try {
    const page = await browser.newPage()
    let total = 0
    let before = 0

    const variants = IMAGES.flatMap((image) => [
      { ...image, suffix: '' },
      {
        ...image,
        suffix: RETINA.suffix,
        width: image.width * RETINA.scale,
        quality: RETINA.quality,
      },
    ])

    for (const image of variants) {
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
      const target = join(OUT, `${image.out}${image.suffix}.webp`)
      writeFileSync(target, bytes)

      const wasKb = statSync(source).size / 1024
      const isKb = bytes.length / 1024
      before += wasKb
      total += isKb
      console.log(
        `  ${(image.out + image.suffix).padEnd(16)} ${String(encoded.width).padStart(4)}x${encoded.height}` +
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
