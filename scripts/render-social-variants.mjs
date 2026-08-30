/**
 * Upload-hardening candidates for the two surfaces that artifact after upload.
 *
 *   node scripts/render-social-variants.mjs
 *
 * TEMPORARY, AND DELIBERATELY SEPARATE.
 *
 * This writes to assets/social/variants/ and touches nothing in the canonical
 * package. It exists to answer one question - which treatment survives X's and
 * TikTok's recompression - and should be deleted once the winner is folded back
 * into render-social.mjs.
 *
 * WHY THESE TWO SURFACES, AND WHAT IS ACTUALLY WRONG
 *
 * Measured rather than guessed. The current assets decode to:
 *
 *   x-header    mean luma 19.9, 85.1% of pixels in the darkest three luma
 *               buckets, average step between neighbouring pixels 1.4
 *   avatar-400  mean luma 34.3, MAXIMUM luma 114 - nothing in it is ever bright
 *
 * That is the worst case for a lossy re-encode. Quantisation error is a fixed
 * number of levels, so on an image whose entire content lives inside a twelve
 * level range it is proportionally enormous - smooth violet blooms across a
 * near-black field come back as bands and blotches. The mark's 60px glow is the
 * same problem in miniature: a very wide, very low amplitude halo is exactly
 * what mosquito noise forms around.
 *
 * So each variant below changes ONE thing and tests one hypothesis. None of
 * them alters the canonical brand: same mark, same violet, same wordmark.
 *
 * LOCAL RENDERING PROVES NOTHING HERE. The acceptance test is the uploaded
 * result. --screen re-encodes each candidate as JPEG locally and reports how
 * far it drifts, which is a pre-screen for ordering the uploads, not a verdict.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './cdp.mjs'
import { markSvg } from '../assets/brand/geometry.mjs'
import { COLOR, COPY, FONT, GRADIENT, GLOW, backdropCss } from '../assets/brand/tokens.mjs'

const OUT = 'assets/social/variants'
const screen = process.argv.includes('--screen')

/* ------------------------------------------------------------- ingredients */

const markSpan = (len, { glow = true, variant = 'full' } = {}) =>
  `<span class="mark${glow ? '' : ' noglow'}" style="width:${len};height:${len}">` +
  `${markSvg(variant, { ground: false })}</span>`

const lockup = (markPx, textPx, opts) =>
  `<div class="lockup">${markSpan(markPx + 'px', opts)}` +
  `<span class="wordmark" style="font-size:${textPx}px">${COPY.wordmark}</span></div>`

const tagline = (px) =>
  `<p class="tagline" style="font-size:${px}px">${COPY.primary}` +
  `<br><span class="tagline-2">${COPY.secondary}</span></p>`

const bannerBody = (opts) => `
  <div class="stage banner">
    <div class="safe">${lockup(112, 92, opts)}${tagline(30)}</div>
  </div>`

const avatarBody = (opts) => `
  <div class="stage avatar"><div class="ring"></div>${markSpan('46%', opts)}</div>`

/**
 * A fine dither, as an SVG feTurbulence overlay.
 *
 * Banding happens because a smooth ramp crosses a quantisation boundary in one
 * clean line. A pixel or two of noise moves that boundary around per-pixel, so
 * the encoder has nothing straight to draw a band along. It is imperceptible at
 * 1-2% opacity and is the standard fix for exactly this.
 */
const DITHER = `
  <svg class="dither" xmlns="http://www.w3.org/2000/svg">
    <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.85"
      numOctaves="2" stitchTiles="stitch"/></filter>
    <rect width="100%" height="100%" filter="url(#grain)"/>
  </svg>`

/* ---------------------------------------------------------------- variants */

const VARIANTS = [
  // ---- X / Twitter header, 1500x500 --------------------------------------
  {
    id: 'x-header-a-baseline', w: 1500, h: 500, safe: [0, 0, 60, 380],
    body: () => bannerBody(),
    why: 'unchanged - the control',
  },
  {
    id: 'x-header-b-dither', w: 1500, h: 500, safe: [0, 0, 60, 380],
    body: () => bannerBody(), dither: true,
    why: 'fine grain over the blooms, so banding has no straight edge to form along',
  },
  {
    id: 'x-header-c-lifted', w: 1500, h: 500, safe: [0, 0, 60, 380],
    body: () => bannerBody(), ground: '#16161d',
    why: 'ground lifted out of the crush zone, giving the encoder tonal headroom',
  },
  {
    id: 'x-header-d-flat', w: 1500, h: 500, safe: [0, 0, 60, 380],
    body: () => bannerBody(), flat: true,
    why: 'blooms removed entirely - nothing smooth left to band',
  },

  // ---- TikTok profile avatar ---------------------------------------------
  {
    id: 'tiktok-avatar-a-baseline', w: 400, h: 400,
    body: () => avatarBody(),
    why: 'unchanged - the control',
  },
  {
    id: 'tiktok-avatar-b-noglow', w: 400, h: 400,
    body: () => avatarBody({ glow: false }),
    why: 'the 60px halo removed - it is the widest, lowest-amplitude thing here',
  },
  {
    id: 'tiktok-avatar-c-solid', w: 400, h: 400,
    body: () => avatarBody({ glow: false, variant: 'small' }),
    why: 'the solid mark instead of the outlined one - mass survives downscaling, thin strokes do not',
  },
  {
    id: 'tiktok-avatar-d-800', w: 800, h: 800,
    body: () => avatarBody(),
    why: 'the baseline at double resolution, so TikTok resamples from more pixels',
  },
]

/* -------------------------------------------------------------------- page */

