/**
 * Proves the Test Lab actually runs, in a real browser.
 *
 *   npm run verify:lab
 *
 * The vitest suites drive the lab's client and the production components
 * directly, which is where the Gravity acceptance is argued. They cannot
 * answer one question: does the page BOOT. A runtime error in the entry, a
 * network seal that strangles Vite's own module loading, a panel that throws
 * on mount - all of those leave every unit test green and the tool unusable.
 *
 * So this starts the real dev server, opens the real page, clicks the real
 * preset buttons and reads what the real panel drew.
 */
import { spawn } from 'node:child_process'
import { launch } from './cdp.mjs'

const PORT = 5199
const URL = `http://localhost:${PORT}/`

const failures = []
const fail = (message) => failures.push(message)
const check = (condition, message) => {
  if (!condition) fail(message)
}

async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(URL)
      if (response.ok) return
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`test lab dev server did not start on ${URL}`)
}

/** Everything the panel currently says about destinations. */
function readPanel() {
  const cards = [...document.querySelectorAll('.kb-gravity-card')]
  return {
    mounted: Boolean(document.querySelector('.kb-panel')),
    error: document.body.dataset.labError ?? null,
    cards: cards.map((card) => ({
      channel: card.querySelector('.kb-gravity-channel')?.textContent ?? '',
      count: Number(card.querySelector('.kb-gravity-count')?.textContent ?? '0'),
      flame: card.textContent.includes('🔥'),
      here: card.classList.contains('kb-gravity-card-here'),
      join: Boolean(card.querySelector('.kb-join')),
      people: [...card.querySelectorAll('.kb-cluster-name')].map((el) => el.textContent),
      live: Boolean(card.querySelector('.kb-live')),
      offline: Boolean(card.querySelector('.kb-offline-badge')),
      game: card.querySelector('.kb-gravity-game')?.textContent ?? null,
      viewers: card.querySelector('.kb-gravity-viewers')?.textContent ?? null,
      streamTitle: card.querySelector('.kb-gravity-title')?.textContent ?? null,
      avatar: Boolean(card.querySelector('.kb-gravity-avatar')),
      /* Whether anything overflows the card at the panel's narrowest. */
      overflows: card.scrollWidth > card.clientWidth + 1,
      /*
       * The room, from OUTSIDE it: a pulse and a doorway, and nothing else.
       *
       * The old card carried five reaction buttons and the roster. Both moved
       * inside, so what is probed here is as much about what is absent.
       */
      together: Boolean(card.querySelector('.kb-together')),
      reactionButtons: card.querySelectorAll('.kb-together-react, .kb-room-react-btn').length,
      roster: [...card.querySelectorAll('.kb-room-person .kb-cluster-name')].map((el) =>
        el.textContent.trim(),
      ),
      /*
       * The combo, on the RIGHT with the status and the viewer count.
       *
       * It used to sit on the left, where it competed with the destination and
       * the friends and shoved them around every time somebody sent an emote.
       * `comboOnLeft` is asserted to stay zero.
       */
      combos: [...card.querySelectorAll('.kb-gravity-combo')].map((el) => el.textContent.trim()),
      comboOnLeft: card.querySelectorAll('.kb-together .kb-gravity-combo, .kb-gravity-people .kb-gravity-combo').length,
      comboWidth: Math.round(
        card.querySelector('.kb-gravity-combo')?.getBoundingClientRect().width ?? 0,
      ),
      /*
       * Both gone: the permanent way in and its duplicate unread badge. The
       * contextual streamer tab is the persistent doorway and owns unread.
       */
      roomButton: Boolean(card.querySelector('.kb-together-open')),
      cardUnread: card.querySelector('.kb-together-unread')?.textContent?.trim() ?? null,
      /*
       * The signal, on its own line under the status - and NOT a control.
       *
       * It briefly carried a "Join Room →" button; real use showed the
       * invitation cost more attention than the thing it was inviting you to.
       * The streamer tab is the doorway, and it is always there.
       */
      cta: card.querySelector('.kb-gravity-cta') !== null,
      comboIsControl: card.querySelector('button.kb-gravity-combo, a.kb-gravity-combo') !== null,
      comboOnOwnLine: card.querySelector('.kb-gravity-activity .kb-gravity-combo') !== null,
      comboBelowStatus: (() => {
        const status = card.querySelector('.kb-gravity-status')
        const combo = card.querySelector('.kb-gravity-combo')
        if (!status || !combo) return false
        return combo.getBoundingClientRect().top >= status.getBoundingClientRect().bottom - 1
      })(),
      /* The row must not grow when a reaction lands. */
      barHeight: Math.round(
        card.querySelector('.kb-together')?.getBoundingClientRect().height ?? 0,
      ),
      cardHeight: Math.round(card.getBoundingClientRect().height),
    })),
    /*
     * The tab bar, which is where the session lives now.
     *
     * It used to be a view that replaced the Friends map; that fixed the
     * disclosure triangle and cost the social radar. `session` here is the
     * contextual streamer tab: its label, its unread, and whether it is the
     * one selected.
     */
    tabs: [...document.querySelectorAll('.kb-tab')].map((el) => ({
      label: el.textContent.trim(),
      streamer: el.querySelector('.kb-tab-streamer')?.textContent?.trim() ?? null,
      title: el.getAttribute('title'),
      active: el.classList.contains('kb-tab-active'),
      badge: el.querySelector('.kb-tab-badge')?.textContent?.trim() ?? null,
      /* Whether the label overflowed its box rather than the row. */
      clipped: (() => {
        const name = el.querySelector('.kb-tab-streamer')
        return name ? name.scrollWidth > name.clientWidth : false
      })(),
    })),
    tabsWidth: (() => {
      const bar = document.querySelector('.kb-tabs')
      return bar ? Math.round(bar.scrollWidth - bar.clientWidth) : 0
    })(),
    /* The session itself, once its tab is selected. */
    session: {
      open: Boolean(document.querySelector('.kb-session')),
      mapVisible: Boolean(document.querySelector('.kb-gravity')),
      channel: document.querySelector('.kb-session-channel')?.textContent?.trim() ?? null,
      count: document.querySelector('.kb-session-count')?.textContent?.trim() ?? null,
      tabActive: Boolean(document.querySelector('.kb-tab-session.kb-tab-active')),
      live: Boolean(document.querySelector('.kb-session-sub .kb-live')),
      liveColor: (() => {
        const dot = document.querySelector('.kb-session-sub .kb-live-dot')
        return dot ? getComputedStyle(dot).backgroundColor : null
      })(),
      rosterOpen: Boolean(document.querySelector('.kb-room-people')),
      people: [...document.querySelectorAll('.kb-room-people .kb-cluster-name')].map((el) =>
        el.textContent.trim(),
      ),
      via: [...document.querySelectorAll('.kb-room-via')].map((el) => el.textContent.trim()),
      messages: [...document.querySelectorAll('.kb-chat-log .kb-msg')].map((el) =>
        el.textContent.trim(),
      ),
      composer: Boolean(document.querySelector('.kb-composer-input')),
      maxLength: document.querySelector('.kb-composer-input')?.getAttribute('maxlength') ?? null,
      /* The permanent five-button strip is gone; the picker is the one way. */
      quickButtons: document.querySelectorAll('.kb-session-react-btn').length,
      picker: Boolean(document.querySelector('.kb-emote-toggle')),
      combos: [...document.querySelectorAll('.kb-combo-active-count')].map((el) =>
        el.textContent.trim(),
      ),
      pulses: document.querySelectorAll('.kb-session-pulse').length,
      aboveComposer: document.querySelectorAll('.kb-session-activity').length,
      broken: document.querySelectorAll('.kb-combo-broken').length,
    },
    quiet: [...document.querySelectorAll('.kb-section-label')].map((el) => el.textContent),
    events: [...document.querySelectorAll('.lab-log li strong')].map((el) => el.textContent),
    joins: [...document.querySelectorAll('.lab-log-join li')].map((el) => el.textContent),
  }
}

