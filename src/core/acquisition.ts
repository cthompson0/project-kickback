/**
 * Acquisition attribution: how somebody came to Watchside in the first place.
 *
 * THREE DIFFERENT QUESTIONS, AND THIS FILE ANSWERS ONE OF THEM
 *
 *   acquisition   how did this person discover Watchside - TikTok, X, a
 *                 creator's stream, a link in a Discord
 *   friend referral   which existing Watchside user invited them - core/invites.ts,
 *                 durable since 0026, and NOT this
 *   creator/campaign  which creator or campaign the touch belonged to - carried
 *                 by the campaign registry, not by the URL
 *
 * A person can have all three. Alice arrives from a streamer campaign and
 * invites Bob; Bob's friend referral is Alice, and Bob's acquisition is
 * whatever brought Bob. Collapsing those into one `referrer` field is how an
 * analytics system starts lying, so they are separate all the way down: a
 * different URL prefix, a different query parameter, a different table, a
 * different RPC.
 *
 * THE URL IS NOT THE METADATA
 *
 * A campaign link carries ONE thing: an opaque campaign code. It does not carry
 * a source, a creator name, or anything else a visitor could edit. Everything
 * about what a campaign IS resolves server-side from the registry, so a person
 * who types `?source=official_twitch_partnership` into a URL changes nothing at
 * all. That is the whole reason the code is the only payload.
 *
 * WHAT THIS CANNOT SEE
 *
 * The web page, the Store listing and the extension are three separate
 * execution contexts, and only the third is ours. There is no honest way to
 * observe a link click or an install without tracking people across sites, so
 * Watchside does not try. The touch becomes observable at the moment it binds
 * to an authenticated account and not before - see the report's observability
 * map for what that costs.
 */

/**
 * The campaign-link path prefix, deliberately not `/i/`.
 *
 * `/i/<code>` means a friend invited you. `/c/<code>` means a campaign brought
 * you. Overloading one prefix would mean a code's meaning depended on context,
 * and the first ambiguous case would be discovered in a report six weeks later.
 */
export const CAMPAIGN_PATH = '/c/'

/**
 * The parameter carried to Twitch, alongside but never instead of the invite.
 *
 * A separate key from `kickback_invite` because they are separate facts and a
 * visitor may legitimately carry both - a creator's campaign link cannot also
 * be a friend's invite, but a person who followed one and then the other has
 * both in play. Two keys means neither can be mistaken for the other, and the
 * invite's wire contract with released clients is untouched.
 *
 * New name, no legacy: nothing shipped reads this yet, which is exactly why the
 * measurement it enables cannot be trusted until a build carrying it is
 * distributed.
 */
export const CAMPAIGN_PARAM = 'watchside_campaign'

/**
 * What a campaign code may look like.
 *
 * Lowercase, hyphen-separated, 2-32 characters: `tiktok-launch`, `lirik-oct`.
 * Readable on purpose - these end up in a streamer's panel text and a TikTok
 * bio, where an opaque hash is a thing people mistype and nobody can sanity
 * check.
 *
 * IT IS AN IDENTITY, NOT A LABEL. The code is immutable; the human-readable
 * name of the campaign lives in a separate column that can be edited freely. A
 * campaign renamed from "October creator test" to "LIRIK October" keeps the
 * same code, so every link already sitting in a YouTube description, a Discord
 * message, a screenshot or a bookmark keeps working. Deriving the URL from a
 * display name would have made a rename a silent link breakage.
 */
const CAMPAIGN_CODE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/

/** Whether a string could be a campaign code. The registry decides if it IS one. */
export function isCampaignCode(value: string): boolean {
  return CAMPAIGN_CODE_PATTERN.test(value)
}

/**
 * Normalise whatever arrived - a bare code, or a whole link somebody pasted.
 *
 * Case-folded because a code read off a stream overlay is often retyped in
 * whatever case the person felt like, and refusing that would be pedantry.
 * Returns null rather than throwing: an unusable code is an ordinary outcome,
 * not an error, and it must never be able to break the page it arrived on.
 */
export function normalizeCampaignCode(value: string): string | null {
  const trimmed = value.trim().toLowerCase()
  if (trimmed.length === 0) return null

  const candidate = trimmed.includes('://') || trimmed.includes('?')
    ? (campaignFromUrl(trimmed) ?? campaignFromPath(trimmed))
    : trimmed
  if (candidate === null) return null
  return isCampaignCode(candidate) ? candidate : null
}

/** The code carried by a URL's query - the Twitch hop's shape. */
export function campaignFromUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const raw = parsed.searchParams.get(CAMPAIGN_PARAM)
  if (raw === null) return null
  const code = raw.trim().toLowerCase()
  return isCampaignCode(code) ? code : null
}

