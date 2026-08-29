/**
 * One manifest, two engines.
 *
 * `public/manifest.json` is the single source of truth and stays a CHROMIUM
 * manifest, byte-for-byte, because that is the file Vite copies into `dist/`
 * and therefore the file that ships to the Chrome Web Store. Nothing here is
 * invoked during a Chromium build - `manifestFor('chromium')` exists so a test
 * can assert that the transform leaves it alone, not because the build needs
 * it.
 *
 * A second checked-in Firefox manifest was the obvious alternative and is the
 * wrong one: two files that must agree about permissions, version, icons and
 * content-script matches will eventually disagree, and the disagreement will
 * be discovered by a user rather than by us.
 *
 * F1 SCOPE. This produces a manifest that expresses the Gecko differences the
 * investigation proved
 * (docs/reports/firefox-prepublic-compatibility-2026-08-28.md §5, §14). It is
 * NOT an AMO-ready package: there is no Firefox packaging command yet, the
 * redirect URL is not registered with Supabase, and none of this has run
 * against a real Firefox. That is F2 onwards.
 */

/**
 * The permanent Firefox add-on id.
 *
 * Treat this with the same care as the Chromium `key`. The Gecko OAuth
 * redirect URL is DERIVED from it, so changing it silently invalidates
 * whatever redirect is registered with Supabase and breaks sign-in for every
 * Firefox user at once. It is asserted by tests for that reason.
 */
export const GECKO_ID = 'watchside@anoteros-labs.com'

/**
 * The oldest Firefox Watchside will install on.
 *
 * 128 is an ESR, so it is what institutional users are actually running, and
 * it sits comfortably above Firefox 127 - the release where MV3 host
 * permissions listed in `host_permissions` and `content_scripts` began being
 * granted at install rather than requiring a separate opt-in. Below that line a
 * Twitch overlay would install and then quietly do nothing.
 */
export const GECKO_MIN_VERSION = '128.0'

/** The background entry point, shared by both engines. */
const BACKGROUND_SCRIPT = 'kickback-background.js'

/**
 * Derive the manifest for a target engine.
 *
 * Pure: takes the parsed source, returns a new object, mutates nothing.
 *
 * @param {'chromium' | 'gecko'} target
 * @param {Record<string, unknown>} source parsed public/manifest.json
 * @returns {Record<string, unknown>}
 */
export function manifestFor(target, source) {
  if (target !== 'chromium' && target !== 'gecko') {
    throw new Error(`Unknown browser target: ${target}`)
  }

  // Chromium is the source of truth and gets it back untouched. Structured
  // clone rather than the same reference, so a caller cannot mutate the input
  // through the output.
  if (target === 'chromium') return structuredClone(source)

  const manifest = structuredClone(source)

  /*
   * The Chromium identity has no meaning in Gecko, and shipping it would be
   * worse than pointless - `key` is what pins the Chrome Web Store item, and
   * it has no business in a package uploaded anywhere else.
   */
  delete manifest.key

  /*
   * Firefox runs an EVENT PAGE, not a service worker: `background.service_worker`
   * is not implemented in Gecko. Both keys may legally coexist - from Firefox
   * 121 the background page starts regardless - but the Firefox package drops
   * `service_worker` entirely so `web-ext lint` never has to warn about a key
   * the engine ignores.
   *
   * The script itself is unchanged. Watchside's background-restart recovery
   * (activity replay on reconnect, destination re-statement) is triggered by
   * RECONNECTION, so it stays correct on an engine that suspends differently -
   * and simply never fires on one that does not suspend.
   */
  manifest.background = { scripts: [BACKGROUND_SCRIPT] }

  /*
   * Gecko needs an explicit, stable id. Left unset, AMO assigns one that can
   * differ per upload - and since the OAuth redirect URL is derived from the
   * id, that would move the redirect target underneath a registered
   * allow-list entry.
   */
  manifest.browser_specific_settings = {
    gecko: { id: GECKO_ID, strict_min_version: GECKO_MIN_VERSION },
  }

  return manifest
}
