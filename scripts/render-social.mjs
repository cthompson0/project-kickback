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
const STORE = 'assets/store/out'
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

/**
 * A post: kicker, headline, tagline, lockup - and the mark as a graphic.
 *
 * The first version of this template was a headline in one corner and a lockup
 * in the other with two thirds of the canvas empty between them. It read as an
 * unfinished template rather than a designed asset, and every format looked
 * like every other one.
 *
 * The mark, oversized and ghosted and bleeding off an edge, is what fills it.
 * That is the brand direction's own device rather than decoration borrowed from
 * somewhere else, and it costs nothing - it is the same geometry, at 6% opacity.
 */
const post = (headline, kicker, headlinePx, { tagline: sub = COPY.secondary } = {}) => `
  <div class="stage post">
    <span class="glyph">${markSvg('full', { ground: false })}</span>
    <div class="safe">
      <div class="block">
        ${kicker ? `<span class="kicker">${kicker}</span>` : ''}
        <h1 style="font-size:${headlinePx}px">${headline}</h1>
        ${sub ? `<p class="sub" style="font-size:${Math.round(headlinePx * 0.3)}px">${sub}</p>` : ''}
      </div>
      <div class="foot">${lockup(44, 34)}${COPY.domain ? `<span class="domain">${COPY.domain}</span>` : ''}</div>
    </div>
  </div>`

/**
 * A store promo tile.
 *
 * Small, and seen at thumbnail size in a grid of other extensions, so it is the
 * lockup and nothing else - no headline, no tagline. At 440x280 a sentence is
 * unreadable and only makes the mark smaller.
 */
const tile = (markPx, textPx) => `
  <div class="stage tile">
    <div class="tile-inner">${lockup(markPx, textPx)}</div>
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
  { id: 'x-header', w: 1500, h: 500, safe: [0, 0, 60, 380], body: () => banner(112, 92, 30),
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
  { id: 'ig-square', w: 1080, h: 1080,
    body: () => post('Your friends are already watching', 'watchside', 82) },
  { id: 'ig-portrait', w: 1080, h: 1350,
    body: () => post('See who’s watching', 'watchside', 92) },
  { id: 'ig-story', w: 1080, h: 1920, safe: [250, 0, 340, 0],
    body: () => post('Your friends are already watching', 'watchside', 88), note: 'Story chrome' },
  { id: 'ig-highlight', w: 1080, h: 1920, body: highlight, note: 'centre 640 circle' },

  // ---- YouTube -----------------------------------------------------------
  { id: 'yt-banner', w: 2560, h: 1440, safe: [508, 507, 509, 507],
    body: () => banner(190, 152, 46), note: 'centre 1546x423 always visible' },
  { id: 'yt-watermark', w: 150, h: 150, body: watermark, transparent: true },
  { id: 'yt-thumbnail', w: 1280, h: 720, safe: [0, 0, 60, 0],
    body: () => post('See who’s watching', 'watchside', 104), note: 'timestamp overlap' },

  // ---- store listings ----------------------------------------------------
  /*
   * Chrome requires the 440x280 small tile: without one, the listing is ranked
   * below extensions that have it. The larger marquee is optional and only used
   * for editorial features, so it is not generated here.
   *
   * AMO does not require a tile at all, but its listing renders a header image;
   * the same composition at Mozilla's size keeps the two stores telling one
   * story rather than two.
   */
  { id: 'chrome-promo-440x280', w: 440, h: 280, dir: STORE, body: () => tile(56, 44),
    note: 'CWS small promo tile (required)' },
  { id: 'amo-header-1400x560', w: 1400, h: 560, dir: STORE, body: () => tile(150, 118),
    note: 'AMO listing header' },

  // ---- reusable ----------------------------------------------------------
  { id: 'square', w: 1080, h: 1080, body: () => post(COPY.primary, 'watchside', 82) },
  { id: 'landscape', w: 1600, h: 900,
    body: () => post('Watch it together', 'watchside', 104) },
  { id: 'vertical', w: 1080, h: 1920,
    body: () => post('Jump in with one click', 'watchside', 94) },
  { id: 'release', w: 1600, h: 900, body: () => post('Watchside 0.6', 'release', 112) },
  { id: 'feature', w: 1600, h: 900, body: () => post('Gravity', 'new in watchside', 120) },
]

/* ------------------------------------------------------------------- page */

function html(asset) {
  const [t, r, b, l] = asset.safe ?? [0, 0, 0, 0]
  const ground = asset.transparent ? 'background:transparent' : backdropCss()
  // The glyph is placed differently in a 16:9 and a 9:16; the template asks
  // the canvas rather than each asset carrying a position.
  const shape = asset.w >= asset.h ? 'wide' : 'tall'

  return `<!doctype html><meta charset="utf-8"><body class="${shape}">