/**
 * Makes a simulated person react, through the lab's own controls.
 *
 * The lab's buttons carry the reaction id in their title, because a Kickback
 * emote renders as inline SVG and has no text to match on.
 */
function labReact(index, reaction) {
  const rows = [...document.querySelectorAll('.lab-users .lab-row')].filter((row) =>
    [...row.querySelectorAll('button')].some((b) => (b.title ?? '').includes(reaction)),
  )
  const row = rows[index]
  if (!row) throw new Error('no room control for person ' + index)
  const button = [...row.querySelectorAll('button')].find((b) => (b.title ?? '').includes(reaction))
  button.click()
  return true
}

/**
 * Opens the session from the HERE card's affordance.
 *
 * Idempotent, because a preset change leaves the panel wherever it was: if the
 * session is already up, the doorway is not rendered and clicking it would
 * throw.
 */
/**
 * Opens the session.
 *
 * Through the contextual streamer tab, because that is the persistent doorway
 * now - the card's permanent ROOM button is gone, and its combo CTA exists
 * only while something is actually happening.
 */
function openRoom() {
  if (document.querySelector('.kb-session')) return true
  const tab = document.querySelector('.kb-tab-session')
  if (!tab) throw new Error('no contextual streamer tab')
  tab.click()
  return true
}

/** Opens it from the tab instead, which is the other way in. */
function openSessionTab() {
  const tab = document.querySelector('.kb-tab-session')
  if (!tab) throw new Error('no contextual streamer tab')
  tab.click()
  return true
}

/** Back to the radar. Tabs are the way out; there is no back button. */
function leaveRoom() {
  const tabs = [...document.querySelectorAll('.kb-tab')]
  const friends = tabs.find((el) => el.textContent.trim().startsWith('Friends'))
  if (!friends) throw new Error('no Friends tab')
  friends.click()
  return true
}

/**
 * Sends an emote from the session, through the picker.
 *
 * There is no quick-reaction strip any more, so this is the only way a person
 * sends an emote - and it is the path that was broken: the picker inserts the
 * emote and the composer sends it as a message.
 */
function openPicker() {
  const toggle = document.querySelector('.kb-emote-toggle')
  if (!toggle) throw new Error('no emote picker on the composer')
  if (!document.querySelector('.kb-emote-btn')) toggle.click()
  return true
}

/**
 * Picks an emote. Sending is a separate step on purpose: the draft is React
 * state, so the send button is still reading the previous render until the
 * page has had a chance to re-render - clicking both in one go sends nothing.
 */
function pickEmote(index = 0) {
  const emotes = [...document.querySelectorAll('.kb-emote-btn')]
  if (!emotes[index]) throw new Error('the picker offered no emotes')
  emotes[index].click()
  return true
}

function clickSend() {
  const send = [...document.querySelectorAll('.kb-send')].pop()
  if (!send) throw new Error('no send button')
  if (send.disabled) throw new Error('the composer had nothing to send')
  send.click()
  return true
}

/** Expands the compact participant row. */
function openRoster() {
  const button = document.querySelector('.kb-session-people')
  if (!button) throw new Error('no participant row')
  if (button.getAttribute('aria-expanded') !== 'true') button.click()
  return true
}

/** Makes a simulated person say something, through the lab's own controls. */
function labSay(index, kind) {
  const rows = [...document.querySelectorAll('.lab-users .lab-row')].filter((row) =>
    [...row.querySelectorAll('button')].some((b) => (b.textContent ?? '').trim() === kind),
  )
  const row = rows[index]
  if (!row) throw new Error('no say control for person ' + index)
  const button = [...row.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === kind,
  )
  button.click()
  return true
}

/** Types into the session composer and sends. */
function sendInSession(text) {
  const input = document.querySelector('.kb-composer-input')
  if (!input) throw new Error('no composer in the session')
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  ).set
  setter.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  const send = [...document.querySelectorAll('.kb-send')].pop()
  if (!send) throw new Error('no send button')
  send.click()
  return true
}

/** Clicks a preset by its visible label. */
function clickPreset(label) {
  const button = [...document.querySelectorAll('.lab-presets button')].find(
    (el) => el.textContent.trim() === label,
  )
  if (!button) throw new Error(`no preset button labelled "${label}"`)
  button.click()
  return true
}

/**
 * Open the user card from a Social Gravity member and measure it.
 *
 * The regression this exists for was invisible to every unit test: the popup
 * is `position: absolute; left: 6px; right: 6px`, so its width comes from its
 * containing block, and Gravity anchored it to a flex item the width of one
 * avatar. Only a layout engine can say what that produced - ~78px, with the
 * display name ellipsised to "Anot...".
 */
function openMemberCard() {
  const member = document.querySelector('.kb-gravity-person .kb-person-btn')
  if (!member) throw new Error('no Gravity member to click')
  member.click()
  return true
}

