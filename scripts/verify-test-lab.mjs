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
      /* Automatic Together, which lives inside the card the viewer is on. */
      together: Boolean(card.querySelector('.kb-together')),
      reactionButtons: card.querySelectorAll('.kb-together-react').length,
      bursts: [...card.querySelectorAll('.kb-together-burst')].map((el) => el.textContent.trim()),
      combos: card.querySelectorAll('.kb-together-count').length,
      /* The row must not grow when a reaction lands. */
      barHeight: Math.round(
        card.querySelector('.kb-together-bar')?.getBoundingClientRect().height ?? 0,
      ),
      cardHeight: Math.round(card.getBoundingClientRect().height),
    })),
    quiet: [...document.querySelectorAll('.kb-section-label')].map((el) => el.textContent),
    events: [...document.querySelectorAll('.lab-log li strong')].map((el) => el.textContent),
    joins: [...document.querySelectorAll('.lab-log-join li')].map((el) => el.textContent),
  }
}

/** Makes a simulated friend react, through the lab's own controls. */
function labReact(index, reaction) {
  const rows = [...document.querySelectorAll('.lab-users .lab-row')].filter((row) =>
    [...row.querySelectorAll('button')].some((b) => b.textContent.trim() === reaction),
  )
  const row = rows[index]
  if (!row) throw new Error('no Together control for person ' + index)
  const button = [...row.querySelectorAll('button')].find(
    (b) => b.textContent.trim() === reaction,
  )
  button.click()
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

    // --- automatic together ----------------------------------------------

    await page.evaluate(clickPreset, 'Together · 2 friends')
    await settle(page)

    const together = (await page.evaluate(readPanel)).cards[0] ?? {}
    check(together.here === true, 'Together did not form on the channel the viewer is on')
    check(together.join === false, 'the Together card still offered a JOIN')
    check(together.count === 2, `Together counted ${together.count} friends, expected 2`)
    check(together.together === true, 'no Together surface inside the HERE card')
    check(
      together.reactionButtons === 5,
      `drew ${together.reactionButtons} reaction buttons, expected 5`,
    )
    check(together.bursts.length === 0, 'reactions appeared before anybody reacted')

    /*
     * One card, not two. The whole UX claim is that Gravity BECOMES Together
     * rather than being joined by a second thing.
     */
    check(
      (await page.evaluate(readPanel)).cards.length === 1,
      'a second card appeared alongside the Together one',
    )

    const before = together.cardHeight
    const beforeBar = together.barHeight

    // One friend reacts.
    await page.evaluate(labReact, 0, '😂')
    await settle(page, 300)
    const one = (await page.evaluate(readPanel)).cards[0] ?? {}
    check(one.bursts.length === 1, `expected one reaction, saw ${one.bursts.length}`)
    check(one.combos === 0, 'a single reaction was drawn as a combo')
    check(
      one.barHeight === beforeBar,
      `the reaction row grew from ${beforeBar}px to ${one.barHeight}px`,
    )
    check(
      Math.abs(one.cardHeight - before) <= 1,
      `the card jumped from ${before}px to ${one.cardHeight}px when a reaction landed`,
    )

    // The second friend agrees: a combo.
    await page.evaluate(labReact, 1, '😂')
    await settle(page, 300)
    const combo = (await page.evaluate(readPanel)).cards[0] ?? {}
    check(combo.combos === 1, `expected one combo counter, saw ${combo.combos}`)
    check(
      combo.bursts.some((text) => text.includes('×2')),
      `combo did not read ×2: ${JSON.stringify(combo.bursts)}`,
    )

    // One person hammering a button is not a combo.
    await page.evaluate(clickPreset, 'Together · 2 friends')
    await settle(page)
    for (let i = 0; i < 4; i += 1) await page.evaluate(labReact, 0, '🔥')
    await settle(page, 300)
    const burst = (await page.evaluate(readPanel)).cards[0] ?? {}
    /*
     * Asserted on the FIRE burst specifically, not on the combo count.
     *
     * Reactions live for eight seconds and switching preset does not change
     * the channel, so the previous step's combo can still be on screen - which
     * is correct behaviour and would make a total count lie about this claim.
     */
    check(
      !burst.bursts.some((text) => text.includes(String.fromCodePoint(0x1f525)) && text.includes('×')),
      'one person pressing a button repeatedly formed a combo: ' + JSON.stringify(burst.bursts),
    )

    // Competing social graphs: strangers on the same channel are not here.
    await page.evaluate(clickPreset, 'Together · competing graphs')
    await settle(page)
    const graphs = (await page.evaluate(readPanel)).cards[0] ?? {}
    check(graphs.count === 2, `competing graphs counted ${graphs.count}, expected 2`)
    check(graphs.people.length === 2, 'a stranger appeared in the Together')

    // Nobody there: no surface at all.
    await page.evaluate(clickPreset, 'Together · nobody yet')
    await settle(page)
    const alone = await page.evaluate(readPanel)
    check(
      alone.cards.every((card) => card.together === false),
      'a Together surface appeared with nobody to be together with',
    )

    // Ten friends at the narrowest panel: the reaction bar must still fit.
    await page.evaluate(clickPreset, 'Together · 10 friends')
    await settle(page)
    await page.evaluate(() => {
      document.querySelector('.kb-panel').style.setProperty('--kb-w', '260px')
    })
    await settle(page, 300)
    const tightTogether = (await page.evaluate(readPanel)).cards[0] ?? {}
    check(tightTogether.reactionButtons === 5, 'reaction buttons were lost at 260px')
    check(tightTogether.overflows === false, 'the Together card overflowed at 260px')
    check(
      tightTogether.people.length === 10,
      `drew ${tightTogether.people.length} people, expected 10`,
    )

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
  console.log('Automatic Together forms in place, reacts, combos, and respects social graphs.')
  console.log('The user card opened from a Gravity member keeps a readable width, even at 260px.')
  console.log('JOIN reaches the navigation boundary and stops there; analytics is captured.')
}

await main()
