/**
 * The marketing capture set.
 *
 *   npm run capture:marketing
 *   npm run capture:marketing -- --headful --hold      (for screen recording)
 *
 * WHAT THIS IS, AND HOW IT DIFFERS FROM screenshots:store
 *
 * The Store set (scripts/store-screenshots.mjs) is a fixed listing asset: three
 * chosen channels that never move, 1280x800, committed. This is different work
 * with a different lifetime - Reddit, watchside.app, X, short-form - and two
 * things about it have to be different:
 *
 *   1. IT SHOWS THE TWITCH ENRICHMENT. The demo build has no backend, so it has
 *      no metadata, so every Social Gravity card falls back to the plain card:
 *      a letter monogram, a lowercase login, a count. That is honest and it is
 *      most of what the product no longer looks like. This run hands the demo
 *      build the REAL current records harvested from the production path.
 *
 *   2. THE CHANNELS ARE CHOSEN AT CAPTURE TIME. A marketing shot has to be
 *      taken against channels that are live today. The preference list below is
 *      an argument, not a fixture: whoever is live, in order, and the run says
 *      which it used.
 *
 * WHAT IS MOCK AND WHAT IS REAL
 *
 *   mock   the friends - Chris, Jake, Matt, Sarah - their names, their avatars,
 *          and which channel each is watching. Fixtures, always were.
 *   real   every Twitch fact: the display casing, the avatar, LIVE, the
 *          category, the stream title, the viewer count. Fetched at capture
 *          time by a real signed-in Watchside client through the production
 *          twitch-metadata Edge Function. Nothing is typed in here.
 *   real   Watchside itself. The demo extension is loaded into a real browser
 *          on real twitch.tv; every pixel of the panel is the React that ships.
 *
 * The DEMO badge and the "demo mode - mock data" footer stay visible. These are
 * mock people watching public Twitch channels, and the picture should say so.
 * Nothing here implies any streamer uses, endorses or has heard of Watchside.
 *
 * WHERE THE METADATA COMES FROM
 *
 * `.metadata-harvest.json`, written by `npm run metadata:harvest`, which drives
 * a real signed-in Watchside client and lets it fetch through the JWT-verified
 * `twitch-metadata` Edge Function exactly as ordinary use does.
 *
 * THIS SCRIPT HOLDS NO TWITCH CREDENTIAL. It cannot call Twitch and has no way
 * to. The Twitch secret stays where it already lives - server-side, in the Edge
 * Function - and the capture tooling never possesses it.
 *
 * Without a harvest the run STOPS rather than quietly producing the
 * metadata-free capture this exists to replace. `--allow-no-metadata` overrides
 * that for somebody who genuinely wants the plain shot.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { launch } from './cdp.mjs'
import { HARVEST_FILE } from './metadata-harvest.mjs'

/**
 * Where the set lands.
 *
 * `assets/marketing/current` is DELIBERATELY NOT `assets/store/current`, which
 * holds the approved v0.9 listing screenshots. Those were uploaded to two
 * stores and must stay recoverable; a marketing re-run must never be able to
 * overwrite them. `--out` sends a trial run somewhere else again.
 */
const DEFAULT_OUT = join('assets', 'marketing', 'current')

/**
 * The master frame.
 *
 * 1600x1000 CSS at 2x, so the PNG is 3200x2000. The CSS size is what decides
 * Twitch's layout and the panel's breakpoints, and 1600 is an ordinary desktop
 * width - the picture is of a normal browser, not of a stretched one. The scale
 * factor only decides how many pixels come out, and these images get cropped to
 * a square for Reddit, to 1200x628 for X, and to something tall for short-form.
 * Crop from a 3200px master, never from a 1280px one.
 */
const WIDTH = 1600
const HEIGHT = 1000
const SCALE = 2

/**
 * Where the panel sits.
 *
 * Wider and taller than the Store set's 400x640, because an enriched card
 * carries an avatar, a display name, a live badge, a category, a viewer count
 * and a title where the plain card carried a login and a number. At 400 wide
 * the title clamps to almost nothing and the whole point of the recapture is
 * lost. 440 is still well inside the panel's own MAX_WIDTH, so this is a size a
 * user could choose rather than a size only the camera can have.
 */
const LAYOUT = { v: 1, x: WIDTH - 440 - 28, y: 64, width: 440, height: 800, sized: false }

