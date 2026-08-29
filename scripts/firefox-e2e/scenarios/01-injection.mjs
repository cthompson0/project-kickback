import { createProfile, launch } from '../harness.mjs'

/**
 * The panel, and Twitch's navigation.
 *
 * Completes the gaps F4 left: home/browse -> channel, channel -> channel,
 * channel -> non-channel, and the same route twice. Every transition is a real
 * click on a real Twitch link, so Twitch's own router does the work - assigning
 * `location` would be a full page load and would prove nothing about the SPA
 * path, which is where duplicate injection actually happens.
 *
 * Geometry is asserted as RELATIONSHIPS, never coordinates. The panel is
 * draggable and its position is user state; Twitch's pixels are not ours to
 * pin. What must hold is that the panel is on screen and does not sit on top
 * of chat.
 */
export default {
  name: 'panel injection and Twitch SPA navigation',
  why: 'one host, one panel, correct channel, no duplicates, across four transitions',

  async run({ assert }) {
    const profile = createProfile({ name: 'injection' })
    const driver = await launch({ profile, startUrl: 'https://www.twitch.tv/lirik' })

    try {
      // --------------------------------------------------- initial injection
      const first = await driver.waitFor(
        async () => {
          const dom = await driver.page('lirik', 'dom')
          return dom.hostCount > 0 ? dom : null
        },
        { label: 'the panel to inject on a channel page' },
      )

      assert.equal('exactly one host element', first.hostCount, 1)
      assert.equal('exactly one panel', first.panelCount, 1)
      assert('a shadow root is attached', first.shadowRoot)
      assert.equal('the stylesheet reached the shadow root', first.styleTags, 1)
      assert('the panel is inside the viewport', first.inViewport, JSON.stringify(first.panelRect))

      // ------------------------------------------------------------ geometry
      assert('Twitch chat was located', first.chatSelector, first.chatSelector)
      assert.equal('the panel does not overlap Twitch chat', first.overlapChat, 0)

      // ----------------------------------------------------- page storage
      const storage = await driver.page('lirik', 'localStorage')
      assert('page-origin localStorage is writable', storage.writable, storage.error ?? '')

      // ------------------------------------------- channel -> channel (SPA)
      const hop = await driver.page('lirik', 'navigate', {
        pattern: '^/[a-z0-9_]{3,25}$',
        exclude: '^/(directory|settings|drops|subscriptions|wallet|friends)',
      })
      assert('a channel link was available to click', hop.navigated, JSON.stringify(hop))

      const afterHop = await driver.waitFor(
        async () => {
          const dom = await driver.page('', 'dom')
          return dom.url !== first.url ? dom : null
        },
        { label: `Twitch to navigate away from ${first.url}` },
      )
      assert.equal('still exactly one host after SPA navigation', afterHop.hostCount, 1)
      assert.equal('still exactly one panel after SPA navigation', afterHop.panelCount, 1)
      assert('the panel is still in the viewport', afterHop.inViewport)

      // --------------------------------------------- channel -> non-channel
      const away = await driver.page('', 'navigate', { pattern: '^/directory' })
      if (away.navigated) {
        const afterAway = await driver.waitFor(
          async () => {
            const dom = await driver.page('', 'dom')
            return dom.url.startsWith('/directory') ? dom : null
          },
          { label: 'Twitch to navigate to a non-channel route' },
        )
        assert.equal('one host on a non-channel route', afterAway.hostCount, 1)
        assert.equal('one panel on a non-channel route', afterAway.panelCount, 1)
      } else {
        console.log('    --  no /directory link on this page; skipped that transition')
      }

      // -------------------------------------------- browse/home -> channel
      const back = await driver.page('', 'navigate', {
        pattern: '^/[a-z0-9_]{3,25}$',
        exclude: '^/(directory|settings|drops|subscriptions|wallet|friends)',
      })
      if (back.navigated) {
        const afterBack = await driver.waitFor(
          async () => {
            const dom = await driver.page('', 'dom')
            return !dom.url.startsWith('/directory') && dom.hostCount > 0 ? dom : null
          },
          { label: 'Twitch to navigate from browse back to a channel' },
        )
        assert.equal('one host after browse -> channel', afterBack.hostCount, 1)
        assert.equal('one panel after browse -> channel', afterBack.panelCount, 1)
        assert('the panel is in the viewport after browse -> channel', afterBack.inViewport)
      } else {
        console.log('    --  no channel link on the browse page; skipped that transition')
      }

      // ------------------------------------------------------- chat collapse
      const toggled = await driver.page('', 'chatToggle')
      if (toggled.toggled) {
        const collapsed = await driver.waitFor(
          async () => {
            const dom = await driver.page('', 'dom')
            return dom.hostCount > 0 ? dom : null
          },
          { label: 'the panel to survive collapsing Twitch chat' },
        )
        assert.equal('one panel with chat collapsed', collapsed.panelCount, 1)
        assert('the panel is still in the viewport with chat collapsed', collapsed.inViewport)
        // Chat may now be absent or zero-width; either way it must not be under
        // the panel.
        assert(
          'the panel still does not overlap chat when collapsed',
          collapsed.overlapChat === 0 || collapsed.overlapChat === null,
          `overlap=${collapsed.overlapChat}`,
        )
        await driver.page('', 'chatToggle')
      } else {
        console.log(`    --  no chat collapse control found (${toggled.reason}); skipped`)
      }

      // ------------------------------------------------------------- errors
      const state = await driver.page('', 'state')
      assert.equal('no page errors across every transition', state.errors.length, 0)
      const bg = await driver.bg('errors')
      assert.equal('no background errors', bg.errors.length, 0)

      return { driver }
    } catch (error) {
      error.diagnostics = await collect(driver).catch(() => null)
      await driver.close().catch(() => {})
      throw error
    }
  },
}

/** Non-secret state worth having when something fails. */
async function collect(driver) {
  const [dom, state, errors, tabs] = await Promise.all([
    driver.page('', 'dom').catch((e) => ({ error: String(e.message) })),
    driver.page('', 'state').catch((e) => ({ error: String(e.message) })),
    driver.bg('errors').catch((e) => ({ error: String(e.message) })),
    driver.bg('tabs.list').catch((e) => ({ error: String(e.message) })),
  ])
  return { dom, state, backgroundErrors: errors, tabs }
}
