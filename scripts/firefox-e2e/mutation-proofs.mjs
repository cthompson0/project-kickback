/**
 * Does the social suite actually fail when the product is broken?
 *
 *   npm run e2e:proofs
 *
 * A green test suite is a claim, and the claim is worthless until somebody
 * breaks the thing it watches and confirms it goes red. Three assertions in
 * `05-social.mjs` carry the weight of the whole social chain - the friend's
 * card, the JOIN, and the room message - so each one is broken here on purpose
 * and the run is expected to FAIL. A proof that "passes" means the assertion it
 * protects is a false positive and would have said nothing.
 *
 * WHERE THE BREAK LANDS
 *
 * In the per-actor instrumented COPY of the package, through the `mutate` seam
 * in the harness - never in `dist-firefox/package`, never in `src/`. The copy
 * is rebuilt from scratch on the next launch, so there is nothing to restore
 * and no way for a crashed run to leave a sabotaged build behind. Nothing this
 * script does is committable, because nothing it does touches a tracked file.
 *
 * Each mutation asserts its own lever is UNIQUE in the bundle before applying
 * it. If a rebuild changes the minified shape, the proof fails loudly instead
 * of quietly patching nothing and congratulating itself.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createProfile, launch, seedProfile } from './harness.mjs'

const HOME = 'twitch'
const MEET = 'lirik'
const CONTENT = 'kickback-content.js'

/** A single, exact, verified-unique substitution inside one instrumented copy. */
function patch(file, from, to) {
  return (dir) => {
    const path = join(dir, file)
    const before = readFileSync(path, 'utf8')
    const found = before.split(from).length - 1
    if (found !== 1) {
      throw new Error(
        `mutation lever is not unique in ${file}: found ${found} of ${JSON.stringify(from)}. ` +
          'The bundle changed shape - fix the lever rather than trusting the proof.',
      )
    }
    writeFileSync(path, before.split(from).join(to))
  }
}

/*
 * The three breaks.
 *
 * Each is the smallest edit that disables exactly one behaviour and leaves the
 * rest of the extension working - so a red result means the assertion caught
 * THAT, not that the browser fell over.
 */
const BREAK_PRESENCE = patch(CONTENT, 'type:`activity`', 'type:`activity-suppressed`')
// The worker's message switch ignores an unknown type, so the tab reports
// nothing and the friend is never anywhere.

const BREAK_JOIN = patch(CONTENT, 'location.assign(', 'location.replace===null&&location.assign(')
// JOIN still renders, still guards, still records - and goes nowhere.

const BREAK_SEND = patch(CONTENT, 'sendRoomMessage:', 'sendRoomMessageDisabled:')
// The composer's send throws instead of putting anything on the wire.

/** Run `probe` and report whether it FAILED, which is the result we want. */
async function expectBroken(label, probe) {
  try {
    await probe()
    return { label, held: false }
  } catch (error) {
    return { label, held: true, saw: error.message.split(' — ')[0] }
  }
}

function panelWhen(driver, path, predicate, label, timeout) {
  return driver.waitFor(
    async () => {
      const panel = await driver.page(path, 'panel')
      return predicate(panel) ? panel : null
    },
    { label, timeout },
  )
}

const cardFor = (p) => p.cards.some((c) => (c.channel || '').toLowerCase() === MEET)

async function actor(name, { seed, startUrl, mutate = null, timeoutMs }) {
  return launch({
    profile: createProfile({ name, seed: seedProfile(seed).path }),
    startUrl,
    label: name,
    mutate,
    ...(timeoutMs ? { timeoutMs } : {}),
  })
}

/*
 * PROOF 1 - suppress B's presence.
 *
 * Protects: "Actor A sees a card for the channel Actor B is on".
 * If A's panel still shows a card while B is reporting nothing, that assertion
 * is reading something other than B's presence.
 */
async function presenceProof() {
  const a = await actor('proof-a', { seed: 'A', startUrl: `https://www.twitch.tv/${HOME}` })
  let b = null
  try {
    b = await actor('proof-b', {
      seed: 'B',
      startUrl: `https://www.twitch.tv/${MEET}`,
      mutate: BREAK_PRESENCE,
      timeoutMs: 120_000,
    })

    const suppressed = await b.bg('destinations')
    console.log(
      `      B aggregates ${JSON.stringify(suppressed.value?.aggregated ?? null)} ` +
        `and publishes ${JSON.stringify(suppressed.value?.published ?? null)}`,
    )

    return expectBroken('A sees a card for the channel B is on', () =>
      panelWhen(a, HOME, cardFor, `a card for ${MEET} that should never appear`, 60_000),
    )
  } finally {
    if (b) await b.close().catch(() => {})
    await a.close().catch(() => {})
  }
}

