/**
 * The three Chrome Web Store screenshots.
 *
 *   npm run screenshots:store
 *
 * Real Watchside, real Twitch, mock friends. The demo build is loaded as an
 * actual extension into an actual browser and pointed at actual twitch.tv, so
 * what comes out is a photograph of the product rather than a picture of a
 * mock-up: every pixel of the panel is the same React the beta ships, and
 * everything behind it is Twitch's own page.
 *
 * WHAT IS STAGED, AND WHAT IS NOT
 *
 * Staged: which channel the browser is on, which tab is open, where the panel
 * sits, and the fact that Twitch's consent and sign-up banners are dismissed.
 * All of that is what a person would have done before taking the screenshot
 * themselves.
 *
 * Not staged: anything about what Watchside draws. The friends, their channels,
 * the clustering, the JOIN buttons and the conversation all come from the demo
 * fixtures through the real components. Nothing is drawn for the camera.
 *
 * The DEMO badge stays visible on purpose. These are mock people, and the
 * screenshot should say so.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { launch } from './cdp.mjs'

const OUT = 'screenshots'
const WIDTH = 1280
const HEIGHT = 800

/**
 * Where the panel sits for the shots.
 *
 * Wider than the 320px default, because a store screenshot is looked at from
 * further away than a browser tab is - names and channels have to survive being
 * scaled into a listing thumbnail. Still well inside MAX_WIDTH, so this is a
 * size a user could choose, not a size only the camera can have.
 */
const LAYOUT = { v: 1, x: WIDTH - 400 - 24, y: 64, width: 400, height: 640, sized: false }

/**
 * The three channels, and nothing else.
 *
 * A product decision rather than a sample: these names appear in the store
 * listing, so they are fixed here and in src/mock/presenceService.ts, and this
 * script no longer picks a channel for itself. If one of them is offline the
 * shot is still taken and the limitation is reported - substituting somebody
 * else would quietly put a streamer nobody chose into the listing.
 *
 * The demo seeds three friends on GATHERING and one each on the other two, so
 * screenshots 2 and 3 are the same story either side of a JOIN: watching
 * ELSEWHERE while three friends are on GATHERING, then watching GATHERING with
 * them.
 */