/**
 * The code carried by a canonical `/c/<code>` path.
 *
 * Deliberately requires the `/c/` prefix rather than taking the last segment.
 * This runs against arbitrary URLs, and a bare trailing segment is a channel
 * name, an article slug, or anything else - matching one of those against the
 * campaign alphabet would attribute somebody to a campaign that never existed.
 */
function campaignFromPath(url: string): string | null {
  const withoutQuery = url.split(/[?#]/)[0]
  const match = /\/c\/([^/?#]+)\/?$/.exec(withoutQuery)
  if (!match) return null

  let decoded: string
  try {
    decoded = decodeURIComponent(match[1])
  } catch {
    return null
  }
  const code = decoded.trim().toLowerCase()
  return isCampaignCode(code) ? code : null
}

/** The campaign link to publish, for a code the registry already knows. */
export function campaignLinkFor(code: string, base = 'https://watchside.app'): string {
  return `${base}${CAMPAIGN_PATH}${encodeURIComponent(code)}`
}

// --------------------------------------------------------- attribution window

/**
 * How long a campaign touch stays eligible to bind, in milliseconds.
 *
 * SEVEN DAYS, and the number is reasoned rather than borrowed.
 *
 * The chain this has to survive is: click the link → read the page → install
 * from the Store → open Twitch → sign in to Watchside. The first four steps are
 * usually one sitting, but the last is not: somebody who installs on a Tuesday
 * because a streamer mentioned it may not open Twitch and sign in until the
 * weekend. A window shorter than that would drop real acquisitions and make
 * every campaign look worse than it was.
 *
 * The other direction matters more. `null` - keep it forever - is the default
 * that happens by accident, and it is the one that quietly corrupts the data:
 * a code left in storage for two months would attribute a completely unrelated
 * later sign-in to a campaign that had nothing to do with it. Seven days is
 * long enough to cover the honest lag and short enough that a stale touch
 * expires instead of lying.
 *
 * PROVISIONAL. It is a judgement made before there is any data about the real
 * click-to-auth distribution. Once there is, the right move is to measure the
 * lag and revisit - and because the window is enforced in one pure function
 * with its own tests, revisiting it is a one-line change with a proof attached.
 */
export const ATTRIBUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Whether a touch captured at `capturedAt` may still bind at `now`.
 *
 * Boundary is INCLUSIVE of the window and exclusive beyond it: a touch exactly
 * seven days old still binds, one millisecond later does not. Stated because a
 * boundary nobody wrote down is a boundary two tests will disagree about.
 *
 * A touch from the future is refused. Clocks are wrong sometimes, and a machine
 * whose clock is a year ahead would otherwise hold a code that never expires.
 */
export function isWithinAttributionWindow(capturedAt: number, now: number): boolean {
  if (!Number.isFinite(capturedAt) || !Number.isFinite(now)) return false
  if (capturedAt > now) return false
  return now - capturedAt <= ATTRIBUTION_WINDOW_MS
}

/** A campaign touch this browser saw, waiting for an account to attach to. */
export interface PendingCampaignTouch {
  code: string
  capturedAt: number
}

/**
 * What to do with a touch that has just arrived, given one already held.
 *
 * FIRST TOUCH IS THE ONE THAT MATTERS, so a held touch is not replaced by a
 * newer one while both are still pre-auth. Somebody who arrives from a
 * streamer campaign, wanders off, and comes back through a TikTok link two days
 * later was acquired by the streamer; overwriting would credit the last link
 * that happened to be clicked, which is the easiest way to make every campaign
 * report agree that whichever link was posted most recently is the best one.
 *
 * An EXPIRED held touch is replaced rather than kept - it can no longer bind, so
 * holding it would block a touch that can.
 *
 * The server keeps last-touch separately, from binds it actually saw. This is
 * only about which single pre-auth touch survives to be bound at sign-in.
 */
export function nextPendingTouch(
  held: PendingCampaignTouch | null,
  arriving: PendingCampaignTouch,
  now: number,
): PendingCampaignTouch {
  if (!held) return arriving
  if (!isWithinAttributionWindow(held.capturedAt, now)) return arriving
  return held
}

/** Whether a held touch should still be offered to the server at all. */
export function touchIsBindable(
  held: PendingCampaignTouch | null,
  now: number,
): held is PendingCampaignTouch {
  if (!held) return false
  if (!isCampaignCode(held.code)) return false
  return isWithinAttributionWindow(held.capturedAt, now)
}

/** Every outcome the server may report for a bind. All of them are ordinary. */
export type BindOutcome = 'first' | 'repeat' | 'unknown' | 'inactive'
