/**
 * Generate the social package from brand primitives.
 *
 *   node scripts/render-social.mjs            everything
 *   node scripts/render-social.mjs avatar     only assets whose id matches
 *
 * SOURCE, NOT ARTWORK.
 *
 * Every asset here is composed from assets/brand/tokens.mjs and the canonical
 * mark - the same pipeline that produces the extension icons, through the same
 * headless Chrome. Nothing is hand-composited, so changing the accent re-renders
 * the whole package correctly instead of leaving eleven files subtly off-brand.
 *
 * The templates are deliberately a small set of LAYOUTS reused at many sizes
 * rather than one bespoke design per platform. A profile avatar is the same
 * composition whether X, TikTok, Instagram or YouTube asked for it; what
 * differs is the pixel size and which safe area has to stay clear.
 *
 * SAFE AREAS ARE DATA, NOT VIBES.
 *
 * Each asset carries the platform's real constraint - YouTube's 1546x423
 * always-visible centre, TikTok's right-hand action rail, Instagram's Story
 * chrome - and the layout keeps content inside it. `--safe-*` custom properties
 * are set per asset so a template does not need to know which platform it is
 * serving.
 *
 * Output is gitignored (see *.png in .gitignore): these are derived files, and
 * the repository's convention is that derived artwork is reproducible from a
 * command rather than committed.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './cdp.mjs'
import { markSvg } from '../assets/brand/geometry.mjs'
import { COLOR, COPY, FONT, GRADIENT, GLOW, backdropCss } from '../assets/brand/tokens.mjs'

const OUT = 'assets/social/out'
const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'))

/* ------------------------------------------------------------------ pieces */

/*
 * The mark at a given CSS length.
 *
 * A LENGTH, not a number: the avatar, highlight and watermark layouts size the
 * mark as a percentage of their canvas so one template serves 150px and 800px
 * alike. Passing a number wrote an inline pixel width, and an inline style beats
 * the stylesheet - so those three rendered a 46px mark on a 400px avatar.
 */
const mark = (len) =>
  `<span class="mark" style="width:${len};height:${len}">${markSvg('full', { ground: false })}</span>`

const wordmark = (px) =>
  `<span class="wordmark" style="font-size:${px}px">${COPY.wordmark}</span>`

const lockup = (markPx, textPx) =>
  `<div class="lockup">${mark(markPx + 'px')}${wordmark(textPx)}</div>`

const tagline = (px, second = false) =>
  `<p class="tagline" style="font-size:${px}px">${COPY.primary}` +
  (second ? `<br><span class="tagline-2">${COPY.secondary}</span>` : '') +
  `</p>`

/* --------------------------------------------------------------- templates */

/** Profile avatar. Composed for a circular crop: nothing near the corners. */
const avatar = () => `
  <div class="stage avatar">
    <div class="ring"></div>
    ${mark('46%')}
  </div>`

/** Banner: lockup left, tagline under it, everything inside the safe area. */
const banner = (markPx, textPx, taglinePx) => `
  <div class="stage banner">
    <div class="safe">
      ${lockup(markPx, textPx)}
      ${tagline(taglinePx, true)}
    </div>
  </div>`

/** A post: a headline, the lockup small in a corner. Real copy, not lorem. */
const post = (headline, kicker, headlinePx) => `
  <div class="stage post">
    <div class="safe">
      ${kicker ? `<span class="kicker">${kicker}</span>` : ''}
      <h1 style="font-size:${headlinePx}px">${headline}</h1>
      <div class="foot">${lockup(44, 34)}<span class="domain">${COPY.domain}</span></div>
    </div>
  </div>`

/** Watermark / corner bug: the mark alone on transparency. */
const watermark = () => `<div class="stage bare">${mark('78%')}</div>`

/** Highlight cover: the mark centred in the circle Instagram crops to. */
const highlight = () => `
  <div class="stage highlight">
    <div class="circle">${mark('42%')}</div>
  </div>`

/* ------------------------------------------------------------------ assets */

/**
 * safe: inset in px [top, right, bottom, left] that platform UI covers.
 * Everything a viewer must read is laid out inside what is left.
 */
