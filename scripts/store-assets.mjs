/**
 * Assemble, validate and preview the Store asset set.
 *
 *   npm run assets:store
 *
 * Takes what `npm run screenshots:store` captured, checks it against what each
 * store actually accepts, copies it into the committed location the owner
 * uploads from, and renders one contact sheet so the whole listing can be judged
 * as a set rather than a file at a time.
 *
 * WHY THESE PNGs ARE COMMITTED WHEN NO OTHER GENERATED IMAGE IS
 *
 * `.gitignore` ignores `*.png` on purpose: generated images are reproducible
 * from a script, so committing them is noise. It already carves out one
 * exception, for the brand icons, with the reason written beside it - a store
 * listing should not need a build to get a 512.
 *
 * Store screenshots need the same carve-out and have a stronger case. They are
 * NOT reproducible: they are photographs of live Twitch, and the streams behind
 * the panel are different every hour. Re-running the capture produces a
 * different picture, not the same one. If they are not committed, the set the
 * owner uploaded cannot be recovered, compared against, or re-uploaded after a
 * listing edit.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { launch } from './cdp.mjs'

const SOURCE = 'screenshots'
const OUT = join('assets', 'store', 'current')
const PROMO = join('assets', 'store', 'out', 'chrome-promo-440x280.png')
const AMO_HEADER = join('assets', 'store', 'out', 'amo-header-1400x560.png')

/**
 * The sequence, in the order the listing shows it.
 *
 * The order IS the argument: friends are watching -> jump in -> you are watching
 * together -> here is how the circle grows. A store visitor reads the first one
 * and decides; the rest are there to make the first one credible.
 */
const SEQUENCE = [
  {
    file: 'store-01-presence.png',
    beat: 'See where your friends are watching',
    why: 'Three friends on one channel, two elsewhere, all of it on Twitch. The core promise, before any interaction.',
  },
  {
    file: 'store-02-gravity-join.png',
    beat: 'Jump into the stream',
    why: 'Watching one channel while three friends have gathered on another, with JOIN on the gathering. The whole product in one picture.',
  },
  {
    file: 'store-03-together.png',
    beat: 'Watch together',
    why: 'After the JOIN: four friends here, the conversation open, reactions landing. Not a chat app - the chat is what happens once you arrive.',
  },
  {
    file: 'store-04-find-friends.png',
    beat: 'Find your Twitch friends',
    why: 'Suggestions from friends of friends, by mutual count, plus one durable invite link. How the circle grows.',
  },
]

/** Chrome Web Store, from the listing record in docs/checkpoints. */
const CHROME = { width: 1280, height: 800, max: 5 }

let failures = 0
const fail = (message) => {
  console.log(`  FAIL  ${message}`)
  failures += 1
}
const pass = (message) => console.log(`  ok    ${message}`)

