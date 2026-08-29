import { createProfile, launch } from '../harness.mjs'

const TWITCH_ORIGIN = 'https://www.twitch.tv/*'
const ICON = 'icons/icon-128.png'

/**
 * The Gecko platform surfaces: notifications, permissions, storage.
 *
 * The notification pair is the most valuable assertion in the whole suite. F4
 * measured that Firefox REJECTS a notification carrying `buttons` rather than
 * ignoring the field, which is what makes the Gecko adapter's strip
 * load-bearing rather than tidy. Asserting both halves means a future
 * "simplification" that removed the strip fails here instead of silently
 * costing every Firefox user every notification.
 */
export default {
  name: 'Gecko platform surfaces',
  why: 'notifications accept the stripped payload and reject buttons; permissions revoke cleanly',

  async run({ assert }) {
    const profile = createProfile({ name: 'platform' })
    const driver = await launch({ profile, startUrl: 'https://www.twitch.tv/lirik' })

    try {
      // ------------------------------------------------------ notifications
      const stripped = await driver.bg('notify.create', {
        id: 'kickback:gathering:e2e',
        options: {
          type: 'basic',
          iconUrl: ICON,
          title: 'Alice and Bob on Twitch',
          message: 'Watching LIRIK',
        },
      })
      assert('Gecko accepts the payload the adapter emits', stripped.accepted, stripped.error ?? '')

      const withButtons = await driver.bg('notify.create', {
        id: 'kickback:gathering:e2e-buttons',
        options: {
          type: 'basic',
          iconUrl: ICON,
          title: 'With buttons',
          message: 'Chromium shape',
          buttons: [{ title: 'Join them' }],
        },
      })
      assert(
        'Gecko rejects the same payload with buttons',
        withButtons.accepted === false,
        withButtons.error ?? 'it was accepted, so the adapter strip is now untested',
      )
      assert(
        'and rejects it specifically because of buttons',
        /buttons/i.test(withButtons.error || ''),
        withButtons.error,
      )

      const cleared = await driver.bg('notify.clear', { id: 'kickback:gathering:e2e' })
      assert('a notification can be cleared', cleared.cleared === true, JSON.stringify(cleared))

      // ---------------------------------------------------------- storage
      const storage = await driver.bg('storage')
      assert(
        'the worker keeps its local caches under the kickback: prefix',
        storage.watchside.length > 0,
        storage.watchside.join(),
      )
      assert(
        'the compatibility key vocabulary is unchanged',
        storage.watchside.every((k) => k.startsWith('kickback:')),
        storage.watchside.join(),
      )

      const page = await driver.page('lirik', 'localStorage')
      assert('page-origin localStorage works', page.writable, page.error ?? '')

      // ------------------------------------------------------- permissions
      const before = await driver.bg('perm.contains', { origins: [TWITCH_ORIGIN] })
      assert('the Twitch host permission is granted at install', before.has)

      const removed = await driver.bg('perm.remove', { origins: [TWITCH_ORIGIN] })
      assert('it can be revoked at runtime', removed.removed)

      const after = await driver.bg('perm.contains', { origins: [TWITCH_ORIGIN] })
      assert('and is then absent', after.has === false)

      /* The point of revocation is that it fails CLEANLY. An already-injected
       * content script keeps working; what must not happen is a crashing
       * background or a burst of errors. */
      const errors = await driver.bg('errors')
      assert.equal('revocation produced no background errors', errors.errors.length, 0)

      const stillThere = await driver.bg('tabs.list')
      assert('the browser is still healthy after revocation', stillThere.tabs.length > 0)

      /* Re-granting needs a user gesture, so it is not automated. Asserting the
       * refusal keeps the F7 hand-off honest rather than silently untested. */
      const all = await driver.bg('perm.all')
      /*
       * Matched by SHAPE, not by literal.
       *
       * This used to name `https://*.supabase.co/*`. F6 narrowed the Firefox
       * grant to our own project origin, and a hard-coded wildcard turned that
       * improvement into a red suite - which is the wrong signal entirely. What
       * the assertion is actually about is that revoking Twitch left the backend
       * grant alone, and that holds whichever origin the backend is.
       */
      const backend = all.origins.filter((origin) => origin.includes('supabase.co'))
      assert(
        'the other host permissions are untouched by revoking one',
        backend.length === 1,
        all.origins.join(),
      )
      assert(
        'and the backend grant is a single project, not a wildcard',
        /^https:\/\/[a-z0-9-]+\.supabase\.co\/\*$/.test(backend[0] ?? ''),
        backend.join(),
      )

      return { driver }
    } catch (error) {
      error.diagnostics = await collect(driver).catch(() => null)
      await driver.close().catch(() => {})
      throw error
    }
  },
}

async function collect(driver) {
  const [errors, storage, perms] = await Promise.all([
    driver.bg('errors').catch((e) => ({ error: String(e.message) })),
    driver.bg('storage').catch((e) => ({ error: String(e.message) })),
    driver.bg('perm.all').catch((e) => ({ error: String(e.message) })),
  ])
  return { backgroundErrors: errors, storage, permissions: perms }
}