function readUserCard() {
  const card = document.querySelector('.kb-usercard')
  if (!card) return null

  const name = card.querySelector('.kb-usercard-name')
  const panel = document.querySelector('.kb-panel')

  return {
    width: Math.round(card.getBoundingClientRect().width),
    panelWidth: Math.round(panel.getBoundingClientRect().width),
    name: name?.textContent ?? '',
    /* Ellipsised text is wider than its box. This is how the browser is asked
       whether "AnoterosTV" actually fits, rather than whether it is present. */
    nameClipped: name ? name.scrollWidth > name.clientWidth + 1 : true,
    handle: card.querySelector('.kb-handle')?.textContent ?? '',
    actions: card.querySelectorAll('.kb-usercard-actions .kb-ghost-btn, .kb-usercard-actions a').length,
    /*
     * Controls stacking one-per-line is what "looks broken" actually meant.
     *
     * Counted by CLUSTERING tops rather than by distinct values: a <button>
     * and an <a> on the same visual line sit a pixel apart, so exact
     * comparison reports three rows for a row of three that fits perfectly
     * well. The chat wrap gate merges line boxes the same way, for the same
     * reason.
     */
    actionRows: [...card.querySelectorAll('.kb-usercard-actions > *')]
      .map((el) => el.getBoundingClientRect().top)
      .sort((a, b) => a - b)
      .reduce((rows, top) => (rows.length && top - rows[rows.length - 1] < 6 ? rows : [...rows, top]), [])
      .length,
    overflowsPanel:
      card.getBoundingClientRect().right > panel.getBoundingClientRect().right + 1,
  }
}

/**
 * Whether anything underneath the user card is still reaching the screen.
 *
 * Asked of the browser rather than of the stylesheet, because the defect this
 * exists for passed every CSS assertion we had. The card's background really
 * was opaque; it was being clipped away by the scrolling body it lived in, so
 * the names and handles behind it stayed plainly readable. "Is the background
 * opaque" was the wrong question. "Is the card what you actually see" is the
 * right one, and only a real browser can answer it.
 *
 * A grid of points across the card, each one asking what is painted on top.
 * Every answer must be part of the card.
 */
function cardCoverage() {
  const card = document.querySelector('.kb-usercard')
  if (!card) return { error: 'no user card is open' }

  const panel = document.querySelector('.kb-panel')
  const box = card.getBoundingClientRect()
  const bounds = panel.getBoundingClientRect()

  const bleeding = []
  for (let row = 0; row < 10; row += 1) {
    for (let column = 0; column < 6; column += 1) {
      const x = box.x + (box.width * (column + 0.5)) / 6
      const y = box.y + (box.height * (row + 0.5)) / 10
      const top = document.elementsFromPoint(x, y)[0]
      if (top && card.contains(top)) continue
      bleeding.push(top ? String(top.className || top.tagName) : 'nothing')
    }
  }

  return {
    points: 60,
    bleeding: bleeding.length,
    through: [...new Set(bleeding)].slice(0, 4),
    escapesPanel:
      Math.round(box.bottom - bounds.bottom) > 1 ||
      Math.round(bounds.top - box.top) > 1 ||
      Math.round(box.right - bounds.right) > 1 ||
      Math.round(bounds.left - box.left) > 1,
  }
}

/** Gives the panel a height a user would have dragged it to. */
function growPanel(height) {
  const panel = document.querySelector('.kb-panel')
  panel.style.setProperty('--kb-w', '320px')
  panel.style.setProperty('--kb-h', `${height}px`)
  panel.classList.add('kb-panel-filled')
  return Math.round(panel.getBoundingClientRect().height)
}

/** Back to the height the panel picks for itself, and the default width. */
function shrinkPanel() {
  const panel = document.querySelector('.kb-panel')
  panel.classList.remove('kb-panel-filled')
  panel.style.removeProperty('--kb-h')
  panel.style.setProperty('--kb-w', '320px')
  return Math.round(panel.getBoundingClientRect().height)
}

/** The card is a toggle, so nothing may assume which way a click will go. */
function closeAnyCard() {
  const open = document.querySelector('.kb-usercard')
  if (!open) return false
  document.querySelector('.kb-gravity-person .kb-person-btn')?.click()
  return true
}

/** Collapses the panel to the launcher, through its own control. */
function minimize() {
  const button = [...document.querySelectorAll('.kb-icon-btn')].find(
    (element) => element.title === 'Minimize Kickback',
  )
  button?.click()
  return Boolean(button)
}

/** Where the launcher is, and whether the panel is open behind it. */
function readShell() {
  const launcher = document.querySelector('.kb-launcher')
  const rect = launcher?.getBoundingClientRect()
  return {
    launcher: rect ? { x: Math.round(rect.x), y: Math.round(rect.y) } : null,
    panelOpen: Boolean(document.querySelector('.kb-panel')),
    stored: window.localStorage.getItem('kickback:layout'),
  }
}

/** Puts the lab back the way it was found. */
function resetShell() {
  window.localStorage.removeItem('kickback:layout')
  window.localStorage.removeItem('kickback:collapsed')
}

function clickJoin() {
  const join = document.querySelector('.kb-gravity-card .kb-join')
  if (!join) throw new Error('no JOIN button on the top destination')
  join.click()
  return true
}

const settle = (page, ms = 250) => page.evaluate((wait) => new Promise((r) => setTimeout(r, wait)), ms)