/*
 * PROOF 2 - break the rendered JOIN.
 *
 * Protects: "JOIN navigated Actor A to the channel".
 * B is left INTACT, so the card appears and is clicked for real; only the
 * navigation is dead. An assertion that passed anyway would be watching the
 * click rather than the arrival.
 */
async function joinProof() {
  const a = await actor('proof-a', {
    seed: 'A',
    startUrl: `https://www.twitch.tv/${HOME}`,
    mutate: BREAK_JOIN,
  })
  let b = null
  try {
    b = await actor('proof-b', {
      seed: 'B',
      startUrl: `https://www.twitch.tv/${MEET}`,
      timeoutMs: 120_000,
    })

    const withCard = await panelWhen(a, HOME, cardFor, `A's card for ${MEET}`, 90_000)
    const card = withCard.cards.find((c) => (c.channel || '').toLowerCase() === MEET)
    const clicked = await a.page(HOME, 'join', { channel: card.channel })
    console.log(`      JOIN clicked: ${JSON.stringify(clicked)}`)

    return expectBroken('JOIN navigated Actor A to the channel', () =>
      a.waitFor(
        async () => {
          const dom = await a.page(MEET, 'dom')
          return dom.url.includes(MEET) ? dom : null
        },
        { label: `an arrival on /${MEET} that should never happen`, timeout: 60_000 },
      ),
    )
  } finally {
    if (b) await b.close().catch(() => {})
    await a.close().catch(() => {})
  }
}

/*
 * PROOF 3 - drop A's room message.
 *
 * Protects: "B received A's message".
 * Both actors reach the room normally; only A's send is dead. If B still shows
 * the message, the assertion is reading A's own optimistic echo rather than
 * anything that crossed the server.
 */
async function messageProof() {
  const a = await actor('proof-a', {
    seed: 'A',
    startUrl: `https://www.twitch.tv/${MEET}`,
    mutate: BREAK_SEND,
  })
  let b = null
  try {
    b = await actor('proof-b', {
      seed: 'B',
      startUrl: `https://www.twitch.tv/${MEET}`,
      timeoutMs: 120_000,
    })

    for (const driver of [a, b]) {
      await driver.page(MEET, 'expand').catch(() => {})
      await panelWhen(
        driver,
        MEET,
        (p) => p.present && p.tabs.some((t) => t.session),
        'the stream room tab',
        120_000,
      )
      await driver.page(MEET, 'click', { selector: '.kb-tab-session' })
      await panelWhen(driver, MEET, (p) => p.session !== null, 'the stream room', 60_000)
    }

    const body = `[Watchside E2E] proof-${Date.now().toString(36)} A→B`
    const sent = await a.page(MEET, 'compose', { body, send: true })
    console.log(`      A's composer reports: ${JSON.stringify(sent)}`)

    return expectBroken("B received A's message", () =>
      panelWhen(
        b,
        MEET,
        (p) => p.session && p.session.messages.some((m) => m.body === body),
        'a message that should never arrive',
        60_000,
      ),
    )
  } finally {
    if (b) await b.close().catch(() => {})
    await a.close().catch(() => {})
  }
}

const PROOFS = [
  { name: 'suppress B’s presence', run: presenceProof },
  { name: 'break the rendered JOIN', run: joinProof },
  { name: 'drop A’s room message', run: messageProof },
]

async function main() {
  for (const actorName of ['A', 'B']) {
    const seed = seedProfile(actorName)
    if (!seed.present) {
      console.error(`Actor ${actorName} has no seed profile (${seed.key}). Proofs need both.`)
      return 1
    }
  }

  console.log('Watchside E2E false-positive proofs')
  console.log('  each break is applied to a disposable copy; a PASS means the suite noticed\n')

  const results = []
  for (const proof of PROOFS) {
    console.log(`== ${proof.name}`)
    const at = Date.now()
    let outcome
    try {
      outcome = await proof.run()
    } catch (error) {
      outcome = { label: proof.name, held: false, error: error.message }
    }
    const ms = ((Date.now() - at) / 1000).toFixed(1)
    results.push({ ...outcome, proof: proof.name, ms })

    if (outcome.held) {
      console.log(`   PASS  "${outcome.label}" failed as it should  (${ms}s)`)
      console.log(`         ${outcome.saw}`)
    } else {
      console.log(`   FAIL  "${outcome.label}" still passed with the product broken  (${ms}s)`)
      if (outcome.error) console.log(`         ${outcome.error}`)
    }
  }

  const bad = results.filter((r) => !r.held).length
  console.log(`\n${'-'.repeat(60)}`)
  for (const r of results) {
    console.log(`  ${r.held ? 'PASS' : 'FAIL'}  ${r.proof.padEnd(30)} ${r.ms}s`)
  }
  console.log(`\n${results.length - bad}/${results.length} assertions proved themselves`)
  return bad ? 1 : 0
}

process.exit(await main())