const CHANNELS = {
  gathering: 'esl_sc2',
  elsewhere: 'summit1g',
  third: 'zchum',
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ------------------------------------------------------------- page cleanup

/**
 * Twitch's own overlays, dismissed the way a person would.
 *
 * The cookie banner and the sign-up bar are Twitch's, not ours, and both cover
 * a third of the page. Clicking them away is staging the photograph, not
 * changing the product.
 */
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

  // The bottom sign-up bar, and any dismissable promo, by their close controls.
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
   *
   * Found by its wording and then widened to whichever ancestor actually spans
   * the page - matching on geometry alone kept catching nothing, because the
   * element that is pinned to the bottom is not the element that carries the
   * text.
   *
   * Hidden rather than clicked, because there is nothing to click. It is the
   * one piece of Twitch chrome removed rather than dismissed, and it is removed
   * because it is an artefact of being signed out: a person taking this
   * screenshot would be signed in and would never see it.
   */
  const BAR_TEXT = /sign up to experience|join the twitch community|twitch is your oyster/i
  for (const element of document.querySelectorAll('body *')) {
    if (element.children.length > 0) continue
    if (!BAR_TEXT.test(element.textContent ?? '')) continue

    /*
     * The bar is the OUTERMOST ancestor that is still bar-shaped.
     *
     * Stopping at the first full-width one leaves its coloured container
     * behind as an empty strip; walking all the way up reaches the page. So
     * climb while the parent is still short, and hide the last one that was.
     */
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

// ------------------------------------------------------------ panel helpers

/*
 * Every function below is sent to the page as source and run there, so each one
 * has to be self-contained - a shared helper in this file simply does not exist
 * on the other side.
 */

/** Puts the panel where the shot wants it, before it first paints. */
function stageLayout(layout) {
  window.localStorage.setItem('kickback:layout', JSON.stringify(layout))
  window.localStorage.setItem('kickback:collapsed', '0')
  // The first-run nudge is real UI, but it is about learning to drag a panel
  // rather than about what Watchside does.
  window.localStorage.setItem('kickback:layout-hint-seen', '1')
  return true
}

function readPanel() {
  const root = document.getElementById('kickback-host')?.shadowRoot ?? null
  if (!root) return { mounted: false }
  const panel = root.querySelector('.kb-panel')
  if (!panel) return { mounted: false }

  const box = panel.getBoundingClientRect()
  return {
    mounted: true,
    rect: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
    demoBadge: Boolean(root.querySelector('.kb-demo-badge')),
    hint: Boolean(root.querySelector('.kb-hint')),
    tabs: [...root.querySelectorAll('.kb-tab')].map((tab) => tab.textContent.trim()),
    watching: root.querySelector('.kb-now-value')?.textContent?.trim() ?? null,
    cards: [...root.querySelectorAll('.kb-gravity-card')].map((card) => ({
      channel: card.querySelector('.kb-gravity-channel')?.textContent ?? '',
      count: card.querySelector('.kb-gravity-count')?.textContent ?? '',
      here: card.classList.contains('kb-gravity-card-here'),
      join: Boolean(card.querySelector('.kb-join')),
      people: [...card.querySelectorAll('.kb-cluster-name')].map((n) => n.textContent),
    })),
    /* Everything the panel currently says, so a debug string cannot slip past. */
    text: (panel.textContent ?? '').replace(/\s+/g, ' ').trim(),
  }
}

function dismissHint() {
  const close = document
    .getElementById('kickback-host')
    ?.shadowRoot?.querySelector('.kb-hint-close')
  close?.click()
  return Boolean(close)
}

function closeAnyCard() {
  const root = document.getElementById('kickback-host')?.shadowRoot ?? null
  if (!root?.querySelector('.kb-usercard')) return false
  root.querySelector('.kb-gravity-person .kb-person-btn')?.click()
  return true
}

/**
 * Open the Stream Room tab.
 *
 * It is labelled with the STREAMER's name rather than "Room" - deliberately, in
 * the product - so it cannot be found by its text the way the fixed tabs can.
 * The class is what identifies it.
 */
/**
 * Open the find-friends surface, where suggestions and the invite link live.
 *
 * The "+ Add" control beside the tabs. Found by its accessible name rather than
 * by position, because the label is deliberately short to survive the 280px
 * minimum width and the aria-label is the thing that actually says what it does.
 */
function openFindFriends() {
  const root = document.getElementById('kickback-host')?.shadowRoot ?? null
  const button =
    root?.querySelector('[aria-label="Add friends"]') ?? root?.querySelector('.kb-add-btn')
  button?.click()
  return Boolean(button)
}

function openSessionTab() {
  const root = document.getElementById('kickback-host')?.shadowRoot ?? null
  const tab = root?.querySelector('.kb-tab-session')
  tab?.click()
  return Boolean(tab)
}


/** Whether the channel page behind the panel is actually streaming. */
function readLiveState() {
  if (location.pathname.startsWith('/directory')) return 'directory'
  const live = document.querySelector('.live-indicator, [data-a-target="animated-channel-viewers-count"]')
  if (live) return 'live'
  return /offline|stream from|check out this/i.test(document.body.innerText.slice(0, 4000))
    ? 'offline'
    : 'unknown'
}

// ------------------------------------------------------------------- driver

async function shoot(browser, { file, channel, prepare }) {
  const page = await browser.newPage()
  await page.setViewport(WIDTH, HEIGHT)

  // Layout has to be in place before the panel's first paint, and localStorage
  // is per-origin - so it is written on Twitch, then the page is reloaded.
  const url = channel.startsWith('/') ? `https://www.twitch.tv${channel}` : `https://www.twitch.tv/${channel}`
  await page.goto(url, { waitMs: 6_000 })
  await page.evaluate(stageLayout, LAYOUT)
  await page.evaluate(dismissTwitchChrome)
  await page.goto(url, { waitMs: 9_000 })
  await page.evaluate(dismissTwitchChrome)
  await wait(1_500)
  await page.evaluate(dismissHint)
  await page.evaluate(closeAnyCard)

  if (prepare) await prepare(page)

  /*
   * One last pass over Twitch's own chrome.
   *
   * The sign-up callout is rendered late - after the first cleanup has already
   * run - so a single early pass reliably misses it.
   */
  await page.evaluate(dismissTwitchChrome)
  await wait(1_200)
  const panel = await page.evaluate(readPanel)
  // Whether Twitch itself was live behind the panel. Not something we control,
  // and worth reporting rather than discovering in the listing.
  panel.pageLive = await page.evaluate(readLiveState)
  await page.screenshot(`${OUT}/${file}`)

  return panel
}

async function main() {
  if (!existsSync('dist-demo')) {
    console.log('== Building the demo extension')
    execFileSync('npm', ['run', 'build:demo'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
  }
  mkdirSync(OUT, { recursive: true })

  const browser = await launch({ extension: 'dist-demo', width: WIDTH, height: HEIGHT })
  const report = []

  try {
    /*
     * 1 - PRESENCE. The viewer is not watching anything, so the panel is purely
     * "here is where everyone else is" - no HERE card competing for attention,
     * just people, channels, and who is merely around. This is what opening
     * Watchside looks like before you have decided anything.
     */
    report.push([
      'store-01-presence.png',
      await shoot(browser, { file: 'store-01-presence.png', channel: '/directory/all' }),
    ])

    /*
     * 2 - GRAVITY / JOIN. The hero. The viewer is watching one channel while
     * three friends have gathered on another, and JOIN sits on the gathering.
     * This is the whole product in one picture.
     */
    report.push([
      'store-02-gravity-join.png',
      await shoot(browser, { file: 'store-02-gravity-join.png', channel: CHANNELS.elsewhere }),
    ])

    /*
     * 3 - TOGETHER. The same story one step later: the viewer took that JOIN and
     * is now on the channel the gathering was on, watching it with them, with
     * the conversation open and the combo the product forms when several people
     * react at once.
     */
    report.push([
      'store-03-together.png',
      await shoot(browser, {
        file: 'store-03-together.png',
        channel: CHANNELS.gathering,
        prepare: async (page) => {
          /*
           * The roster stays COLLAPSED on purpose.
           *
           * Expanded it lists everyone including the friend-of-a-friend, which
           * is a lovely detail and takes most of the panel - the conversation
           * then gets a sliver and reads as cut off. Collapsed, the summary row
           * still says WATCHING TOGETHER with the faces beside it, and the chat
           * gets the room it needs. The screenshot has to say "watching
           * together" at a glance, not reward reading.
           */
          const opened = await page.evaluate(openSessionTab)
          await wait(1_200)
          if (!opened) {
            // Loudly, rather than quietly shipping the wrong story: without the
            // room the panel falls back to Friends and screenshot 3 stops being
            // about watching together at all.
            console.log('   WARNING  no Stream Room tab - is the demo fixture seeded?')
          }
        },
      }),
    ])

    /*
     * 4 - FIND FRIENDS. The story's last beat and the one the old set was
     * missing entirely: Watchside is worth more as your Twitch social graph
     * forms, and here is how it forms. Suggestions come from friends of the
     * people you already have, with the mutual COUNT and never the names.
     *
     * This is the surface M5A rebuilt, and no screenshot has ever shown it.
     */
    report.push([
      'store-04-find-friends.png',
      await shoot(browser, {
        file: 'store-04-find-friends.png',
        channel: CHANNELS.elsewhere,
        prepare: async (page) => {
          const opened = await page.evaluate(openFindFriends)
          await wait(1_200)
          if (!opened) {
            console.log('   WARNING  no Add friends control - the panel may not be signed in')
          }
          return opened
        },
      }),
    ])

  } finally {
    await browser.close()
  }

  console.log('')
  for (const [file, panel] of report) {
    console.log(`== ${file}`)
    if (!panel.mounted) {
      console.log('   PANEL DID NOT MOUNT')
      continue
    }
    console.log(`   rect      ${JSON.stringify(panel.rect)}`)
    console.log(`   watching  ${panel.watching}   twitch page: ${panel.pageLive}`)
    console.log(`   demo      ${panel.demoBadge}   hint ${panel.hint}`)
    for (const card of panel.cards) {
      console.log(
        `   card      ${card.channel} ${card.count}${card.here ? ' HERE' : ''}` +
          `${card.join ? ' JOIN' : ''}  ${card.people.join(', ')}`,
      )
    }
  }
}

await main()