/**
 * The channels to try, in order.
 *
 * AN ARGUMENT, NOT A FIXTURE. Whoever is live when the run starts takes the
 * three roles below, and the run reports which. Override on the command line:
 *
 *   npm run capture:marketing -- --channels a,b,c,d,e
 *
 * The roles:
 *   gathering  where the friends have gathered. The JOIN destination, and the
 *              subject of the hero shot.
 *   elsewhere  where the viewer already is, so JOIN is a real choice between
 *              two things rather than the only card on screen.
 *   third      somewhere else again, so "they have all gathered in one place"
 *              is visibly a thing that happened rather than the only state.
 */
const DEFAULT_PREFERENCE = [
  'theburntpeanut',
  'sequisha',
  'heyyouvideogame',
  'cdnthe3rd',
  'grimmmz',
]

const argv = process.argv.slice(2)
const flag = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}
const has = (name) => argv.includes(`--${name}`)

const OUT = flag('out') ?? DEFAULT_OUT

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ----------------------------------------------------------- the harvest

/**
 * The records `npm run metadata:harvest` left behind.
 *
 * Read, not fetched. Everything about provenance is that script's business;
 * this one only checks the file is present, parseable and not so old that
 * "current" would be a lie.
 */
const HARVEST_MAX_AGE_MS = 30 * 60_000

function readHarvest() {
  if (!existsSync(HARVEST_FILE)) return null
  try {
    const parsed = JSON.parse(readFileSync(HARVEST_FILE, 'utf8'))
    const records = Array.isArray(parsed?.records) ? parsed.records : []
    if (records.length === 0) return null
    return { harvestedAt: Number(parsed.harvestedAt) || 0, records }
  } catch {
    return null
  }
}

// ------------------------------------------------------------ page helpers

/*
 * Everything below is sent to the page as source and runs there, so each one is
 * self-contained - a shared helper in this file does not exist on the far side.
 */

/** The capture state, written before the panel's first paint. */
function stageCapture(payload, layout) {
  window.localStorage.setItem('watchside:capture', JSON.stringify(payload))
  window.localStorage.setItem('kickback:layout', JSON.stringify(layout))
  window.localStorage.setItem('kickback:collapsed', '0')
  // Real UI, but it is about learning to drag a panel rather than about what
  // Watchside does.
  window.localStorage.setItem('kickback:layout-hint-seen', '1')
  return true
}

/** Twitch's own overlays, dismissed the way a person would before a screenshot. */
function dismissTwitchChrome() {
  const clicked = []
  const byText = (text) =>
    [...document.querySelectorAll('button')].find(
      (button) => button.textContent.trim().toLowerCase() === text,
    )

  for (const label of ['proceed', 'accept', 'i accept', 'start watching', 'continue']) {
    const button = byText(label)
    if (button) {
      button.click()
      clicked.push(label)
    }
  }

  for (const selector of [
    '[data-a-target="consent-banner-accept"]',
    '[data-a-target="content-classification-gate-overlay-start-watching-button"]',
    'button[aria-label*="Close" i]',
    'button[aria-label*="Dismiss" i]',
  ]) {
    for (const element of document.querySelectorAll(selector)) {
      element.click()
      clicked.push(selector)
    }
  }

  /*
   * The signed-out sign-up bar across the bottom, which has no close control.
   * Hidden rather than clicked because there is nothing to click, and it is an
   * artefact of being signed out - a person taking this shot would be signed in
   * and would never see it.
   */
  const BAR_TEXT = /sign up to experience|join the twitch community|twitch is your oyster/i
  for (const element of document.querySelectorAll('body *')) {
    if (element.children.length > 0) continue
    if (!BAR_TEXT.test(element.textContent ?? '')) continue
    let bar = element
    while (
      bar.parentElement &&
      bar.parentElement.getBoundingClientRect().height < 200 &&
      bar.parentElement !== document.body
    ) {
      bar = bar.parentElement
    }
    if (bar.getBoundingClientRect().height > 0) {
      bar.style.display = 'none'
      clicked.push('bottom bar')
    }
  }
  return clicked
}

function dismissHint() {
  const close = document.getElementById('kickback-host')?.shadowRoot?.querySelector('.kb-hint-close')
  close?.click()
  return Boolean(close)
}

function closeAnyCard() {
  const root = document.getElementById('kickback-host')?.shadowRoot ?? null
  if (!root?.querySelector('.kb-usercard')) return false
  root.querySelector('.kb-gravity-person .kb-person-btn')?.click()
  return true
}