async function main() {
  // Vite's own entry, run by node directly: no shell, so this behaves the
  // same on Windows as it does anywhere else.
  const server = spawn(
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      '-c',
      'vite.testlab.config.ts',
      '--port',
      String(PORT),
      '--strictPort',
    ],
    { stdio: 'ignore', env: { ...process.env, KB_LAB_NO_OPEN: '1' } },
  )

  let browser
  try {
    await waitForServer()

    browser = await launch({ width: 1600, height: 1000 })
    const page = await browser.newPage()

    // A page that throws on mount must fail here rather than quietly render
    // nothing, so the error is captured before anything else is asserted.
    await page.evaluate(() => {
      window.addEventListener('error', (event) => {
        document.body.dataset.labError = String(event.message)
      })
    })

    await page.goto(URL, { waitMs: 1_500 })

    const initial = await page.evaluate(readPanel)
    check(initial.mounted, 'the Kickback panel did not mount in the Test Lab')
    check(!initial.error, `the lab page threw on load: ${initial.error}`)

    // --- Gravity acceptance, through the real UI -------------------------

    const sizes = [
      ['1 friend watching', 1, false],
      ['2-friend Gravity', 2, true],
      ['3-friend Gravity', 3, true],
      ['5-friend Gravity', 5, true],
      ['10-friend stress', 10, true],
    ]

    for (const [label, size, flame] of sizes) {
      await page.evaluate(clickPreset, label)
      await settle(page)
      const view = await page.evaluate(readPanel)

      check(view.cards.length === 1, `${label}: expected one destination, got ${view.cards.length}`)
      const card = view.cards[0] ?? {}
      check(card.count === size, `${label}: count read ${card.count}, expected ${size}`)
      check(card.channel === 'LIRIK', `${label}: channel read "${card.channel}"`)
      check(card.flame === flame, `${label}: flame ${card.flame}, expected ${flame}`)
      check(card.join === true, `${label}: no JOIN offered`)
      check(
        card.people.length === size && new Set(card.people).size === size,
        `${label}: drew ${card.people.length} people (${new Set(card.people).size} distinct)`,
      )
    }

    // --- ranking, HERE, and a live move ----------------------------------

    await page.evaluate(clickPreset, 'Two competing clusters')
    await settle(page)
    const competing = await page.evaluate(readPanel)
    check(
      competing.cards.map((card) => card.count).join(',') === '3,2',
      `competing clusters ranked ${competing.cards.map((c) => `${c.channel}:${c.count}`).join(' ')}`,
    )

    // Move one person across, through the lab's own control, and watch the
    // real panel re-rank without a reload.
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.lab-users .lab-row')]
      const channel = rows[0].querySelector('.lab-channel')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set
      setter.call(channel, 'xQc')
      channel.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle(page, 400)
    const moved = await page.evaluate(readPanel)
    check(
      moved.cards[0]?.channel === 'xQc' && moved.cards[0]?.count === 3,
      `after moving one person the top card was ${moved.cards[0]?.channel}:${moved.cards[0]?.count}`,
    )

    await page.evaluate(clickPreset, 'Watching with you')
    await settle(page)
    const here = await page.evaluate(readPanel)
    check(here.cards[0]?.here === true, 'watching-with-you did not produce a HERE card')
    check(here.cards[0]?.join === false, 'HERE card offered a JOIN to where the viewer already is')
    check(here.cards[0]?.count === 3, `HERE counted ${here.cards[0]?.count}, expected 3`)

    // --- privacy ---------------------------------------------------------

    await page.evaluate(clickPreset, 'Privacy mix')
    await settle(page)
    const privacy = await page.evaluate(readPanel)
    check(privacy.cards.length === 1, 'privacy mix should leave exactly one destination')
    check(privacy.cards[0]?.count === 1, 'a hidden friend contributed to a destination')
    check(
      privacy.quiet.some((label) => label.startsWith('Around')),
      'the friend hiding their activity did not appear as Around',
    )
    check(
      privacy.quiet.some((label) => label.startsWith('Offline')),
      'the invisible friend did not appear as Offline',
    )

    // --- metadata -------------------------------------------------------

    await page.evaluate(clickPreset, 'Live creator')
    await settle(page)
    const liveCard = (await page.evaluate(readPanel)).cards[0] ?? {}
    check(liveCard.live === true, 'live creator drew no LIVE badge')
    check(liveCard.avatar === true, 'live creator drew no avatar')
    check(liveCard.game === 'Escape from Tarkov', `category read "${liveCard.game}"`)
    check(liveCard.viewers === '18K', `viewers read "${liveCard.viewers}"`)
    check(Boolean(liveCard.streamTitle), 'live creator drew no title')
    check(liveCard.count === 3, 'metadata changed the friend count')
    check(liveCard.join === true, 'metadata removed the JOIN')

    await page.evaluate(clickPreset, 'Offline creator')
    await settle(page)
    const offlineView = await page.evaluate(readPanel)
    check(
      offlineView.cards[0]?.channel === 'xQc' && offlineView.cards[0]?.live === true,
      'an ended stream was not demoted below a live one',
    )
    check(
      offlineView.cards[1]?.offline === true && offlineView.cards[1]?.count === 3,
      'the ended destination lost its mark or its friends',
    )
    check(offlineView.cards[1]?.join === true, 'the ended destination lost its JOIN')

    await page.evaluate(clickPreset, 'Metadata unavailable')
    await settle(page)
    const unavailable = await page.evaluate(readPanel)
    check(
      unavailable.cards[0]?.live === false && unavailable.cards[0]?.offline === false,
      'an unavailable answer was drawn as though it were an answer',
    )
    check(unavailable.cards[0]?.count === 3, 'the plain card lost its friends')

    await page.evaluate(clickPreset, 'Authoritative casing')
    await settle(page)
    check(
      (await page.evaluate(readPanel)).cards[0]?.channel === 'LVNDMARK',
      'metadata did not supply the authoritative casing',
    )

    /*
     * The narrowest panel a user can produce, with the longest text a creator
     * can write. Nothing may overflow the card - which is a layout question,
     * so it is measured rather than asserted from CSS.
     */
    await page.evaluate(clickPreset, 'Long title + category')
    await settle(page)
    await page.evaluate(() => {
      const panel = document.querySelector('.kb-panel')
      panel.style.setProperty('--kb-w', '260px')
    })
    await settle(page, 300)
    const narrow = await page.evaluate(readPanel)
    check(narrow.cards[0]?.overflows === false, 'a long title or category overflowed the card')
    check(narrow.cards[0]?.join === true, 'a long title pushed JOIN off the card')

    // --- the card outside the session ------------------------------------

    await page.evaluate(clickPreset, 'Room · A↔B')
    await settle(page)

    const together = (await page.evaluate(readPanel)).cards[0] ?? {}
    check(together.here === true, 'the card did not become the HERE card')
    check(together.join === false, 'the HERE card still offered a JOIN')
    check(together.count === 1, `room counted ${together.count} friends, expected 1`)
    /*
     * The permanent ROOM button is gone, and so is its unread badge.
     *
     * It was a second, always-present way into a session the streamer tab
     * already offers, and it announced one waiting message twice in the same
     * panel.
     */
    check(together.roomButton === false, 'the permanent ROOM button is back on the card')
    check(together.cardUnread === null, 'the card is drawing a duplicate unread badge')
    check(together.cta === false, 'a Join Room CTA is back on the card')

    /*
     * Both older shapes, asserted as absences.
     *
     * First the card carried five reaction buttons and a roster, which made
     * the social map a thing to operate. Then the room became a view that
     * replaced the map, which cost the radar. Either coming back fails here.
     */
    check(
      together.reactionButtons === 0,
      `the card still carries ${together.reactionButtons} reaction buttons`,
    )
    check(
      together.roster.length === 0,
      `the card listed the room's people: ${JSON.stringify(together.roster)}`,
    )
    check(together.combos.length === 0, 'a combo appeared before anybody did anything')

    // --- the contextual streamer tab --------------------------------------

    const bar = await page.evaluate(readPanel)
    const sessionTab = bar.tabs.find((t) => t.streamer !== null)
    check(Boolean(sessionTab), 'no contextual streamer tab while a session exists')
    check(
      sessionTab?.streamer === 'LIRIK',
      `tab read "${sessionTab?.streamer}", expected the authoritative casing LIRIK`,
    )
    check(sessionTab?.active === false, 'the session tab selected itself when it appeared')
    check(
      bar.tabs.some((t) => t.label.startsWith('Friends') && t.active),
      'Friends was not still the selected tab',
    )
    check(bar.session.open === false, 'the session opened without being asked')
    check(bar.cards.length === 1, 'the map disappeared while Friends was selected')

    // The affordance on the card selects the tab.
    await page.evaluate(openRoom)
    await settle(page, 300)
    const opened = await page.evaluate(readPanel)
    check(opened.session.open === true, 'ROOM did not open the session')
    check(opened.session.mapVisible === false, 'the session did not take the body')
    check(
      opened.tabs.find((t) => t.streamer !== null)?.active === true,
      'ROOM opened a session without selecting its tab',
    )
    check(
      opened.session.count === 'WATCHING TOGETHER · 2',
      `the session says "${opened.session.count}" for the viewer plus one other`,
    )
    check(opened.session.composer === true, 'the session has no composer')
    check(
      opened.session.maxLength === '280',
      `composer capped at ${opened.session.maxLength}, expected 280`,
    )
    check(
      opened.session.quickButtons === 0,
      `the permanent quick-reaction strip is back: ${opened.session.quickButtons} buttons`,
    )
    check(
      opened.session.aboveComposer === 0,
      'the lone-emote lane above the composer is back',
    )
    check(opened.session.picker === true, 'the composer lost its emote picker')
    check(
      opened.session.people.length === 0,
      'the participant list was expanded before anybody asked',
    )

    // And the tab is the way back to the radar.
    await page.evaluate(leaveRoom)
    await settle(page, 300)
    const back = await page.evaluate(readPanel)
    check(back.session.open === false, 'Friends did not leave the session')
    check(back.cards.length === 1, 'Friends did not restore the map')
    check(
      back.cards[0].here === true && back.cards[0].count === together.count,
      'the HERE card did not survive the round trip',
    )

    // The tab itself is the other way in.
    await page.evaluate(openSessionTab)
    await settle(page, 300)
    check(
      (await page.evaluate(readPanel)).session.open === true,
      'the streamer tab did not open the session',
    )

    // --- the conversation -------------------------------------------------

    await page.evaluate(labSay, 0, 'say')
    await settle(page, 300)
    const said = (await page.evaluate(readPanel)).session
    check(said.messages.length === 1, `expected one message, saw ${said.messages.length}`)
    check(
      said.messages[0].includes('Bianca'),
      `the message did not name its sender: ${said.messages[0]}`,
    )

    await page.evaluate(sendInSession, 'and one from me')
    await settle(page, 300)
    const both = (await page.evaluate(readPanel)).session
    check(both.messages.length === 2, `expected two messages, saw ${both.messages.length}`)
    check(
      both.messages.some((m) => m.includes('and one from me')),
      'the viewer\'s own message did not appear',
    )

    // --- one combo stream, over reactions AND emote-only messages ---------

    await page.evaluate(clickPreset, 'Room · A↔B')
    await settle(page)
    await page.evaluate(openRoom)
    await settle(page, 8500)

    await page.evaluate(labSay, 0, ':lol:')
    await settle(page, 300)
    const one = await page.evaluate(readPanel)
    check(one.session.combos.length === 0, 'a single emote was drawn as a combo')
    /*
     * One emote, one representation.
     *
     * It appeared twice before: as the message, and again on its own above the
     * input. A lone emote is a thing one person did and the conversation
     * already carries it.
     */
    check(one.session.pulses === 0, 'a lone emote was echoed above the composer')
    check(one.session.aboveComposer === 0, 'the activity lane above the composer is back')

    /*
     * The viewer answers with the SAME emote, chosen from the picker.
     *
     * This is the path that was broken: an emote from the picker used to reach
     * the room as the bare word, render as text and count for nothing.
     */
    await page.evaluate(openPicker)
    await settle(page, 200)
    await page.evaluate(pickEmote, 0)
    await settle(page, 200)
    await page.evaluate(clickSend)
    await settle(page, 400)
    const combo = (await page.evaluate(readPanel)).session
    check(
      combo.messages.some((m) => !m.includes(':lol:')),
      'an emote sent from the picker rendered as its token rather than artwork',
    )
    check(combo.combos[0] === '×2', `combo read "${combo.combos[0]}", expected ×2`)

    /*
     * The same run, extended by an emote-only MESSAGE.
     *
     * A reaction is an emote and an emote-only message is the same emote sent
     * the slow way, so they collide on one run. Two combo engines would show
     * two numbers here.
     */
    await page.evaluate(clickPreset, 'Room · A↔B')
    await settle(page)
    await page.evaluate(openRoom)
    // Long enough that everything above has left the activity window, so the
    // run below starts from nothing.
    await settle(page, 9000)
    // Bianca REACTS and the viewer answers with the same emote as a MESSAGE.
    // Different event kinds, different people, one run.
    await page.evaluate(labReact, 0, 'lol')
    await settle(page, 200)
    await page.evaluate(openPicker)
    await settle(page, 200)
    await page.evaluate(pickEmote, 0)
    await settle(page, 200)
    await page.evaluate(clickSend)
    await settle(page, 400)
    const merged = (await page.evaluate(readPanel)).session
    check(
      merged.combos[0] === '×2',
      `a reaction and an emote message read "${merged.combos[0]}", expected ×2`,
    )

    // Text does not contribute - it ENDS a run.
    await page.evaluate(labSay, 0, 'say')
    await settle(page, 300)
    const ended = (await page.evaluate(readPanel)).session
    check(ended.combos.length === 0, 'text extended a combo instead of closing it')

    // --- what leaks outward, and for how long -----------------------------

    await page.evaluate(clickPreset, 'Room · A↔B')
    await settle(page)
    await page.evaluate(openRoom)
    await settle(page, 8500)
    await page.evaluate(labSay, 0, ':lol:')
    await settle(page, 200)
    await page.evaluate(openPicker)
    await settle(page, 200)
    await page.evaluate(pickEmote, 0)
    await settle(page, 200)
    await page.evaluate(clickSend)
    await settle(page, 400)
    await page.evaluate(leaveRoom)
    await settle(page, 300)

    const outside = (await page.evaluate(readPanel)).cards[0] ?? {}
    check(
      outside.combos[0]?.includes('×2'),
      `the card showed "${outside.combos[0]}" for a ×2 combo in the session`,
    )
    check(outside.cta === false, 'the Join Room invitation is back')
    check(outside.comboIsControl === false, 'the combo became a control again')
    check(outside.comboOnOwnLine === true, 'the combo is not on its own activity line')
    check(outside.comboBelowStatus === true, 'the combo is not below LIVE and the viewer count')
    check(
      outside.comboOnLeft === 0,
      'the combo is on the left, competing with the destination and the friends',
    )
    check(
      outside.comboWidth > 0 && outside.comboWidth < 70,
      `the combo is ${outside.comboWidth}px wide; it is a mark, not a banner`,
    )

    await settle(page, 8500)
    const after = await page.evaluate(readPanel)
    const faded = after.cards[0] ?? {}
    check(faded.combos.length === 0, 'an expired combo stayed on the card')
    check(faded.comboOnOwnLine === false, 'the activity line outlived its combo')
    /*
     * And the session itself is untouched. Existence is persistent while
     * people are co-present; the CTA is ephemeral while something is
     * happening. That distinction is the whole point of having both.
     */
    check(
      after.tabs.some((t) => t.streamer !== null),
      'the contextual tab left with the combo',
    )

    // --- unread -----------------------------------------------------------

    await page.evaluate(labSay, 0, 'say')
    await page.evaluate(labSay, 0, 'say')
    await settle(page, 400)
    const waiting = await page.evaluate(readPanel)
    /*
     * One waiting message, one badge.
     *
     * It used to be announced twice - on the streamer tab AND on a ROOM button
     * beside it. Unread is content waiting for you and belongs to the tab; the
     * card's job is the live signal.
     */
    check(
      waiting.tabs.find((t) => t.streamer !== null)?.badge === '2',
      'the streamer tab did not carry the unread count',
    )
    check(
      waiting.cards[0]?.cardUnread === null,
      `the card duplicated the unread badge: "${waiting.cards[0]?.cardUnread}"`,
    )

    await page.evaluate(openRoom)
    await settle(page, 400)
    await page.evaluate(leaveRoom)
    await settle(page, 400)
    const read = await page.evaluate(readPanel)
    check(
      read.tabs.find((t) => t.streamer !== null)?.badge === null,
      'looking at the session did not clear unread',
    )

    // A reaction is activity, not something waiting.
    await page.evaluate(labReact, 0, 'fire')
    await settle(page, 300)
    const reacted = await page.evaluate(readPanel)
    check(
      reacted.tabs.find((t) => t.streamer !== null)?.badge === null,
      'a reaction incremented the message unread',
    )

    /*
     * And a SINGLE emote never reaches the card.
     *
     * Combos only: one person sending something belongs in the conversation,
     * and the card outside is for noticing that several people agree at once.
     */
    await page.evaluate(clickPreset, 'Room · A↔B')
    await settle(page)
    await settle(page, 8500)
    await page.evaluate(labSay, 0, ':lol:')
    await settle(page, 400)
    const lone = (await page.evaluate(readPanel)).cards[0] ?? {}
    check(
      lone.combos.length === 0,
      `a single emote leaked onto the card: ${JSON.stringify(lone.combos)}`,
    )
    check(lone.comboOnOwnLine === false, 'a single emote drew an activity line')

    /*
     * And the tab is the only way in.
     *
     * There is nothing on the card to click: a permanent ROOM button and then
     * a Join Room invitation both lived here, and both are gone. The combo
     * says something is happening; the tab is how you go there.
     */
    await page.evaluate(clickPreset, 'Room · A↔B')
    await settle(page)
    await settle(page, 9000)
    await page.evaluate(openRoom)
    await settle(page, 300)
    await page.evaluate(labSay, 0, ':lol:')
    await settle(page, 200)
    await page.evaluate(openPicker)
    await settle(page, 200)
    await page.evaluate(pickEmote, 0)
    await settle(page, 200)
    await page.evaluate(clickSend)
    await settle(page, 400)
    await page.evaluate(leaveRoom)
    await settle(page, 300)

    const signal = await page.evaluate(readPanel)
    check(signal.cards[0]?.combos[0]?.includes('×2'), 'no combo on the card to look at')
    check(signal.cards[0]?.comboIsControl === false, 'the combo is clickable')
    check(signal.session.open === false, 'the session opened by itself')

    // The tab still works, and is still not selected on its own.
    check(
      signal.tabs.find((t) => t.streamer !== null)?.active === false,
      'the streamer tab selected itself',
    )
    await page.evaluate(openSessionTab)
    await settle(page, 300)
    check(
      (await page.evaluate(readPanel)).session.open === true,
      'the streamer tab did not open the session',
    )
    await page.evaluate(leaveRoom)
    await settle(page, 200)

    // One person hammering a button is not a combo.
    await page.evaluate(clickPreset, 'Room · A↔B')
    await settle(page)
    await settle(page, 8500)
    for (let i = 0; i < 4; i += 1) await page.evaluate(labReact, 0, 'fire')
    await settle(page, 300)
    const burst = (await page.evaluate(readPanel)).cards[0] ?? {}
    check(
      burst.combos.length === 0,
      'one person pressing a button repeatedly formed a combo: ' + JSON.stringify(burst.combos),
    )

    // --- a session does NOT need a stream ---------------------------------
    //
    // Requiring one meant a broadcast ending ended the conversation around it.
    // Live status is a label and an analytics gate now; people are the session.

    await page.evaluate(clickPreset, 'Room · stream ended')
    await settle(page)
    const ended2 = await page.evaluate(readPanel)
    check(ended2.cards[0]?.here === true, 'the offline destination lost its card')
    check(ended2.cards[0]?.offline === true, 'the OFFLINE label went missing')
    check(ended2.cards[0]?.people.length === 1, 'presence stopped reporting who is here')
    check(ended2.cards[0]?.roomButton === false, 'the permanent ROOM button is back')
    check(
      ended2.tabs.some((t) => t.streamer !== null),
      'an offline stream took the contextual tab away',
    )

    // And the conversation still works there.
    await page.evaluate(openRoom)
    await settle(page, 300)
    const offlineSession = (await page.evaluate(readPanel)).session
    check(offlineSession.open === true, 'the session would not open on an offline channel')
    check(offlineSession.composer === true, 'the composer went missing on an offline channel')
    check(offlineSession.live === false, 'an offline channel claimed to be LIVE')
    await page.evaluate(leaveRoom)
    await settle(page, 200)

    await page.evaluate(clickPreset, 'Room · Twitch has not answered')
    await settle(page)
    const unsure = await page.evaluate(readPanel)
    check(
      unsure.tabs.some((t) => t.streamer !== null),
      'a session waited on a metadata answer that may never come',
    )

    await page.evaluate(clickPreset, 'Room · just went live')
    await settle(page)
    const relit = await page.evaluate(readPanel)
    check(
      relit.tabs.some((t) => t.streamer !== null),
      'the session tab went missing once the stream was live',
    )
    check(
      relit.tabs.find((t) => t.streamer !== null)?.active === false,
      'the tab selected itself',
    )

    // --- the graphs two Twitch accounts cannot build ---------------------

    await page.evaluate(clickPreset, 'Room · A↔B↔C')
    await settle(page)
    await page.evaluate(openRoom)
    await page.evaluate(openRoster)
    await settle(page, 300)
    const chain = (await page.evaluate(readPanel)).session
    check(
      chain.people.length === 3,
      `A↔B↔C session held ${chain.people.length} people including the viewer, expected 3`,
    )
    check(
      chain.via.some((text) => text.startsWith('Friend of')),
      `no connecting-friend context for the two-hop person: ${JSON.stringify(chain.via)}`,
    )

    await page.evaluate(clickPreset, 'Room · two clusters')
    await settle(page)
    await page.evaluate(openRoom)
    await page.evaluate(openRoster)
    await settle(page, 300)
    const split = (await page.evaluate(readPanel)).session
    check(
      split.people.length === 2,
      `an unrelated cluster leaked in: ${JSON.stringify(split.people)}`,
    )

    await page.evaluate(clickPreset, 'Room · clusters merged')
    await settle(page)
    await page.evaluate(openRoom)
    await page.evaluate(openRoster)
    await settle(page, 300)
    const merged2 = (await page.evaluate(readPanel)).session
    check(
      merged2.people.length === 4,
      `merged session held ${merged2.people.length} people including the viewer, expected 4`,
    )

    await page.evaluate(clickPreset, 'Room · bridge left')
    await settle(page)
    const bridged = await page.evaluate(readPanel)
    check(
      bridged.cards.every((card) => card.together === false),
      'the doorway survived the bridge leaving',
    )
    check(bridged.session.open === false, 'the session survived its own membership emptying')
    check(
      bridged.tabs.every((t) => t.streamer === null),
      'the contextual tab survived the room emptying',
    )

    await page.evaluate(clickPreset, 'Room · unrelated stranger')
    await settle(page)
    await page.evaluate(openRoom)
    await page.evaluate(openRoster)
    await settle(page, 300)
    const stranger = (await page.evaluate(readPanel)).session
    check(
      stranger.people.length === 2,
      `a stranger on the same stream joined the session: ${JSON.stringify(stranger.people)}`,
    )

    // Ten in a chain at the narrowest panel: three hops, and it still fits.
    await page.evaluate(clickPreset, 'Room · 10 people')
    await settle(page)
    await page.evaluate(openRoom)
    await page.evaluate(openRoster)
    await page.evaluate(() => {
      document.querySelector('.kb-panel').style.setProperty('--kb-w', '260px')
    })
    await settle(page, 300)
    const tight = (await page.evaluate(readPanel)).session
    check(tight.picker === true, 'the emote picker was lost at 260px')
    check(
      tight.people.length === 4,
      `the hop limit let ${tight.people.length - 1} people in, expected 3`,
    )

    /*
     * A long streamer name must not break the tab row.
     *
     * Truncation is CSS, so the label clips inside its own box and the bar
     * does not scroll - and the full name is still in the title attribute.
     */
    await page.evaluate(leaveRoom)
    const narrowTabs = await page.evaluate(readPanel)
    const long = narrowTabs.tabs.find((t) => t.streamer !== null)
    check(narrowTabs.tabsWidth <= 1, `the tab row overflowed by ${narrowTabs.tabsWidth}px at 260px`)
    check(long?.title === 'LIRIK', 'the tab lost the full streamer name from its title')

    await page.evaluate(() => {
      document.querySelector('.kb-panel').style.removeProperty('--kb-w')
    })
    await settle(page, 200)

    // --- LIVE is red ------------------------------------------------------

    await page.evaluate(clickPreset, 'Together · live metadata')
    await settle(page)
    await page.evaluate(openRoom)
    await settle(page, 300)
    const lit = (await page.evaluate(readPanel)).session
    check(lit.live === true, 'a live session did not say LIVE')
    check(
      lit.liveColor === 'rgb(233, 25, 22)',
      `the LIVE dot is ${lit.liveColor}, expected the semantic red rgb(233, 25, 22)`,
    )
    await page.evaluate(leaveRoom)
    await settle(page, 200)

    // --- the user card opened from a Gravity member ----------------------

    await page.evaluate(clickPreset, '5-friend Gravity')
    await settle(page)
    await page.evaluate(openMemberCard)
    await settle(page, 300)

    const card = await page.evaluate(readUserCard)
    check(card !== null, 'clicking a Gravity member opened no user card')
    if (card) {
      check(
        card.width >= 200,
        `user card from Gravity was ${card.width}px wide (panel ${card.panelWidth}px)`,
      )
      check(!card.nameClipped, `display name was clipped: "${card.name}"`)
      check(Boolean(card.handle), 'user card showed no @handle')
      check(card.actions >= 2, `user card showed ${card.actions} controls`)
      check(card.actionRows <= 2, `user card stacked its controls onto ${card.actionRows} rows`)
      check(!card.overflowsPanel, 'user card overflowed the panel')
    }

    /*
     * And again at the narrowest panel a user can produce, because that is
     * where a popup sized from its anchor fails worst.
     */
    await page.evaluate(() => {
      document.querySelector('.kb-panel').style.setProperty('--kb-w', '260px')
    })
    await settle(page, 300)
    const narrowCard = await page.evaluate(readUserCard)
    if (narrowCard) {
      check(
        narrowCard.width >= 200,
        `user card collapsed to ${narrowCard.width}px in a 260px panel`,
      )
      check(!narrowCard.overflowsPanel, 'user card overflowed the narrow panel')
    }

    // Close it again so the JOIN checks below see an ordinary card.
    await page.evaluate(openMemberCard)
    await settle(page)

    // --- JOIN, up to the navigation boundary -----------------------------

    await page.evaluate(clickPreset, '5-friend Gravity')
    await settle(page)
    await page.evaluate(clickJoin)
    await settle(page, 1_500)

    const joined = await page.evaluate(readPanel)
    check(
      joined.joins.some((line) => line.includes('twitch.tv/lirik')),
      `JOIN did not reach the navigation boundary: ${JSON.stringify(joined.joins)}`,
    )
    check(
      (await page.evaluate(() => window.location.pathname)) !== '/lirik',
      'the Test Lab navigated the developer away',
    )
    check(
      joined.events.includes('join_clicked'),
      `no join_clicked captured: ${JSON.stringify(joined.events)}`,
    )
    check(
      joined.events.includes('gravity_cluster_impression'),
      `no gravity impression captured: ${JSON.stringify(joined.events)}`,
    )

    // --- the user card covers what it is opened over ---------------------
    //
    // The panel is left at its natural content height first, which is the state
    // every tester starts in and the one the defect lived in: a body shorter
    // than the card itself, clipping it away to nothing.

    for (const [label, size] of [
      ['a content-height panel', null],
      ['a panel the user has grown', 700],
    ]) {
      await page.evaluate(clickPreset, '5-friend Gravity')
      await settle(page)
      await page.evaluate(closeAnyCard)
      await settle(page)
      const height = size
        ? await page.evaluate(growPanel, size)
        : await page.evaluate(shrinkPanel)
      await settle(page, 300)

      await page.evaluate(openMemberCard)
      await settle(page, 400)

      const coverage = await page.evaluate(cardCoverage)
      check(!coverage.error, `${label}: ${coverage.error}`)
      check(
        coverage.bleeding === 0,
        `${label} (${height}px): ${coverage.bleeding}/60 points of the user card show what is behind it — ${JSON.stringify(coverage.through)}`,
      )
      check(!coverage.escapesPanel, `${label}: the user card is drawn outside the panel`)

      // Actions survive the repositioning; a card that fits and does nothing is
      // not a fix.
      const still = await page.evaluate(readUserCard)
      check(still.actions >= 4, `${label}: only ${still?.actions} actions on the card`)

      await page.evaluate(closeAnyCard)
      await settle(page)
    }
    await page.evaluate(shrinkPanel)
    await settle(page)

    // --- the collapsed launcher, dragged with a real mouse ---------------
    //
    // Real input rather than synthetic events, because the whole question here
    // is whether one press becomes a drag or a click - and a dispatched
    // PointerEvent would prove nothing about the browser's own answer.

    check(await page.evaluate(minimize), 'no minimize control in the panel header')
    await settle(page, 300)

    const collapsed = await page.evaluate(readShell)
    check(collapsed.launcher !== null, 'the launcher did not appear after minimizing')
    check(!collapsed.panelOpen, 'the panel stayed open after minimizing')

    const from = collapsed.launcher ?? { x: 0, y: 0 }
    const grab = { x: from.x + 20, y: from.y + 20 }
    const drop = { x: grab.x - 220, y: grab.y + 150 }

    await page.mouse('mousePressed', grab.x, grab.y)
    // Several moves, so the gesture looks like a drag rather than a teleport.
    for (let step = 1; step <= 4; step += 1) {
      await page.mouse(
        'mouseMoved',
        grab.x + ((drop.x - grab.x) * step) / 4,
        grab.y + ((drop.y - grab.y) * step) / 4,
      )
    }
    await page.mouse('mouseReleased', drop.x, drop.y)
    await settle(page, 300)

    const dragged = await page.evaluate(readShell)
    check(dragged.launcher !== null, 'the launcher vanished during the drag')
    check(
      !dragged.panelOpen,
      'dragging the launcher also opened the panel - the click guard did not hold',
    )
    check(
      Math.abs((dragged.launcher?.x ?? 0) - (from.x - 220)) <= 2 &&
        Math.abs((dragged.launcher?.y ?? 0) - (from.y + 150)) <= 2,
      `the launcher did not follow the pointer: ${JSON.stringify(dragged.launcher)} from ${JSON.stringify(from)}`,
    )
    check(Boolean(dragged.stored), 'the dragged position was not persisted')

    // And an ordinary click, with no movement, still opens Kickback.
    await page.mouse('mousePressed', drop.x, drop.y)
    await page.mouse('mouseReleased', drop.x, drop.y)
    await settle(page, 300)

    const reopened = await page.evaluate(readShell)
    check(reopened.panelOpen, 'clicking the launcher no longer opens Kickback')

    await page.evaluate(resetShell)

    const stillClean = await page.evaluate(readPanel)
    check(!stillClean.error, `the lab threw while being driven: ${stillClean.error}`)
  } finally {
    await browser?.close()
    server.kill()
  }

  if (failures.length > 0) {
    for (const message of failures) console.error(`  ✗ ${message}`)
    console.error(`\n${failures.length} Test Lab check(s) failed.`)
    process.exit(1)
  }

  console.log('Test Lab boots, renders the real panel, and drives Gravity 1/2/3/5/10.')
  console.log('Metadata states render: live, offline+demoted, unavailable, casing, long text.')
  console.log('The contextual streamer tab appears, never selects itself, and carries a conversation.')
  console.log('One combo stream over reactions and emote messages; text closes a run, never extends it.')
  console.log('A session is people, not a broadcast: it survives the stream ending, and says OFFLINE.')
  console.log('Only real combos leak onto the card: a mark under the status, and not a control.')
  console.log('Unread and the way in both live on the streamer tab; the card carries neither.')
  console.log('The user card opened from a Gravity member keeps a readable width, even at 260px.')
  console.log('JOIN reaches the navigation boundary and stops there; analytics is captured.')
  console.log('The user card covers what it is opened over, at content height and grown.')
  console.log('The collapsed launcher drags with a real mouse, persists, and still opens on a click.')
}

await main()
