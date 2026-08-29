import { createProfile, launch } from '../harness.mjs'

/**
 * Firefox with Strict Enhanced Tracking Protection.
 *
 * The compatibility investigation flagged page-origin `localStorage` under
 * Strict ETP as an open question, and F4 could only answer it for Standard
 * protection. This runs the same core assertions against a profile whose
 * privacy settings are TIGHTENED - dynamic first-party isolation, network state
 * partitioning, full tracking protection.
 *
 * The settings are only ever made stricter. Watchside has to work under the
 * strongest posture Firefox ships; loosening a pref to make a test pass would
 * be answering a different question.
 */
export default {
  name: 'strict Enhanced Tracking Protection',
  why: 'panel, page storage, extension storage and messaging under Firefox Strict',

  async run({ assert }) {
    const profile = createProfile({ name: 'strict-etp', strictEtp: true })
    const driver = await launch({ profile, startUrl: 'https://www.twitch.tv/lirik' })

    try {
      const dom = await driver.waitFor(
        async () => {
          const d = await driver.page('lirik', 'dom')
          return d.hostCount > 0 ? d : null
        },
        { label: 'the panel to inject under Strict ETP' },
      )

      assert.equal('exactly one host under Strict ETP', dom.hostCount, 1)
      assert.equal('exactly one panel under Strict ETP', dom.panelCount, 1)
      assert('the shadow root is attached', dom.shadowRoot)
      assert.equal('the stylesheet reached the shadow root', dom.styleTags, 1)
      assert('the panel is in the viewport', dom.inViewport, JSON.stringify(dom.panelRect))

      /* The question the investigation actually asked. */
      const page = await driver.page('lirik', 'localStorage')
      assert('page-origin localStorage is writable under Strict ETP', page.writable, page.error ?? '')

      /* And the thing that must stay independent of it. */
      const storage = await driver.bg('storage')
      assert(
        'extension storage is unaffected by Strict ETP',
        storage.watchside.length > 0,
        storage.watchside.join(),
      )

      /* Messaging is the other half: a partitioned page must still be able to
       * open a port to the worker. */
      const state = await driver.page('lirik', 'state')
      assert(
        'the content script still reaches the worker',
        state.states.length > 0,
        `${state.states.length} state broadcasts received`,
      )
      assert.equal('no page errors under Strict ETP', state.errors.length, 0)

      /* Navigation under partitioning, since dFPI is where SPA state tends to
       * get interesting. */
      const hop = await driver.page('lirik', 'navigate', {
        pattern: '^/[a-z0-9_]{3,25}$',
        exclude: '^/(directory|settings|drops|subscriptions|wallet|friends)',
      })
      if (hop.navigated) {
        const after = await driver.waitFor(
          async () => {
            const d = await driver.page('', 'dom')
            return d.url !== dom.url ? d : null
          },
          { label: 'navigation under Strict ETP' },
        )
        assert.equal('one panel after navigating under Strict ETP', after.panelCount, 1)
        const afterStorage = await driver.page('', 'localStorage')
        assert('page storage still works after navigating', afterStorage.writable)
      } else {
        console.log('    --  no channel link available; navigation step skipped')
      }

      const errors = await driver.bg('errors')
      assert.equal('no background errors under Strict ETP', errors.errors.length, 0)

      return { driver }
    } catch (error) {
      error.diagnostics = await collect(driver).catch(() => null)
      await driver.close().catch(() => {})
      throw error
    }
  },
}

async function collect(driver) {
  const [dom, state, errors] = await Promise.all([
    driver.page('', 'dom').catch((e) => ({ error: String(e.message) })),
    driver.page('', 'state').catch((e) => ({ error: String(e.message) })),
    driver.bg('errors').catch((e) => ({ error: String(e.message) })),
  ])
  return { dom, state, backgroundErrors: errors }
}
