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
 * 140, because it is the CURRENT ESR - which is the same reasoning that first
 * chose 128, applied to today's facts. Firefox 128 ESR went out of support on
 * 16 September 2025, so a 128 floor was no longer protecting anybody; it was
 * naming a browser Mozilla had stopped shipping fixes for.
 *
 * 140 is also the release that introduced
 * `browser_specific_settings.gecko.data_collection_permissions`. Below it the
 * key is ignored, so a user on 139 would install without ever seeing Firefox's
 * built-in data-collection consent - the disclosure would exist in the manifest
 * and never reach the person it is for. Raising the floor is what makes the
 * declaration below mean something at install time rather than only on AMO.
 *
 * It stays comfortably above Firefox 127, the release where MV3 host
 * permissions began being granted at install rather than requiring a separate
 * opt-in - the original reason this floor exists at all.
 */
export const GECKO_MIN_VERSION = '140.0'

/**
 * What Watchside collects, in Mozilla's taxonomy.
 *
 * Required for AMO since 3 November 2025, and shown to the user in the install
 * prompt, on the listing page, and in about:addons. It is a promise made to
 * somebody deciding whether to trust this, so it is mapped from what the code
 * actually transmits rather than from what sounds reassuring - see the F6
 * report for the line-by-line mapping.
 *
 *   authenticationInfo    signing in with Twitch, and the account that creates
 *   browsingActivity      the Twitch channel you are watching, which is the
 *                         entire product and is also sent to 7TV to look up
 *                         that channel's emotes
 *   personalCommunications stream-room messages, reactions, and free-text
 *                         feedback
 *   websiteActivity       JOINs and the surfaces they came from
 *
 * DELIBERATELY ABSENT:
 *
 * `personallyIdentifyingInfo` - no email, phone, address, demographics or
 * biometrics is collected anywhere. The Twitch handle, display name and avatar
 * are the account's own public profile and are what `authenticationInfo`
 * already covers; claiming PII as well would tell users something untrue in the
 * more alarming direction.
 *
 * `technicalAndInteraction` - Mozilla allows it only as OPTIONAL, which means
 * honouring a user who declines it. Watchside has no analytics opt-out today,
 * so declaring it would be a promise the code does not keep. See the F6 report:
 * this is an open owner decision, not an oversight.
 *
 * `websiteContent` - the content script reads the channel from the URL and
 * finds the chat container to position the panel. None of that page content is
 * transmitted; only the channel login is, and that is browsingActivity.
 */
export const GECKO_DATA_COLLECTION = {
  required: ['authenticationInfo', 'browsingActivity', 'personalCommunications', 'websiteActivity'],
}

/** The background entry point, shared by both engines. */
const BACKGROUND_SCRIPT = 'kickback-background.js'

/** The Chromium manifest's broad backend grant, which Gecko narrows. */
export const SUPABASE_WILDCARD = 'https://*.supabase.co/*'

/**
 * The hosts that can legitimately be Watchside's backend.
 *
 * WHY THIS IS A LIST AND NOT A CONSTANT
 *
 * The Gecko manifest grants exactly the origin the built bundle talks to, and
 * that origin is discovered by reading the minified bundle rather than trusting
 * the environment - so a manifest granting a project the code does not use
 * fails the build instead of failing at a user's sign-in.
 *
 * Discovering it needs a pattern, and the pattern has to be narrow. "Any https
 * origin" would match 7tv.io and twitch.tv; "*.supabase.co" cannot see a
 * branded backend at all, and would have failed the build the first time
 * VITE_SUPABASE_URL named one.
 *
 * So the two shapes are enumerated. Both are ours, adding a third is a
 * deliberate edit here, and the "exactly one" rule at every call site still
 * catches a bundle that somehow talks to two backends.
 *
 * `[.]` is a literal dot. It is a character class rather than an escape
 * because this file is edited through shells often enough that a lost
 * backslash is a real failure mode, and a lost one here would silently widen
 * the pattern.
 */
const BACKEND_HOSTS = ['[a-z0-9-]+[.]supabase[.]co', 'api[.]watchside[.]app']