const ASSETS = [
  // ---- shared profile images -------------------------------------------
  { id: 'avatar-400', w: 400, h: 400, body: avatar, note: 'X · TikTok · Instagram' },
  { id: 'avatar-800', w: 800, h: 800, body: avatar, note: 'YouTube profile' },

  // ---- X / Twitter -------------------------------------------------------
  { id: 'x-header', w: 1500, h: 500, safe: [0, 0, 60, 380], body: () => banner(96, 76, 26),
    note: 'avatar overlaps lower-left' },
  { id: 'x-post', w: 1600, h: 900, body: () => post(COPY.primary, 'watchside', 96) },
  { id: 'x-feature', w: 1600, h: 900,
    body: () => post('Stream Rooms', 'new in watchside', 108) },

  // ---- TikTok ------------------------------------------------------------
  { id: 'tiktok-vertical', w: 1080, h: 1920, safe: [130, 120, 480, 0],
    body: () => post(COPY.primary, 'watchside', 92), note: 'right rail + caption' },
  { id: 'tiktok-cover', w: 1080, h: 1920, safe: [240, 0, 240, 0],
    body: () => post(COPY.secondary, 'watchside', 88), note: 'grid crop is centre 1080x1440' },
  { id: 'tiktok-bug', w: 240, h: 240, body: watermark, transparent: true },

  // ---- Instagram ---------------------------------------------------------
  { id: 'ig-square', w: 1080, h: 1080, body: () => post(COPY.primary, 'watchside', 84) },
  { id: 'ig-portrait', w: 1080, h: 1350, body: () => post(COPY.primary, 'watchside', 88) },
  { id: 'ig-story', w: 1080, h: 1920, safe: [250, 0, 340, 0],
    body: () => post(COPY.primary, 'watchside', 92), note: 'Story chrome' },
  { id: 'ig-highlight', w: 1080, h: 1920, body: highlight, note: 'centre 640 circle' },

  // ---- YouTube -----------------------------------------------------------
  { id: 'yt-banner', w: 2560, h: 1440, safe: [508, 507, 509, 507],
    body: () => banner(150, 120, 40), note: 'centre 1546x423 always visible' },
  { id: 'yt-watermark', w: 150, h: 150, body: watermark, transparent: true },
  { id: 'yt-thumbnail', w: 1280, h: 720, safe: [0, 0, 60, 0],
    body: () => post('See who’s watching', 'watchside', 104), note: 'timestamp overlap' },

  // ---- reusable ----------------------------------------------------------
  { id: 'square', w: 1080, h: 1080, body: () => post(COPY.primary, 'watchside', 84) },
  { id: 'landscape', w: 1600, h: 900, body: () => post(COPY.primary, 'watchside', 96) },
  { id: 'vertical', w: 1080, h: 1920, body: () => post(COPY.primary, 'watchside', 92) },
  { id: 'release', w: 1600, h: 900, body: () => post('Watchside 0.6', 'release', 112) },
  { id: 'feature', w: 1600, h: 900, body: () => post('Gravity', 'new in watchside', 120) },
]

/* ------------------------------------------------------------------- page */

function html(asset) {
  const [t, r, b, l] = asset.safe ?? [0, 0, 0, 0]
  const ground = asset.transparent ? 'background:transparent' : backdropCss()

  return `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="${FONT.webfont}">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:${asset.w}px;height:${asset.h}px;overflow:hidden}
  body{${ground};color:${COLOR.text};font-family:${FONT.body};
       --safe-t:${t}px;--safe-r:${r}px;--safe-b:${b}px;--safe-l:${l}px}
  .stage{width:${asset.w}px;height:${asset.h}px;display:grid;place-items:center;position:relative}
  .safe{position:absolute;inset:var(--safe-t) var(--safe-r) var(--safe-b) var(--safe-l);
        display:flex;flex-direction:column;justify-content:center;gap:2.2vh;
        padding:6% 7%}
  .mark{display:inline-grid;place-items:center;flex:0 0 auto}
  .mark svg{width:100%;height:100%;display:block;filter:drop-shadow(${GLOW})}
  .lockup{display:flex;align-items:center;gap:.34em}
  .wordmark{font-family:${FONT.display};font-weight:600;letter-spacing:-.035em;
            color:${COLOR.text};line-height:1}
  .tagline{font-family:${FONT.display};font-weight:500;line-height:1.35;
           color:${COLOR.violet};letter-spacing:-.01em}
  .tagline-2{color:${COLOR.dim}}
  .kicker{font-family:${FONT.body};font-weight:500;letter-spacing:.22em;
          text-transform:uppercase;color:${COLOR.violet};font-size:1.6vh}
  h1{font-family:${FONT.display};font-weight:700;letter-spacing:-.035em;line-height:1.02;
     text-wrap:balance;max-width:16ch}
  .foot{display:flex;align-items:center;gap:1.2em;margin-top:auto}
  .domain{font-family:${FONT.body};color:${COLOR.faint};font-size:1.7vh}
  /* Avatar: a violet ring, the mark centred, nothing in the corners. */
  .ring{position:absolute;inset:6%;border-radius:50%;
        background:${GRADIENT};opacity:.16}
  .avatar{background:${COLOR.surface};border-radius:50%}
  .highlight .circle{width:640px;height:640px;border-radius:50%;
        background:${COLOR.surface};border:6px solid ${COLOR.violetDim};
        display:grid;place-items:center}
</style>
${asset.body()}`
}

/* ------------------------------------------------------------------- main */

async function main() {
  const wanted = ASSETS.filter((a) => !filter.length || filter.some((f) => a.id.includes(f)))
  if (!wanted.length) {
    console.error(`No social asset matched ${JSON.stringify(filter)}`)
    return 1
  }

  mkdirSync(OUT, { recursive: true })
  const browser = await launch({ width: 1200, height: 1200 })

  try {
    for (const asset of wanted) {
      const page = await browser.newPage(
        'data:text/html;charset=utf-8,' + encodeURIComponent(html(asset)),
      )
      await page.waitForLoad()
      await page.setViewport(asset.w, asset.h)
      // Webfonts arrive after load; without this the first asset renders in the
      // fallback face and every later one does not, which is the worst outcome.
      await page.send('Runtime.evaluate', {
        expression: 'document.fonts.ready.then(() => true)',
        awaitPromise: true,
      })

      const shot = await page.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width: asset.w, height: asset.h, scale: 1 },
        captureBeyondViewport: true,
      })
      const file = join(OUT, `${asset.id}.png`)
      writeFileSync(file, Buffer.from(shot.data, 'base64'))
      console.log(
        `  ${asset.id.padEnd(18)} ${String(asset.w).padStart(4)}x${String(asset.h).padEnd(5)}` +
          (asset.note ? `  ${asset.note}` : ''),
      )
    }
  } finally {
    await browser.close()
  }

  console.log(`\n${wanted.length} asset(s) -> ${OUT}`)
  return 0
}

process.exit(await main())