function html(v) {
  const [t, r, b, l] = v.safe ?? [0, 0, 0, 0]
  const ground = v.flat
    ? `background-color:${v.ground ?? COLOR.ground};` +
      `background-image:radial-gradient(rgba(255,255,255,0.055) 1px, transparent 1px);` +
      `background-size:26px 26px`
    : backdropCss()

  return `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="${FONT.webfont}">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:${v.w}px;height:${v.h}px;overflow:hidden}
  body{${ground};color:${COLOR.text};font-family:${FONT.body};
       ${v.ground && !v.flat ? `background-color:${v.ground};` : ''}
       --safe-t:${t}px;--safe-r:${r}px;--safe-b:${b}px;--safe-l:${l}px}
  .stage{width:${v.w}px;height:${v.h}px;display:grid;place-items:center;position:relative}
  .safe{position:absolute;inset:var(--safe-t) var(--safe-r) var(--safe-b) var(--safe-l);
        display:flex;flex-direction:column;justify-content:center;gap:2.2vh;padding:6% 7%}
  .mark{display:inline-grid;place-items:center;flex:0 0 auto}
  .mark svg{width:100%;height:100%;display:block;filter:drop-shadow(${GLOW})}
  .mark.noglow svg{filter:none}
  .lockup{display:flex;align-items:center;gap:.34em}
  .wordmark{font-family:${FONT.display};font-weight:600;letter-spacing:-.035em;
            color:${COLOR.text};line-height:1}
  .tagline{font-family:${FONT.display};font-weight:500;line-height:1.35;
           color:${COLOR.violet};letter-spacing:-.01em}
  .tagline-2{color:${COLOR.dim}}
  .avatar{background:${COLOR.surface};border-radius:50%}
  .ring{position:absolute;inset:6%;border-radius:50%;background:${GRADIENT};opacity:.16}
  .dither{position:absolute;inset:0;width:100%;height:100%;opacity:.022;
          pointer-events:none;mix-blend-mode:overlay}
</style>
${v.body()}${v.dither ? DITHER : ''}`
}

/* ------------------------------------------------------------------- main */

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await launch({ width: 1600, height: 1000 })
  const results = []

  try {
    for (const v of VARIANTS) {
      const page = await browser.newPage(
        'data:text/html;charset=utf-8,' + encodeURIComponent(html(v)),
      )
      await page.waitForLoad()
      await page.setViewport(v.w, v.h)
      await page.send('Runtime.evaluate', {
        expression: 'document.fonts.ready.then(() => true)', awaitPromise: true,
      })

      const shot = await page.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width: v.w, height: v.h, scale: 1 },
        captureBeyondViewport: true,
      })
      writeFileSync(join(OUT, `${v.id}.png`), Buffer.from(shot.data, 'base64'))

      let drift = null
      if (screen) drift = await prescreen(page, shot.data)
      results.push({ ...v, drift })
      console.log(
        `  ${v.id.padEnd(28)} ${String(v.w).padStart(4)}x${String(v.h).padEnd(4)}` +
          (drift === null ? '' : `  jpeg drift ${String(drift.meanDelta).padStart(5)}` +
            `  worst band ${String(drift.maxRun).padStart(4)}px`),
      )
    }
  } finally {
    await browser.close()
  }

  console.log(`\n${VARIANTS.length} candidate(s) -> ${OUT}`)
  console.log('\nWhat each one tests:')
  for (const v of results) console.log(`  ${v.id.padEnd(28)} ${v.why}`)
  if (screen) {
    console.log(
      '\nDrift is a LOCAL JPEG round-trip, not the platforms. It orders the\n' +
        'uploads; it does not decide them. Lower drift and shorter bands are better.',
    )
  }
  return 0
}

/**
 * Re-encode as JPEG in the page and measure what changed.
 *
 * A stand-in for the platforms, and an imperfect one - X and TikTok use their
 * own encoders, their own quality settings and their own resampling. What this
 * catches is the RELATIVE ordering: a variant that bands badly at q=0.72 here
 * is very unlikely to be the one that survives there.
 *
 * `maxRun` is the longest horizontal run of identical luma along the mid row,
 * which is what a band physically is.
 */
async function prescreen(page, b64) {
  const r = await page.send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src })
      const a = await load('data:image/png;base64,${b64}')
      const c = document.createElement('canvas'); c.width = a.width; c.height = a.height
      const x = c.getContext('2d'); x.drawImage(a, 0, 0)
      const b = await load(c.toDataURL('image/jpeg', 0.72))
      const c2 = document.createElement('canvas'); c2.width = a.width; c2.height = a.height
      const x2 = c2.getContext('2d'); x2.drawImage(b, 0, 0)
      const p = x.getImageData(0,0,c.width,c.height).data
      const q = x2.getImageData(0,0,c.width,c.height).data
      let sum = 0, n = 0
      for (let i = 0; i < p.length; i += 4) { sum += Math.abs(p[i]-q[i]) + Math.abs(p[i+1]-q[i+1]) + Math.abs(p[i+2]-q[i+2]); n += 3 }
      const row = Math.floor(c.height / 2)
      let run = 1, maxRun = 1, prev = -1
      for (let px = 0; px < c.width; px++) {
        const i = (row * c.width + px) * 4
        const L = Math.round(0.2126*q[i] + 0.7152*q[i+1] + 0.0722*q[i+2])
        if (L === prev) { run++; if (run > maxRun) maxRun = run } else run = 1
        prev = L
      }
      return { meanDelta: +(sum/n).toFixed(2), maxRun }
    })()`,
  })
  return r.result.value
}

process.exit(await main())
