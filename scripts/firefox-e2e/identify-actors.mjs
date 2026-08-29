/**
 * Which seed profile is which Watchside account?
 *
 *   node scripts/firefox-e2e/identify-actors.mjs
 *
 * Launches each configured seed in a DISPOSABLE copy and asks the running
 * extension who it is. That is the only trustworthy answer: a profile
 * directory containing extension storage proves the add-on ran there, not that
 * anybody is signed in.
 *
 * Reports non-secret identity only - display name, Twitch login, user id,
 * friend code, friend count. No token, cookie or session value is read, and the
 * seeds themselves are never opened.
 */
import { createProfile, launch, seedProfile } from './harness.mjs'

async function identify(actor) {
  const seed = seedProfile(actor)
  if (!seed.present) {
    return { actor, seed, status: seed.path ? 'path not found' : 'not configured' }
  }

  const profile = createProfile({ name: `identify-${actor}`, seed: seed.path })
  const driver = await launch({
    profile,
    label: `identify-${actor}`,
    startUrl: 'https://www.twitch.tv/lirik',
  })

  try {
    const storage = await driver.bg('storage')

    // A session key is necessary but not sufficient - it may be expired. The
    // identity broadcast is what proves the account is actually usable.
    const identity = await driver
      .waitFor(
        async () => {
          const state = await driver.page('', 'state')
          const last = [...(state.states || [])].reverse().find((s) => s.signedIn)
          return last ?? null
        },
        { timeout: 45_000, label: `${actor} to report a signed-in identity` },
      )
      .catch(() => null)

    return {
      actor,
      seed,
      status: identity ? 'signed in' : storage.sessionPresent ? 'session key present but not signed in' : 'signed out',
      sessionKey: storage.sessionPresent,
      identity: identity && {
        userId: identity.userId,
        displayName: identity.displayName,
        twitchLogin: identity.twitchLogin,
        friendCode: identity.friendCode,
        friends: identity.friends,
        friendLogins: identity.friendLogins,
      },
    }
  } finally {
    await driver.close().catch(() => {})
  }
}

const results = []
for (const actor of ['A', 'B']) {
  // One actor failing must not hide the other: the whole point is to say which
  // profile is which, including when one of them is not usable.
  try {
    results.push(await identify(actor))
  } catch (error) {
    results.push({ actor, seed: seedProfile(actor), status: 'failed: ' + error.message })
  }
}

console.log('\nWatchside E2E actors\n')
for (const r of results) {
  console.log(`  Actor ${r.actor}  [${r.seed.key}]`)
  console.log(`    profile : ${r.seed.path ?? '(unset)'}`)
  console.log(`    status  : ${r.status}`)
  if (r.identity) {
    console.log(`    account : ${r.identity.displayName} (@${r.identity.twitchLogin})`)
    console.log(`    userId  : ${r.identity.userId}`)
    console.log(`    friends : ${r.identity.friends} ${JSON.stringify(r.identity.friendLogins ?? [])}`)
  }
  console.log()
}

const ready = results.filter((r) => r.status === 'signed in')
if (ready.length === 2 && ready[0].identity.userId === ready[1].identity.userId) {
  console.log('BOTH SEEDS ARE THE SAME ACCOUNT - a two-actor run needs two distinct identities.')
  process.exit(1)
}
if (ready.length < 2) {
  console.log('Not ready: two signed-in seed profiles are required for the social scenarios.')
  process.exit(1)
}
console.log('Ready: two distinct signed-in accounts.')
