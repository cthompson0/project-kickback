import { createProfile, launch } from '../harness.mjs'

const TWITCH_ORIGIN = 'https://www.twitch.tv/*'

/**
 * Multi-destination publishing, and the event page dying and coming back.
 *
 * This is the permanent real-browser guard for WS-F4-01. The deterministic test
 * (tests/extension/backgroundLifecycle.test.ts) proves the worker hydrates at
 * module evaluation; this proves the thing that made it matter - that Firefox
 * really does tear the background down, and that what comes back is a working
 * worker rather than a hollow one.
 *
 * It is also the only slow scenario in the suite, because waiting out an idle
 * suspension is the measurement. Everything else finishes in seconds; this one
 * is deliberately isolated here so the rest stay fast.
 */
export default {
  name: 'multi-destination publishing and background revival',
  why: 'two tabs aggregate and publish; the event page suspends, revives, and hydrates',

  async run({ assert }) {
    /*
     * Publishing needs a session. The suite runs signed-out by default so it
     * works on any machine with no credentials anywhere near it; point
     * WATCHSIDE_E2E_SEED_PROFILE at an already-authenticated Firefox profile
     * and the same scenario also proves what reaches the SERVER. The seed is
     * copied, never opened, so it cannot be mutated by the run.
     */
    const seed = process.env.WATCHSIDE_E2E_SEED_PROFILE || null
    const profile = createProfile({ name: 'lifecycle', seed })
    const driver = await launch({ profile, startUrl: 'https://www.twitch.tv/lirik' })

    try {
      // ------------------------------------------- the diagnostic is reachable
      const attached = await driver.bg('diagnosticsAttached')
      assert.equal('the destinations diagnostic is attached', attached.destinations, 'object')
      assert.equal('the gravity diagnostic is attached', attached.gravity, 'object')

      const firstBoot = (await driver.bg('hello')).boot

      // ------------------------------------------------- one tab, one channel
      const one = await driver.waitFor(
        async () => {
          const d = await driver.bg('destinations')
          return d.available && d.value.aggregated.length === 1 ? d.value : null
        },
        { label: 'the worker to aggregate the first destination' },
      )
      assert.equal('one port is registered', one.ports.length, 1)
      assert.equal('the first channel is aggregated', one.aggregated.join(), 'lirik')
      /*
       * Signing in is asynchronous - the session is restored from storage and
       * then refreshed over the network - so sampling once, straight after the
       * first destination appears, reads false even on an authenticated
       * profile. When a seed was supplied the run WAITS for it, and fails if it
       * never arrives: silently downgrading to the signed-out assertions would
       * hide a broken seed behind a green run.
       */
      let signedIn = false
      if (seed) {
        signedIn = await driver.waitFor(
          async () => {
            const d = await driver.bg('destinations')
            return d.available && d.value.signedIn ? true : null
          },
          { label: 'the seeded profile to restore its session', timeout: 45_000 },
        )
        assert.equal('the seeded profile is signed in', signedIn, true)
        const published = await driver.waitFor(
          async () => {
            const d = await driver.bg('destinations')
            return d.available && d.value.published.length === 1 ? d.value : null
          },
          { label: 'the first destination to reach the server', timeout: 45_000 },
        )
        assert.equal('the destination is published to the server', published.published.join(), 'lirik')
      } else {
        assert.equal('nothing is published while signed out', one.published.length, 0)
        console.log('    --  signed out: server publishing not exercised (set WATCHSIDE_E2E_SEED_PROFILE)')
      }

      // ------------------------------------------------ a second destination
      await driver.bg('tabs.open', { url: 'https://www.twitch.tv/shroud', active: false })

      const two = await driver.waitFor(
        async () => {
          const d = await driver.bg('destinations')
          return d.available && d.value.aggregated.length === 2 ? d.value : null
        },
        { label: 'the worker to aggregate a second destination', timeout: 45_000 },
      )
      assert.equal('two ports are registered', two.ports.length, 2)
      assert(
        'both channels are aggregated',
        two.aggregated.includes('lirik') && two.aggregated.includes('shroud'),
        two.aggregated.join(),
      )
      if (signedIn) {
        /* The reporter debounces, so publishing trails aggregation by design.
         * Waiting for it to settle is the assertion; sampling once would be a
         * race dressed up as a test. */
        const settled = await driver.waitFor(
          async () => {
            const d = await driver.bg('destinations')
            return d.available && d.value.published.length === 2 ? d.value : null
          },
          { label: 'both destinations to reach the server', timeout: 45_000 },
        )
        assert(
          'both channels are published to the server',
          settled.published.includes('lirik') && settled.published.includes('shroud'),
          settled.published.join(),
        )
      }

      /* The rule the multi-destination work exists to protect: a tab the user
       * is not looking at still counts. If focus ever started weighting
       * presence, this is where it would show. */
      const hidden = two.ports.filter((p) => p.visible === false)
      assert('a background tab still contributes a destination', hidden.length >= 1, `${hidden.length} hidden`)

      // ------------------------------------------- publishing follows removal
      await driver.bg('tabs.closeTwitch')

      const empty = await driver.waitFor(
        async () => {
          const d = await driver.bg('destinations')
          return d.available && d.value.aggregated.length === 0 ? d.value : null
        },
        { label: 'destinations to drain after every Twitch tab closed', timeout: 45_000 },
      )
      assert.equal('nothing is aggregated once no tab is watching', empty.aggregated.length, 0)
      if (signedIn) {
        const drained = await driver.waitFor(
          async () => {
            const d = await driver.bg('destinations')
            return d.available && d.value.published.length === 0 ? d.value : null
          },
          { label: 'the server to be told nothing is being watched', timeout: 45_000 },
        )
        assert.equal('and nothing is published', drained.published.length, 0)
      } else {
        assert.equal('and nothing is published', empty.published.length, 0)
      }

      // ------------------------------------------------ suspend, then revive
      // An alarm is the only thing that can wake a suspended event page on
      // demand, so one is armed before the silence starts.
      await driver.bg('alarm.create', { name: 'e2e:wake', delayInMinutes: 1.1 })

      const secondBoot = await driver.waitFor(
        async () => {
          const hello = await driver.bg('hello', {}, { timeout: 90_000 })
          return hello.boot !== firstBoot ? hello.boot : null
        },
        {
          label: 'the event page to suspend and be revived by an alarm',
          timeout: 180_000,
          interval: 3_000,
        },
      )
      assert('the background context was torn down and rebuilt', secondBoot !== firstBoot, secondBoot)

      // --------------------------- WS-F4-01: the revived worker is not hollow
      const afterRevival = await driver.bg('diagnosticsAttached')
      assert.equal(
        'the revived worker attached its diagnostics',
        afterRevival.destinations,
        'object',
      )

      const storage = await driver.bg('storage')
      assert(
        'the revived worker hydrated its local caches',
        storage.watchside.length > 0,
        storage.watchside.join(),
      )

      // -------------------------------------------- reconnect after revival
      await driver.bg('tabs.open', { url: 'https://www.twitch.tv/lirik', active: true })

      const reconnected = await driver.waitFor(
        async () => {
          const d = await driver.bg('destinations')
          return d.available && d.value.aggregated.length === 1 ? d.value : null
        },
        { label: 'a reconnecting tab to restore publishing', timeout: 60_000 },
      )
      assert.equal(
        'the reconnecting tab restored the destination',
        reconnected.aggregated.join(),
        'lirik',
      )
      if (signedIn) {
        const republished = await driver.waitFor(
          async () => {
            const d = await driver.bg('destinations')
            return d.available && d.value.published.length === 1 ? d.value : null
          },
          { label: 'publishing to resume after the revival', timeout: 45_000 },
        )
        assert.equal('publishing resumed after revival', republished.published.join(), 'lirik')
      }

      const errors = await driver.bg('errors')
      assert.equal('no background errors across the whole lifecycle', errors.errors.length, 0)

      return { driver }
    } catch (error) {
      error.diagnostics = await collect(driver).catch(() => null)
      await driver.close().catch(() => {})
      throw error
    }
  },
}

async function collect(driver) {
  const [destinations, storage, errors, tabs, perms] = await Promise.all([
    driver.bg('destinations').catch((e) => ({ error: String(e.message) })),
    driver.bg('storage').catch((e) => ({ error: String(e.message) })),
    driver.bg('errors').catch((e) => ({ error: String(e.message) })),
    driver.bg('tabs.list').catch((e) => ({ error: String(e.message) })),
    driver.bg('perm.contains', { origins: [TWITCH_ORIGIN] }).catch((e) => ({ error: String(e.message) })),
  ])
  return { destinations, storage, backgroundErrors: errors, tabs, twitchPermission: perms }
}