<link rel="stylesheet" href="${FONT.webfont}">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:${asset.w}px;height:${asset.h}px;overflow:hidden}
  body{${ground};color:${COLOR.text};font-family:${FONT.body};
       --safe-t:${t}px;--safe-r:${r}px;--safe-b:${b}px;--safe-l:${l}px}
  .stage{width:${asset.w}px;height:${asset.h}px;display:grid;place-items:center;position:relative}
  .safe{position:absolute;inset:var(--safe-t) var(--safe-r) var(--safe-b) var(--safe-l);
        display:flex;flex-direction:column;justify-content:center;
        padding:7% 7%;z-index:1}
  .block{display:flex;flex-direction:column;gap:.5em}
  /*
   * The mark as a graphic device: oversized, ghosted, bleeding off the edge.
   * Vertical formats put it low so it sits under the type; wide ones put it
   * right, where the composition was emptiest.
   */
  .glyph{position:absolute;display:block;opacity:.07;pointer-events:none}
  .glyph svg{width:100%;height:100%;display:block}
  body.wide .glyph{width:44%;height:auto;aspect-ratio:1;right:-4%;top:50%;transform:translateY(-50%)}
  body.tall .glyph{width:74%;height:auto;aspect-ratio:1;right:-16%;bottom:6%}
  .mark{display:inline-grid;place-items:center;flex:0 0 auto}
  .mark svg{width:100%;height:100%;display:block;filter:drop-shadow(${GLOW})}
  .lockup{display:flex;align-items:center;gap:.34em}
  .wordmark{font-family:${FONT.display};font-weight:600;letter-spacing:-.035em;
            color:${COLOR.text};line-height:1}
  .tagline{font-family:${FONT.display};font-weight:500;line-height:1.35;
           color:${COLOR.violet};letter-spacing:-.01em}
  .tagline-2{color:${COLOR.dim}}
  .kicker{font-family:${FONT.body};font-weight:600;letter-spacing:.28em;
          text-transform:uppercase;color:${COLOR.violet};font-size:1.9vh;
          margin-bottom:.4em}
  h1{font-family:${FONT.display};font-weight:700;letter-spacing:-.035em;line-height:1.02;
     text-wrap:balance;max-width:13ch}
  .sub{font-family:${FONT.display};font-weight:500;color:${COLOR.dim};
       letter-spacing:-.01em;margin-top:.25em}
  .foot{display:flex;align-items:center;gap:1.2em;position:absolute;
        left:7%;right:7%;bottom:7%}
  .domain{font-family:${FONT.body};color:${COLOR.faint};font-size:1.7vh}
  .tile{display:grid;place-items:center}
  .tile-inner{display:grid;place-items:center}
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

  for (const dir of new Set(wanted.map((a) => a.dir ?? OUT))) mkdirSync(dir, { recursive: true })
  const browser = await launch({ width: 1200, height: 1200 })

  try {
    for (const asset of wanted) {
      const page = await browser.newPage(
        'data:text/html;charset=utf-8,' + encodeURIComponent(html(asset)),
      )
      await page.waitForLoad()
      await page.setViewport(asset.w, asset.h)
      if (asset.transparent) {
        await page.send('Emulation.setDefaultBackgroundColorOverride', {
          color: { r: 0, g: 0, b: 0, a: 0 },
        })
      }
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
      const file = join(asset.dir ?? OUT, `${asset.id}.png`)
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
