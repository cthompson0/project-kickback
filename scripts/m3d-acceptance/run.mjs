/**
 * The credentialed M3D acceptance run.
 *
 *   npm run verify:m3d
 *
 * TWO REAL ACCOUNTS, ONE REAL JOIN, ONE REAL TWITCH LOOKUP - AND NO HUMAN.
 *
 * Actor B watches a channel. Actor A, elsewhere, sees B's presence become a
 * Social Gravity card and clicks the card's own JOIN button. That is the
 * production path, not a simulation of it: the click goes through the real
 * JoinButton, the real attribution mint, the real analytics write and the real
 * relationship trigger. Nothing here inserts an analytics row or fabricates an
 * observation.
 *
 * WHY IT IS NOT PART OF `npm test`
 *
 * It launches two browsers, signs in as two real people, and causes a real
 * Twitch API call against a real stored credential. Ordinary CI runs against
 * fakes and must stay that way; this is a deliberate, explicitly invoked gate.
 *
 * WHAT IT REFUSES TO DO
 *
 * Spend a JOIN before proving the JOIN could mean anything. Two human JOINs
 * were burned discovering, afterwards, that the account clicking had no stored
 * credential - a state the product correctly says nothing about, and which only
 * a server query can see. Preconditions are now checked FIRST, and a failure
 * stops the run before a browser is driven.
 *
 * WHAT IT NEVER PRINTS
 *
 * Whether the viewer follows the creator. The harness asserts internally that a
 * real answer was recorded - `answered`, meaning the column is not null - and
 * that is the only thing that crosses into output. No token, no ciphertext, no
 * follow state, ever.
 *
 * SECRETS
 *
 * The owner-gated diagnostic token comes from the environment
 * (WATCHSIDE_ADMIN_TOKEN) and is never written to disk, output or the repo. The
 * Twitch credential itself never leaves the server: this harness only ever asks
 * the server questions about shapes.
 */
import { readFileSync } from 'node:fs'
import { createProfile, launch, seedProfile } from '../firefox-e2e/harness.mjs'
import { decidePreconditions, decideSocialPreconditions, explain } from './preconditions.mjs'

/*
 * They must start APART, or the room forms by itself and JOIN is never
 * exercised. Both are long-lived real channels; a made-up one would publish a
 * destination that does not exist.
 */
const HOME = 'twitch'
const MEET = 'lirik'

function env(name) {
  const value = process.env[name]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Reads the project URL and publishable key the extension itself is built with. */
function backendConfig() {
  let url = env('VITE_SUPABASE_URL')
  let key = env('VITE_SUPABASE_PUBLISHABLE_KEY')
  if (url && key) return { url, key }
  // .env.local is gitignored and holds no secret - the publishable key is
  // compiled into the shipped bundle. The service-role key is not here.
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (!match) continue
    if (match[1] === 'VITE_SUPABASE_URL') url = match[2]
    if (match[1] === 'VITE_SUPABASE_PUBLISHABLE_KEY') key = match[2]
  }
  return { url, key }
}