function openSessionTab() {
  const root = document.getElementById('kickback-host')?.shadowRoot ?? null
  const tab = root?.querySelector('.kb-tab-session')
  tab?.click()
  return Boolean(tab)
}

/**
 * Everything the run needs to judge the shot without opening it.
 *
 * Deliberately more than the Store probe reports: this set exists BECAUSE the
 * enrichment was missing, so "did the enrichment actually arrive" is the
 * question, and it is answered per card - live badge, category, viewers, title,
 * and whether the avatar image really decoded rather than merely having a src.
 */
function readPanel() {
  const root = document.getElementById('kickback-host')?.shadowRoot ?? null
  if (!root) return { mounted: false }
  const panel = root.querySelector('.kb-panel')
  if (!panel) return { mounted: false }

  const text = (node, selector) => node.querySelector(selector)?.textContent?.trim() ?? null
  const box = panel.getBoundingClientRect()

  return {
    mounted: true,
    rect: {
      x: Math.round(box.x),
      y: Math.round(box.y),
      w: Math.round(box.width),
      h: Math.round(box.height),
      right: Math.round(box.right),
      bottom: Math.round(box.bottom),
    },
    viewport: { w: window.innerWidth, h: window.innerHeight },
    demoBadge: Boolean(root.querySelector('.kb-demo-badge')),
    /* The footer disclosure, read as text so a silent rewording is visible. */
    footer: text(root, '.kb-footer') ?? text(root, '.kb-panel-footer'),
    hint: Boolean(root.querySelector('.kb-hint')),
    userCard: Boolean(root.querySelector('.kb-usercard')),
    watching: text(root, '.kb-now-value'),
    session: Boolean(root.querySelector('.kb-session')),
    cards: [...root.querySelectorAll('.kb-gravity-card')].map((card) => {
      const img = card.querySelector('.kb-avatar-img')
      return {
        channel: text(card, '.kb-gravity-channel'),
        count: text(card, '.kb-gravity-count'),
        here: card.classList.contains('kb-gravity-card-here'),
        join: Boolean(card.querySelector('.kb-join')),
        live: Boolean(card.querySelector('.kb-live')),
        offline: Boolean(card.querySelector('.kb-offline-badge')),
        game: text(card, '.kb-gravity-game'),
        viewers: text(card, '.kb-gravity-viewers'),
        title: text(card, '.kb-gravity-title'),
        // A src is not a picture. naturalWidth is only non-zero once the bytes
        // arrived and decoded, which is the thing "no broken avatars" means.
        avatar: img ? { src: Boolean(img.getAttribute('src')), loaded: img.naturalWidth > 0 } : null,
        people: [...card.querySelectorAll('.kb-cluster-name')].map((n) => n.textContent.trim()),
      }
    }),
    /* Everything the panel says, so a debug string cannot slip past unseen. */
    text: (panel.textContent ?? '').replace(/\s+/g, ' ').trim(),
  }
}

/** Whether Twitch itself is streaming behind the panel, at capture time. */
function readLiveState() {
  if (location.pathname.startsWith('/directory')) return 'directory'
  const live = document.querySelector(
    '.live-indicator, [data-a-target="animated-channel-viewers-count"]',
  )
  if (live) return 'live'
  return /offline|stream from|check out this/i.test(document.body.innerText.slice(0, 4000))
    ? 'offline'
    : 'unknown'
}

// ------------------------------------------------------------------ driver

async function shoot(browser, payload, { file, channel, prepare }) {
  const page = await browser.newPage()
  await page.setViewport(WIDTH, HEIGHT, SCALE)

  const url = channel.startsWith('/')
    ? `https://www.twitch.tv${channel}`
    : `https://www.twitch.tv/${channel}`

  // The capture state has to be in place before the panel's first paint, and
  // localStorage is per-origin - so it is written on Twitch, then reloaded.
  await page.goto(url, { waitMs: 6_000 })
  await page.evaluate(stageCapture, payload, LAYOUT)
  await page.evaluate(dismissTwitchChrome)
  await page.goto(url, { waitMs: 10_000 })
  await page.evaluate(dismissTwitchChrome)
  await wait(2_000)
  await page.evaluate(dismissHint)
  await page.evaluate(closeAnyCard)

  if (prepare) await prepare(page)

  // Twitch renders its sign-up callout late, so a single early pass misses it.
  await page.evaluate(dismissTwitchChrome)
  // Long enough for Twitch avatars to have decoded, which the probe checks for.
  await wait(2_500)

  const panel = await page.evaluate(readPanel)
  panel.pageLive = await page.evaluate(readLiveState)
  await page.screenshot(join(OUT, file))
  return panel
}