/**
 * Every distinct backend origin a built bundle names.
 *
 * Callers assert the result has exactly one element. Returning the list rather
 * than the origin is what lets them say how many they found when it does not.
 *
 * @param {string} source the built background bundle, as text
 * @returns {string[]} unique origins, in first-seen order
 */
export function backendOriginsIn(source) {
  const pattern = new RegExp(`https://(?:${BACKEND_HOSTS.join("|")})`, "g")
  return [...new Set([...source.matchAll(pattern)].map((m) => m[0]))]
}

/**
 * Whether a set of host permissions actually grants an origin.
 *
 * WHY THE CHROMIUM MANIFEST NEEDS THIS AND THE GECKO ONE DOES NOT
 *
 * The Gecko manifest DERIVES its backend grant from the origin the built
 * bundle names, so the two cannot disagree. The Chromium manifest instead
 * carries a static `https://*.supabase.co/*`, which covers every Supabase
 * project and therefore covers ours by accident of shape rather than by
 * anything checking.
 *
 * That held for as long as the backend was a Supabase subdomain. A branded
 * backend - `api.watchside.app` - is NOT matched by that wildcard, so a Chrome
 * build pointed at one would ship a manifest granting a host it never talks
 * to and omitting the only host it does. Whether that actually breaks depends
 * on a third party's CORS headers, which is not a thing to find out from a
 * user.
 *
 * Deliberately no regex: this decides what the extension may reach, and a
 * pattern that silently over-matches is worse than no check at all.
 *
 * @param {string[]} patterns match patterns from host_permissions
 * @param {string} origin an origin such as https://api.watchside.app
 * @returns {boolean}
 */
export function grantsOrigin(patterns, origin) {
  const host = new URL(origin).hostname
  return patterns.some((pattern) => {
    if (!pattern.startsWith('https://') || !pattern.endsWith('/*')) return false
    const declared = pattern.slice('https://'.length, -'/*'.length)
    if (declared === host) return true
    // `*.supabase.co` covers `xyz.supabase.co`, and nothing else.
    return declared.startsWith('*.') && host.endsWith(declared.slice(1))
  })
}

/**
 * Derive the manifest for a target engine.
 *
 * Pure: takes the parsed source, returns a new object, mutates nothing.
 *
 * @param {'chromium' | 'gecko'} target
 * @param {Record<string, unknown>} source parsed public/manifest.json
 * @param {{ supabaseOrigin?: string | null }} [options] gecko only: the project
 *   origin that replaces the Supabase wildcard host permission
 * @returns {Record<string, unknown>}
 */
export function manifestFor(target, source, { supabaseOrigin = null } = {}) {
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
    gecko: {
      id: GECKO_ID,
      strict_min_version: GECKO_MIN_VERSION,
      data_collection_permissions: structuredClone(GECKO_DATA_COLLECTION),
    },
  }

  /*
   * NO `gecko_android`, and that is the statement.
   *
   * Omitting the key is how an add-on says desktop-only: MDN is explicit that
   * without it "the extension is only made available on desktop Firefox".
   * Watchside is a panel that lives beside a Twitch player and a chat column,
   * it has never been run on Firefox for Android, and claiming a platform we
   * have not tested to silence a linter warning would be the wrong trade. The
   * one Android warning that remains is documented in the F6 report rather
   * than bought off.
   */

  /*
   * The backend, narrowed from the wildcard to OUR project.
   *
   * `https://*.supabase.co/*` grants every Supabase project on the internet,
   * which is far more than Watchside needs and exactly the kind of breadth an
   * AMO reviewer has to stop and ask about. supabase-js derives auth, REST,
   * realtime, storage and functions from the single project URL - each one is
   * `new URL('<service>/v1', supabaseUrl)` - so one origin covers every call
   * the extension makes.
   *
   * Gecko only. `public/manifest.json` is the Chromium manifest and the
   * artifact already submitted to the Chrome Web Store; narrowing it there
   * would mean a new Chrome submission, which is a separate decision.
   */
  if (supabaseOrigin) {
    const narrowed = `${new URL(supabaseOrigin).origin}/*`
    manifest.host_permissions = manifest.host_permissions.map((pattern) =>
      pattern === SUPABASE_WILDCARD ? narrowed : pattern,
    )
  }

  return manifest
}