function makeAsk(config, adminToken) {
  return async function ask(body) {
    const response = await fetch(`${config.url}/functions/v1/twitch-credential`, {
      method: 'POST',
      headers: {
        apikey: config.key,
        'x-watchside-admin': adminToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`diagnostic returned non-JSON (${response.status})`)
    }
  }
}

const checks = []
function assert(label, condition, detail) {
  checks.push({ label, pass: Boolean(condition), detail })
  console.log(`    ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`)
  if (!condition) throw new Error(`${label}${detail ? ` — ${detail}` : ''}`)
}

function panelWhen(driver, path, predicate, label, timeout = 60_000) {
  return driver.waitFor(
    async () => {
      const panel = await driver.page(path, 'panel')
      return predicate(panel) ? panel : null
    },
    { label, timeout },
  )
}

/**
 * The signed-in identity, or a named precondition failure.
 *
 * A seed whose session has expired is the single most likely reason this run
 * cannot start, and it must not present as a sixty-second timeout - "timed out
 * waiting for Actor A" reads like a flaky harness when it means "this profile
 * needs re-authenticating once". The distinction is the difference between
 * re-running hopefully and doing the one thing that fixes it.
 */
async function identityWhen(driver, path, label, actor) {
  try {
    return await driver.waitFor(
      async () => {
        const s = await driver.page(path, 'state')
        return [...(s.states || [])].reverse().find((x) => x.signedIn) ?? null
      },
      { label, timeout: 45_000 },
    )
  } catch {
    throw new PreconditionError(
      `seed profile ${actor} is not signed in to Watchside.\n` +
        `      Sign in once, by hand, in that profile:\n` +
        `        ${seedProfile(actor).path}\n` +
        `      Everything after that is automated. See scripts/firefox-e2e/seeds.example.json.`,
    )
  }
}

/** A refusal to begin, as distinct from a failed assertion about behaviour. */
class PreconditionError extends Error {}

async function main() {
  console.log('Watchside M3D credentialed acceptance\n')

  const adminToken = env('WATCHSIDE_ADMIN_TOKEN')
  if (!adminToken) {
    console.error('WATCHSIDE_ADMIN_TOKEN is not set.')
    console.error('It is the owner-only diagnostic token (TWITCH_EVENTSUB_ADMIN_TOKEN in')
    console.error('Supabase Function secrets). It is deliberately not stored in this repo.')
    return 2
  }
  const config = backendConfig()
  if (!config.url || !config.key) {
    console.error('Supabase URL/publishable key not found in env or .env.local')
    return 2
  }
  const ask = makeAsk(config, adminToken)

  for (const actor of ['A', 'B']) {
    const seed = seedProfile(actor)
    if (!seed.present) {
      console.error(`Seed profile ${actor} is ${seed.path ? 'missing' : 'not configured'}.`)
      console.error('See scripts/firefox-e2e/seeds.example.json.')
      return 2
    }
  }

  let a = null
  let b = null
  try {
    // ---------------------------------------------------- who is under test
    console.log('  identity')
    a = await launch({
      profile: createProfile({ name: 'm3d-a', seed: seedProfile('A').path }),
      startUrl: `https://www.twitch.tv/${HOME}`,
      label: 'm3d-a',
    })
    b = await launch({
      profile: createProfile({ name: 'm3d-b', seed: seedProfile('B').path }),
      startUrl: `https://www.twitch.tv/${MEET}`,
      label: 'm3d-b',
      timeoutMs: 120_000,
    })

    const idA = await identityWhen(a, HOME, 'Actor A to restore its session', 'A')
    const idB = await identityWhen(b, MEET, 'Actor B to restore its session', 'B')
    /*
     * The social half of the gate, before the credential half.
     *
     * Two distinct signed-in accounts, optionally pinned by login, that are
     * already Watchside friends. Without the friendship no Gravity card can
     * ever appear, and the run would otherwise spend a minute timing out on a
     * card rather than saying so.
     */
    const social = decideSocialPreconditions({
      actorA: idA,
      actorB: idB,
      expected: { a: env('WATCHSIDE_M3D_ACTOR_A'), b: env('WATCHSIDE_M3D_ACTOR_B') },
    })
    if (!social.ok) throw new PreconditionError(explain(social, 'social'))
    assert('Actor A is signed in', Boolean(idA.userId), `@${idA.twitchLogin}`)
    assert('Actor B is signed in', Boolean(idB.userId), `@${idB.twitchLogin}`)
    assert('the two actors are different accounts', idA.userId !== idB.userId)
    assert(
      'and they are already Watchside friends',
      true,
      `@${idA.twitchLogin} ~ @${idB.twitchLogin}`,
    )

    // ------------------------------------------- PRECONDITIONS, BEFORE ANY JOIN
    /*
     * The gate that did not exist, and cost two human JOINs.
     *
     * Nothing below this point runs unless the actor about to click JOIN could
     * actually be measured. The check is against the SERVER's view of the
     * SPECIFIC actor identified above - not "the credential", which is exactly
     * the conflation that hid the problem.
     */
    console.log('\n  preconditions (before any JOIN is spent)')
    const pre = await ask({ action: 'acceptance_preconditions', actor_id: idA.userId })
    const decision = decidePreconditions(pre)

    if (!decision.ok) {
      console.log(`    FAIL ${explain(decision, `Actor A (@${idA.twitchLogin})`)}`)
      console.log('\n  NO JOIN WAS SPENT. Fix the precondition above and re-run.')
      return 3
    }
    assert('Actor A holds a Twitch credential', pre.has_credential === true)
    assert('Actor A has a connected Twitch account', pre.twitch_account_connected === true)
    assert('the credential carries user:read:follows', pre.has_follows_scope === true)
    assert('and carries nothing else Watchside does not ask for', pre.unexpected_scopes === 0)
    assert('the server reports readiness', pre.readiness === 'ready', pre.readiness)
    const baseline = Number(pre.observations_baseline ?? 0)
    console.log(`    ok   observation baseline recorded  (${baseline})`)

    // -------------------------------------- B's presence, then A's real JOIN
    console.log('\n  social presence')
    const published = await b.waitFor(
      async () => {
        const d = await b.bg('destinations')
        return d.available && d.value.published.includes(MEET) ? d.value : null
      },
      { label: `Actor B's presence on ${MEET} to reach the server`, timeout: 60_000 },
    )
    assert('Actor B publishes the channel it is watching', published.published.includes(MEET), MEET)

    const withCard = await panelWhen(
      a,
      HOME,
      (p) => p.present && p.cards.some((c) => (c.channel || '').toLowerCase() === MEET),
      `Actor A's panel to show a friend on ${MEET}`,
    )
    const card = withCard.cards.find((c) => (c.channel || '').toLowerCase() === MEET)
    assert('Actor A sees a Social Gravity card for that channel', Boolean(card), MEET)
    assert('the card offers a JOIN', card.join === true)
    assert('and A is not already there', card.here === false, `A is on /${HOME}`)

    console.log('\n  the JOIN')
    const clickedAt = Date.now()
    const joined = await a.page(HOME, 'join', { channel: card.channel })
    assert('the production JOIN control accepted the click', joined.clicked, JSON.stringify(joined))

    /*
     * Non-blocking, measured rather than asserted from the source.
     *
     * The navigation must not wait on the relationship lookup, so the time from
     * click to arrival is compared against a Twitch round trip. Arrival well
     * inside that is the product invariant holding.
     */
    const arrived = await a.waitFor(
      async () => {
        const dom = await a.page(MEET, 'dom')
        return dom.url.includes(MEET) ? dom : null
      },
      { label: `Actor A to arrive on /${MEET}`, timeout: 60_000 },
    )
    const navigationMs = Date.now() - clickedAt
    assert('JOIN navigated Actor A to the channel', arrived.url.includes(MEET), arrived.url)
    assert('and the panel survived the navigation', arrived.panelCount === 1)
    assert(
      'navigation did not wait on the relationship lookup',
      navigationMs < 15_000,
      `${navigationMs}ms from click to arrival`,
    )

    // ------------------------------------------------- the baseline, server-side
    console.log('\n  the follow baseline')
    const after = await (async () => {
      const deadline = Date.now() + 60_000
      let last = null
      while (Date.now() < deadline) {
        last = await ask({ action: 'observation_shape', actor_id: idA.userId })
        const mine = (last.shapes || []).filter((s) => s.join_found)
        if (mine.length > baseline) return last
        await new Promise((resolve) => setTimeout(resolve, 2_000))
      }
      return last
    })()

    const observations = (after.shapes || []).filter((s) => s.join_found)
    assert(
      'exactly one new observation exists',
      observations.length === baseline + 1,
      `${observations.length} total, baseline ${baseline}`,
    )

    const fresh = observations[0]
    assert('it is bound to a real JOIN of this actor', fresh.join_found === true)
    assert('aimed at the creator that was joined', fresh.destination_matches === true)
    assert('and that JOIN was socially initiated', fresh.socially_initiated === true)
    assert('exactly one observation for that attribution', fresh.observations_for_this_attribution === 1)
    assert('it is a follow relationship', fresh.relationship_type === 'follow')
    /*
     * THE ASSERTION THAT MUST NEVER BECOME AN OUTPUT.
     *
     * `answered` is true when relationship_present is NOT NULL - that a real
     * Twitch answer was recorded rather than a row written without one. Which
     * answer it was is not returned by the diagnostic, is not known here, and
     * cannot be printed.
     */
    assert('a real Twitch answer was recorded, not an empty row', fresh.answered === true)
    assert(
      'the baseline was taken at the JOIN',
      fresh.baseline_lag_ms !== null && fresh.baseline_lag_ms < 120_000,
      `${fresh.baseline_lag_ms}ms after the click`,
    )

    // ------------------------------------------------------------ idempotency
    console.log('\n  idempotency')
    const replay = await ask({
      action: 'relationship_replay',
      actor_id: idA.userId,
      broadcaster_login: MEET,
      attribution_id: fresh.attribution_id,
    })
    assert('a repeated attempt reports the baseline as recorded', replay.state === 'recorded')
    assert('and creates no second observation', replay.observations === 1, String(replay.observations))
    assert('nothing leaked in the replay response', !('following' in replay) && !('relationship_present' in replay))

    console.log('\n  relationship baseline recorded: YES')
    console.log('  actual follow state exposed:    NO')
    return 0
  } finally {
    await a?.close?.().catch(() => {})
    await b?.close?.().catch(() => {})
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    /*
     * A precondition failure is not a test failure. It means the run never
     * started, nothing was measured, and - the part that matters - NO JOIN WAS
     * SPENT. Reported distinctly so it is never mistaken for a product defect,
     * and given its own exit code so a caller can tell the two apart.
     */
    if (error instanceof PreconditionError) {
      console.error(`\n  PRECONDITION NOT MET: ${error.message}`)
      console.error('\n  NO JOIN WAS SPENT.')
      process.exit(3)
    }
    console.error(`\n  FAILED: ${error.message}`)
    process.exit(1)
  })