// ------------------------------------------------------------------- report

function describe(file, panel) {
  console.log(`\n== ${file}`)
  if (!panel.mounted) {
    console.log('   PANEL DID NOT MOUNT')
    return
  }
  console.log(`   panel     ${JSON.stringify(panel.rect)}  viewport ${JSON.stringify(panel.viewport)}`)
  console.log(`   watching  ${panel.watching ?? '(nothing)'}   twitch page: ${panel.pageLive}`)
  console.log(`   demo      badge=${panel.demoBadge} footer=${JSON.stringify(panel.footer)}`)
  console.log(`   hint=${panel.hint} usercard=${panel.userCard} session=${panel.session}`)
  for (const card of panel.cards) {
    console.log(
      `   card      ${card.channel} | ${card.count}` +
        `${card.here ? ' | HERE' : ''}${card.join ? ' | JOIN' : ''}` +
        `${card.live ? ' | LIVE' : ''}${card.offline ? ' | OFFLINE' : ''}`,
    )
    console.log(
      `             game=${JSON.stringify(card.game)} viewers=${JSON.stringify(card.viewers)}` +
        ` avatar=${card.avatar ? `src:${card.avatar.src} loaded:${card.avatar.loaded}` : 'none'}`,
    )
    console.log(`             title=${JSON.stringify(card.title)}`)
    console.log(`             people=${card.people.join(', ') || '(none)'}`)
  }
}

// --------------------------------------------------------------------- main

