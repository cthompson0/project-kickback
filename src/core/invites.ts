/**
 * The invite link, and how a code gets from a link into the extension.
 *
 * THE PROBLEM
 *
 * A person shares a link. The recipient does not have Watchside yet, so
 * whatever they land on must explain what Watchside is and how to install it -
 * and then, once installed, the extension has to learn which code brought
 * them. The obvious solution is a content script on the landing page, and it
 * is the wrong one: it means a new host permission, which Chrome shows the
 * user as "read your data on that site", for a one-off string.
 *
 * THE SHAPE THAT NEEDS NO NEW PERMISSION
 *
 *   1. the shared link points at the Watchside landing page, which explains the
 *      product and links to the Chrome Web Store;
 *   2. the landing page's "continue" button points at TWITCH, carrying the
 *      code as a query parameter;
 *   3. Watchside's content script already runs on twitch.tv - that is its whole
 *      job - so it reads the parameter there and hands it to the worker.
 *
 * The recipient therefore lands somewhere that makes sense at every step, and
 * the extension picks the code up on the first Twitch page it sees. No new
 * permission, no new host, no clipboard instructions.
 *
 * A CODE IS NOT A CREDENTIAL
 *
 * Holding one lets a signed-in account say "this person invited me" and
 * nothing else. It creates no friendship, grants no visibility, and cannot
 * bypass a block - see 0026. So carrying it in a URL is not a secret in a URL.
 */

/**
 * Where a shared invite points.
 *
 * The GitHub organisation is `Anoteros-Labs`, so the Pages host is
 * `anoteros-labs.github.io` WITH the hyphen. Trailing slash because the Pages
 * layout is a directory per page with an index.html inside it.
 *
 * NEW links are minted under `/watchside/`. The OLD `/kickback/invite/` path
 * is not retired: links already sitting in somebody's DMs must keep working
 * forever, so that route stays published and forwards to this one carrying `c`
 * untouched. Nothing here needs to know about that - a forwarded visitor
 * arrives at exactly the URL this constant builds.
 */
export const INVITE_LANDING_BASE = 'https://anoteros-labs.github.io/watchside/invite/'

/**
 * The query parameter the landing page's continue button carries to Twitch.
 *
 * Deliberately still `kickback_invite` after the rename. This name is a wire
 * contract between two things that update independently: the landing page
 * (which mints it) and the installed extension (which reads it). Renaming it
 * would strand anybody whose extension had not yet updated when the page did -
 * a silent, unreportable loss of referral credit, in exchange for a string no
 * user ever reads. The compatibility risk is real and the branding gain is
 * zero, so the old name stays.
 */
export const INVITE_PARAM = 'kickback_invite'

/** The same alphabet friend codes use, and the same length the server checks. */
const CODE_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{22}$/

/** Whether a string could be an invite code. The server decides if it IS one. */
export function isInviteCode(value: string): boolean {
  return CODE_PATTERN.test(value)
}

/**
 * Normalise whatever a person pasted.
 *
 * People paste the whole link, the code with spaces around it, or the code in
 * lower case. All three are the same intent, and refusing two of them would be
 * pedantry rather than validation.
 */
export function normalizeInviteCode(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null

  // A whole URL: take the parameter if it is there, otherwise the last path
  // segment, which is what a shortened link tends to leave behind.
  const fromUrl = trimmed.includes('://') || trimmed.includes('?') ? codeFromUrl(trimmed) : null
  const candidate = (fromUrl ?? trimmed).toUpperCase()
  return isInviteCode(candidate) ? candidate : null
}

/** The invite link to share. */
export function inviteLinkFor(code: string): string {
  return `${INVITE_LANDING_BASE}?c=${encodeURIComponent(code)}`
}

/**
 * The code carried by a URL, from either the landing page or Twitch.
 *
 * Accepts both parameter names so one function answers for both hops: `c` on
 * the landing page, `kickback_invite` on the Twitch continue link.
 */
export function codeFromUrl(url: string): string | null {
  const query = url.slice(url.indexOf('?') + 1)
  if (!url.includes('?')) return null

  for (const part of query.split(/[&#]/)) {
    const [rawKey, rawValue] = part.split('=')
    if (rawValue === undefined) continue
    if (rawKey !== INVITE_PARAM && rawKey !== 'c') continue
    let value: string
    try {
      value = decodeURIComponent(rawValue)
    } catch {
      // A malformed escape is not a code; treat it as absent rather than
      // throwing on somebody else's URL.
      continue
    }
    const code = value.trim().toUpperCase()
    if (isInviteCode(code)) return code
  }
  return null
}
