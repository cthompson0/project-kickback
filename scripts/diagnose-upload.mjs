/**
 * Isolate the image pipeline, not the artwork.
 *
 *   node scripts/diagnose-upload.mjs
 *
 * WHY THIS REPLACED THE AESTHETIC VARIANTS
 *
 * Eight composition candidates - glow off, gradients flattened, ground lifted,
 * solid mark, double resolution - all artifacted identically after upload. When
 * changing the picture does not change the result, the picture is not the
 * variable. What every one of them shared was the file: 8-bit RGB, written by
 * Chromium's screenshot encoder, carrying NO colour metadata of any kind.
 *
 * So this matrix holds the composition still and varies only how the file is
 * made. Each row answers a different question:
 *
 *   A  the current renderer, unchanged            the control
 *   B  same pixels, our own encoder               is Chromium's PNG the problem?
 *   C  same pixels, explicitly tagged sRGB        is UNTAGGED colour the problem?
 *   D  high-quality JPEG                          does pre-compressing beat their
 *                                                  recompression?
 *   E  flat colour, no gradients, no antialiasing does ANY image artifact, or
 *      generated entirely in Node                  only ours?
 *
 * E is the one that decides the whole question. It shares no pixels, no
 * encoder and no renderer with anything else here: if E comes back clean, the
 * problem is in our file or our content. If E artifacts too, the platform is
 * doing this to everything and no export setting will fix it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './cdp.mjs'
import { encodePng } from './png.mjs'
import { COLOR } from '../assets/brand/tokens.mjs'

const OUT = 'assets/social/diagnostic'
const SOURCE = 'assets/social/out'

/* ------------------------------------------------- pixels in, pixels out */

/**
 * Decode a PNG to raw RGBA, using the browser as the decoder only.
 *
 * Chromium still reads the file, but it no longer writes one - everything
 * downstream of this is our own code, so an encoder fault and a renderer fault
 * stop being the same suspect.
 */
async function pixelsOf(page, path) {
  const b64 = readFileSync(path).toString('base64')
  const r = await page.send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const img = new Image(); img.src = 'data:image/png;base64,${b64}'; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const x = c.getContext('2d', { colorSpace: 'srgb' }); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height);
      return { w: c.width, h: c.height, data: [...new Uint8Array(d.data.buffer)] };
    })()`,
  })
  const v = r.result.value
  return { width: v.w, height: v.h, data: Buffer.from(v.data) }
}

/** Re-encode as JPEG in the page, at a quality worth uploading. */
async function jpegOf(page, path, quality) {
  const b64 = readFileSync(path).toString('base64')
  const r = await page.send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const img = new Image(); img.src = 'data:image/png;base64,${b64}'; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      return c.toDataURL('image/jpeg', ${quality}).split(',')[1];
    })()`,
  })
  return Buffer.from(r.result.value, 'base64')
}

/* ------------------------------------------------ the independent raster */

/**
 * A reference image drawn entirely in Node: flat fills, hard edges, no
 * antialiasing, no gradient, no font.
 *
 * Deliberately crude. It is not meant to look like the brand - it is meant to
 * be the simplest possible thing a platform could mishandle, so that if IT
 * artifacts, nothing about our artwork is on trial.
 *
 * Three bands of the exact brand colours plus a hard-edged violet block, so
 * banding, chroma bleeding and blocking would each be obvious and
 * distinguishable by eye.
 */
function referenceRaster(width, height) {
  const data = Buffer.alloc(width * height * 4)
  const hex = (h) => [
    parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16),
  ]
  const ground = hex(COLOR.ground)
  const violet = hex(COLOR.violet)
  const deep = hex(COLOR.violetDeep)
  const white = [245, 245, 247]

  const put = (x, y, [r, g, b]) => {
    const i = (y * width + x) * 4
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255
  }

  const blockW = Math.floor(width / 3)
  const barTop = Math.floor(height * 0.62)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // A hard-edged violet square on the brand ground: pure chroma edge.
      const inBlock =
        x > blockW && x < blockW * 2 && y > height * 0.15 && y < height * 0.55
      if (inBlock) { put(x, y, violet); continue }

      // Three flat bars along the bottom, so a colour shift is measurable
      // rather than a matter of opinion.
      if (y > barTop) {
        const third = Math.floor(x / (width / 3))
        put(x, y, third === 0 ? violet : third === 1 ? deep : white)
        continue
      }
      put(x, y, ground)
    }
  }
  return { width, height, data }
}

/* ------------------------------------------------------------- the matrix */

const SURFACES = [
  { id: 'x-header', source: 'x-header.png', w: 1500, h: 500, jpegQuality: 0.92 },
  { id: 'tiktok-avatar', source: 'avatar-400.png', w: 400, h: 400, jpegQuality: 0.92 },
]

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await launch({ width: 400, height: 400 })
  const written = []

  try {
    const page = await browser.newPage('data:text/html,<meta charset=utf-8>')
    await page.waitForLoad()

    for (const s of SURFACES) {
      const src = join(SOURCE, s.source)
      const px = await pixelsOf(page, src)

      // A - the control, copied so the set is self-contained.
      const a = join(OUT, `${s.id}-A-current.png`)
      writeFileSync(a, readFileSync(src))
      written.push([a, 'current renderer output, unchanged'])

      // B - our encoder, no metadata, alpha dropped.
      const b = join(OUT, `${s.id}-B-nodeenc.png`)
      writeFileSync(b, encodePng({ ...px, alpha: false }))
      written.push([b, 'identical pixels, our own PNG encoder, no metadata'])

      // C - our encoder, explicitly tagged sRGB (+ gAMA) and 72 DPI.
      const c = join(OUT, `${s.id}-C-srgb.png`)
      writeFileSync(c, encodePng({ ...px, alpha: false, srgb: true, dpi: 72 }))
      written.push([c, 'identical pixels, explicitly tagged sRGB + gAMA + 72dpi'])

      // D - high quality JPEG.
      const d = join(OUT, `${s.id}-D-jpeg92.jpg`)
      writeFileSync(d, await jpegOf(page, src, s.jpegQuality))
      written.push([d, `JPEG q${Math.round(s.jpegQuality * 100)} - pre-compressed by us, not them`])

      // E - a different pipeline end to end.
      const e = join(OUT, `${s.id}-E-reference.png`)
      writeFileSync(e, encodePng({ ...referenceRaster(s.w, s.h), alpha: false, srgb: true }))
      written.push([e, 'flat colour, hard edges, drawn in Node - shares nothing with the renderer'])
    }
  } finally {
    await browser.close()
  }

  console.log('\nDiagnostic set\n')
  for (const [path, why] of written) console.log(`  ${path}\n      ${why}`)
  console.log(`\n${written.length} files -> ${OUT}`)
  return 0
}

process.exit(await main())