async function main() {
  const preference = (flag('channels') ?? DEFAULT_PREFERENCE.join(','))
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)

  const harvest = readHarvest()
  let metadata = []

  if (harvest) {
    const ageMs = Date.now() - harvest.harvestedAt
    if (ageMs > HARVEST_MAX_AGE_MS) {
      console.error(`
  ${HARVEST_FILE} is ${Math.round(ageMs / 60_000)} minutes old.

  Live state and viewer counts go stale fast, and a capture showing a stale
  LIVE badge is worse than one showing none at all. Re-harvest:

    npm run metadata:harvest -- --channels ${preference.join(',')}
`)
      return 6
    }
    // Only the candidates this run cares about, in case the harvest is wider.
    metadata = harvest.records.filter((record) => preference.includes(record.login))
    console.log(`== Harvested metadata, ${Math.round(ageMs / 1000)}s old`)
    for (const record of metadata) {
      console.log(
        `   ${record.login.padEnd(18)} ${String(record.live).padEnd(7)}` +
          ` ${record.viewerCount ?? '-'} viewers  ${record.gameName ?? ''}`,
      )
    }
  } else if (has('allow-no-metadata')) {
    console.log('== No Twitch credentials; capturing WITHOUT enrichment (--allow-no-metadata)')
  } else {
    console.error(`
  No harvested metadata found (${HARVEST_FILE}).

  This capture set exists to show the Twitch enrichment the current product
  displays, and without it the run would produce exactly the metadata-free
  screenshots it is meant to replace. So it stops rather than doing that.

  Harvest first - this drives a real signed-in Watchside client and lets it
  fetch through the production twitch-metadata Edge Function, exactly as
  ordinary use does. No Twitch credential is needed or handled here:

    npm run metadata:harvest -- --channels ${preference.join(',')}

  To capture the plain, un-enriched panel anyway:
    npm run capture:marketing -- --allow-no-metadata
`)
    return 2
  }

  /*
   * The roles, filled by whoever is actually live.
   *
   * `live` is Twitch's answer, not ours: buildMetadata only says `live` when
   * Get Streams returned a row. An offline or unresolvable channel is skipped
   * and the next preference takes the role, which is the whole reason the list
   * is a preference rather than three constants.
   */
  const live = metadata.filter((record) => record.live === 'live').map((record) => record.login)
  const roles = ['gathering', 'elsewhere', 'third']

  if (metadata.length > 0 && live.length < roles.length) {
    console.error(
      `\n  Only ${live.length} of ${preference.length} candidate channels are live` +
        ` (${live.join(', ') || 'none'}).\n` +
        `  This set needs ${roles.length}. Pass more with --channels a,b,c,d,e.\n`,
    )
    return 3
  }

  /*
   * Roles from the channels Twitch says are live.
   *
   * Without metadata there is nothing to filter on, so the first three
   * preferences take the roles UNVERIFIED - which is fine for a trial run of
   * the harness and is exactly why that path prints a warning and is not the
   * default.
   */
  const assigned = metadata.length > 0 ? live : preference
  const channels = Object.fromEntries(roles.map((role, index) => [role, assigned[index]]))

  const chosen = new Set(Object.values(channels))
  const payload = {
    channels,
    // Only the three that are actually on screen. A record for a channel no
    // card shows is payload, not information.
    metadata: metadata.filter((record) => chosen.has(record.login)),
    steady: true,
  }

  console.log(`\n== Roles`)
  for (const role of roles) console.log(`   ${role.padEnd(10)} ${channels[role]}`)

  /*
   * ALWAYS REBUILT, and this is not belt-and-braces.
   *
   * The first trial run of this script silently produced the OLD story - the
   * default channels, the follower still drifting - because `dist-demo` already
   * existed from a previous week and the capture seam was not in it. Nothing
   * failed; the run reported success and the pictures were wrong, which is the
   * worst failure mode a capture tool has.
   *
   * A demo build takes about a second. Reusing a stale one has never once been
   * worth what it cost here. `--no-build` is for somebody who has just built it
   * and knows why.
   */
  if (!has('no-build')) {
    console.log('\n== Building the demo extension')
    execFileSync('npm', ['run', 'build:demo'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
  } else if (!existsSync('dist-demo')) {
    console.error('\n  --no-build, but dist-demo does not exist. Run `npm run build:demo`.\n')
    return 4
  }
  mkdirSync(OUT, { recursive: true })

  const headful = has('headful')
  const browser = await launch({ extension: 'dist-demo', width: WIDTH, height: HEIGHT, headful })
  const report = []

  try {
    /*
     * 1 - PRESENCE. The viewer is not watching anything, so nothing competes
     * with the answer to "where is everyone". The directory behind it is the
     * most unmistakably-Twitch page there is.
     */
    report.push([
      'marketing-01-presence.png',
      await shoot(browser, payload, {
        file: 'marketing-01-presence.png',
        channel: '/directory/all',
      }),
    ])

    /*
     * 2 - GRAVITY / JOIN. The hero, and the one likely to become the Reddit
     * creative. The viewer is on one channel while three friends have gathered
     * on another, and JOIN sits on the gathering. One picture, whole product.
     */
    report.push([
      'marketing-02-gravity-join.png',
      await shoot(browser, payload, {
        file: 'marketing-02-gravity-join.png',
        channel: channels.elsewhere,
      }),
    ])

    /*
     * 3 - HERE. The same story one step later: the viewer took that JOIN and is
     * now on the channel the gathering was on. The card that offered JOIN must
     * not still be offering it - you cannot join the stream you are watching -
     * and the probe checks exactly that.
     */
    report.push([
      'marketing-03-here.png',
      await shoot(browser, payload, {
        file: 'marketing-03-here.png',
        channel: channels.gathering,
      }),
    ])

    /*
     * 4 - WATCHING TOGETHER. The payoff with the conversation open. Separate
     * from 3 because HERE and the shared conversation are different beats: one
     * says "I found them", the other says "and now we are watching together".
     */
    report.push([
      'marketing-04-together.png',
      await shoot(browser, payload, {
        file: 'marketing-04-together.png',
        channel: channels.gathering,
        prepare: async (page) => {
          const opened = await page.evaluate(openSessionTab)
          await wait(1_500)
          if (!opened) console.log('   WARNING  no Stream Room tab - is the demo fixture seeded?')
        },
      }),
    ])

    if (headful && has('hold')) {
      console.log(`
== HOLDING. The browser is yours.

   The demo extension is loaded, the fixtures are staged, and the panel is
   where the captures put it. Drive it by hand and screen-record:

     1. open https://www.twitch.tv/${channels.elsewhere}
     2. the panel shows friends across channels
     3. the ${channels.gathering} card shows the gathering
     4. press JOIN - the tab really navigates
     5. the panel recognises HERE
     6. open the ${channels.gathering} tab for the conversation

   Ctrl-C here when you are done; the browser closes with it.
`)
      await new Promise(() => {})
    }
  } finally {
    if (!(headful && has('hold'))) await browser.close()
  }

  for (const [file, panel] of report) describe(file, panel)

  console.log(`\n== Wrote ${report.length} files to ${OUT}`)
  return 0
}

process.exitCode = await main()