/** PNG width and height, from the IHDR chunk. No dependency needed. */
function dimensions(file) {
  const buffer = readFileSync(file)
  if (buffer.toString('ascii', 1, 4) !== 'PNG') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

// ------------------------------------------------------------------ validate

console.log('Watchside Store assets\n')
console.log(`  sequence: ${SEQUENCE.length} screenshots (Chrome allows up to ${CHROME.max})\n`)

if (SEQUENCE.length > CHROME.max) fail(`${SEQUENCE.length} screenshots exceeds Chrome's limit`)

const seen = new Set()
for (const shot of SEQUENCE) {
  const path = join(SOURCE, shot.file)
  let size
  try {
    size = statSync(path).size
  } catch {
    fail(`${shot.file} has not been captured - run npm run screenshots:store`)
    continue
  }

  const dim = dimensions(path)
  if (!dim) {
    fail(`${shot.file} is not a PNG`)
    continue
  }
  if (dim.width !== CHROME.width || dim.height !== CHROME.height) {
    fail(`${shot.file} is ${dim.width}x${dim.height}, Chrome requires ${CHROME.width}x${CHROME.height}`)
  } else {
    pass(`${shot.file}  ${dim.width}x${dim.height}  ${(size / 1024).toFixed(0)} KB`)
  }

  /*
   * Two identical screenshots is a capture that silently failed - the harness
   * shot the same state twice because a prepare step did not take.
   */
  const digest = readFileSync(path).length
  if (seen.has(digest)) fail(`${shot.file} is byte-identical in size to an earlier shot - check the capture`)
  seen.add(digest)
}

for (const [label, file, expected] of [
  ['Chrome promo tile', PROMO, { width: 440, height: 280 }],
  ['AMO header', AMO_HEADER, { width: 1400, height: 560 }],
]) {
  try {
    const dim = dimensions(file)
    if (dim.width !== expected.width || dim.height !== expected.height) {
      fail(`${label} is ${dim.width}x${dim.height}, expected ${expected.width}x${expected.height}`)
    } else {
      pass(`${label}  ${dim.width}x${dim.height}`)
    }
  } catch {
    fail(`${label} is missing (${file})`)
  }
}

// -------------------------------------------------------------------- assemble

rmSync(OUT, { recursive: true, force: true })
for (const dir of ['chrome', 'firefox']) mkdirSync(join(OUT, dir), { recursive: true })

for (const shot of SEQUENCE) {
  for (const dir of ['chrome', 'firefox']) {
    copyFileSync(join(SOURCE, shot.file), join(OUT, dir, shot.file))
  }
}
copyFileSync(PROMO, join(OUT, 'chrome', 'chrome-promo-440x280.png'))
copyFileSync(AMO_HEADER, join(OUT, 'firefox', 'amo-header-1400x560.png'))

writeFileSync(
  join(OUT, 'SEQUENCE.md'),
  `# Store screenshot sequence\n\nGenerated by \`npm run assets:store\`. Upload in this order.\n\n` +
    SEQUENCE.map((s, i) => `${i + 1}. **${s.beat}** — \`${s.file}\`\n   ${s.why}\n`).join('\n') +
    `\nChrome and Firefox use the same sequence: the product story does not change` +
    ` between browsers, and a second set would be two things to keep in step.\n`,
  'utf8',
)
console.log(`\n  wrote ${OUT}/chrome and ${OUT}/firefox`)

// ---------------------------------------------------------------- contact sheet

/**
 * One image the whole listing can be judged from.
 *
 * A store visitor sees these as a strip, not as four separate files, and the
 * question "does this sequence make sense" cannot be answered one file at a
 * time. Rendered rather than composited by hand so it stays in step.
 */
const cards = SEQUENCE.map((shot, index) => {
  const data = readFileSync(join(SOURCE, shot.file)).toString('base64')
  return `<figure>
    <div class="n">${index + 1}</div>
    <img src="data:image/png;base64,${data}" alt="" />
    <figcaption><strong>${shot.beat}</strong><span>${shot.why}</span></figcaption>
  </figure>`
}).join('\n')

const sheet = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 40px; background: #0b0b0e; color: #f5f5f7;
         font-family: -apple-system, "Segoe UI", Roboto, sans-serif; width: 1500px; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.02em; }
  .sub { color: #9c9ca8; font-size: 14px; margin-bottom: 28px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; }
  figure { margin: 0; background: #131318; border: 1px solid #26262f;
           border-radius: 14px; overflow: hidden; position: relative; }
  .n { position: absolute; top: 12px; left: 12px; z-index: 2; width: 30px; height: 30px;
       border-radius: 999px; background: #9333ea; color: #fff; font-weight: 800;
       display: flex; align-items: center; justify-content: center; font-size: 15px; }
  img { display: block; width: 100%; }
  figcaption { padding: 14px 16px 18px; display: flex; flex-direction: column; gap: 5px; }
  figcaption strong { font-size: 16px; }
  figcaption span { color: #9c9ca8; font-size: 13px; line-height: 1.45; }
</style></head><body>
  <h1>Watchside — Store listing sequence</h1>
  <div class="sub">Chrome and Firefox, ${SEQUENCE.length} screenshots, 1280&times;800, in upload order.</div>
  <div class="grid">${cards}</div>
</body></html>`

/*
 * Written to a file and opened, rather than injected.
 *
 * The CDP helper exposes goto/evaluate/screenshot and no setContent, and a
 * file:// page is what the rest of this repository's rendering scripts use.
 */
const sheetFile = join(tmpdir(), `watchside-contact-${process.pid}.html`)
writeFileSync(sheetFile, sheet, 'utf8')

const browser = await launch({ width: 1500, height: 1200 })
try {
  const page = await browser.newPage(pathToFileURL(sheetFile).href)
  await new Promise((r) => setTimeout(r, 1_200))

  /*
   * The whole sheet, not the window.
   *
   * captureBeyondViewport renders past the fold, so the contact sheet is one
   * image however many screenshots the sequence grows to - rather than silently
   * cropping the last row the day a fifth is added.
   */
  const { contentSize } = await page.send('Page.getLayoutMetrics', {})
  const { data } = await page.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: {
      x: 0,
      y: 0,
      width: Math.ceil(contentSize.width),
      height: Math.ceil(contentSize.height),
      scale: 1,
    },
  })
  writeFileSync(join(OUT, 'contact-sheet.png'), Buffer.from(data, 'base64'))
  pass(`contact sheet  ${join(OUT, 'contact-sheet.png')}`)
} finally {
  await browser.close()
  rmSync(sheetFile, { force: true })
}

console.log(
  failures === 0
    ? '\nStore assets are valid and assembled.'
    : `\n${failures} asset problem(s) found.`,
)
process.exit(failures === 0 ? 0 : 1)
