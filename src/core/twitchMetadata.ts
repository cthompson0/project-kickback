/**
 * Public Twitch metadata about a channel, as Kickback models it.
 *
 * WHAT THIS IS FOR
 *
 * Social Gravity knows a destination is `lirik` and that three friends are on
 * it. That is the important half. This is the other half: who `lirik` actually
 * is, whether they are streaming right now, and what of.
 *
 * ENRICHMENT, NEVER A DEPENDENCY
 *
 * Every field here is optional at the point of use. The map must render
 * exactly as it did before this file existed when metadata is missing, slow,
 * stale or broken - so nothing downstream may require a value, and nothing may
 * treat absence as an answer.
 *
 * PUBLIC ONLY
 *
 * Everything modelled here comes from Helix `Get Users` and `Get Streams`
 * called with an APP access token, which carries no user identity and no
 * scopes. There is no viewer-specific data in this file, and adding any would
 * be a different checkpoint with a different consent story.
 *
 * DISPLAY, NOT IDENTITY
 *
 * `displayName` is the authoritative Twitch casing and outranks anything the
 * browser learned from a page title - but it is still only text. The login
 * stays canonical for clustering, equality, JOIN, analytics and
 * opportunity keys. See docs/ANALYTICS.md.
 */

/**
 * Whether the destination is streaming.
 *
 *   live    - Twitch says a stream is up.
 *   offline - Twitch resolved the channel and says no stream is up. A fact.
 *   unknown - we have not been told. Not an answer, and must never be shown
 *             or ranked as though it were one.
 *
 * The third state is the whole point. A metadata outage, a cold cache and a
 * channel that has genuinely stopped streaming are three different things, and
 * collapsing them would let a network blip mark half the map as offline.
 */
export type LiveState = 'live' | 'offline' | 'unknown'

export interface ChannelMetadata {
  /** Canonical lowercase login. The key everything else is keyed by. */
  login: string
  /** Twitch's numeric user id, stable across renames. */
  userId: string | null
  /** Authoritative Twitch casing. Display only. */
  displayName: string | null
  /** Twitch CDN profile image. Host-checked; see isTwitchImageUrl. */
  profileImageUrl: string | null
  live: LiveState
  /** Category name, e.g. "Escape from Tarkov". Null when offline or unknown. */
  gameName: string | null
  /** Stream title as the creator wrote it. Clamped by CSS, never truncated here. */
  title: string | null
  viewerCount: number | null
  /** Epoch ms the stream started, for "live for 2h". */
  startedAt: number | null
  /** When this record was built, epoch ms. Freshness is the reader's call. */
  fetchedAt: number
}

/**
 * How long a record may be used.
 *
 * Two clocks, because the two halves change at completely different rates.
 * A creator's display name and avatar change a handful of times a year; their
 * viewer count changes every few seconds. One TTL for both would either hammer
 * Helix for names that never move or show a stream as live twenty minutes
 * after it ended.
 */
export const IDENTITY_TTL_MS = 12 * 60 * 60_000
/**
 * Two minutes for live data.
 *
 * Long enough that a panel open for an hour costs ~30 refreshes per
 * destination rather than one per presence heartbeat, short enough that
 * "LIVE" is not a lie for long after a stream ends. Viewer counts drifting by
 * two minutes is invisible; live-state drifting by twenty is not.
 */
export const LIVE_TTL_MS = 2 * 60_000

/**
 * How long a stale record may still be shown while a refresh is in flight.
 *
 * Stale-while-revalidate, bounded. Past this the record stops being evidence
 * and the destination falls back to `unknown` - which renders as today's plain
 * card rather than as "offline", because we no longer know.
 */
export const STALE_TOLERANCE_MS = 15 * 60_000

/** The most identities Helix accepts in one Get Users / Get Streams call. */
export const HELIX_BATCH_LIMIT = 100

/**
 * A Twitch login, as Twitch defines one.
 *
 * The gate that stops a user-controlled string becoming a request. Channels
 * reach us from presence rows, which came from a URL path, which came from
 * somebody's browser - so they are input, not data, and everything past this
 * point may assume the shape.
 */
const LOGIN_PATTERN = /^[a-z0-9_]{3,25}$/

export function isValidLogin(value: unknown): value is string {
  return typeof value === 'string' && LOGIN_PATTERN.test(value)
}

/**
 * Canonicalise and filter a batch of requested channels.
 *
 * Lowercases, drops anything that is not a login, and de-duplicates - so
 * `['LIRIK', 'lirik', 'not a login']` is one request for `lirik`.
 */
export function normalizeLogins(values: readonly unknown[]): string[] {
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const login = value.trim().toLowerCase()
    if (isValidLogin(login)) seen.add(login)
  }
  return [...seen]
}

/** Split into Helix-sized batches. */
export function chunk<T>(values: readonly T[], size = HELIX_BATCH_LIMIT): T[][] {
  const out: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size))
  }
  return out
}

/**
 * Twitch's own image hosts.
 *
 * Profile images are rendered inside a page we do not control, so the URL is
 * checked rather than trusted: it arrives through our own server, but it
 * originated at a third party, and "it came back from an API we called" is not
 * the same as "it is safe to put in a src attribute". Anything else falls back
 * to the generated avatar, which always works.
 */
const TWITCH_IMAGE_HOSTS = new Set(['static-cdn.jtvnw.net', 'static.twitchcdn.net'])

export function isTwitchImageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && TWITCH_IMAGE_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

/** Longest title we will carry. Beyond this is not information, it is payload. */
const MAX_TITLE = 140

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null
}

/**
 * Validate one record arriving from Kickback's own metadata endpoint.
 *
 * Our server, but still parsed rather than cast. The values in it came from
 * Twitch and pass through a cache; a shape assumption here is a shape
 * assumption about a third party's JSON, and those are the assumptions that
 * end up in a renderer.
 */
export function parseChannelMetadata(value: unknown, now: number): ChannelMetadata | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>

  const login = typeof raw.login === 'string' ? raw.login.trim().toLowerCase() : ''
  if (!isValidLogin(login)) return null

  const live: LiveState =
    raw.live === 'live' || raw.live === 'offline' || raw.live === 'unknown' ? raw.live : 'unknown'

  const displayName = text(raw.displayName, 64)
  const startedAt = typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt)
    ? raw.startedAt
    : null

  return {
    login,
    userId: typeof raw.userId === 'string' && /^\d{1,20}$/.test(raw.userId) ? raw.userId : null,
    // A display name must be the same word as the login, differing only in
    // case. Anything else is a rename, and a rename is not a spelling.
    displayName: displayName && displayName.toLowerCase() === login ? displayName : null,
    profileImageUrl: isTwitchImageUrl(raw.profileImageUrl) ? raw.profileImageUrl : null,
    live,
    // Only a live stream has these. Carrying them while offline would let a
    // card say "LIVE · Escape from Tarkov" with the badge removed.
    gameName: live === 'live' ? text(raw.gameName, 64) : null,
    title: live === 'live' ? text(raw.title, MAX_TITLE) : null,
    viewerCount: live === 'live' ? count(raw.viewerCount) : null,
    startedAt: live === 'live' ? startedAt : null,
    fetchedAt: typeof raw.fetchedAt === 'number' && Number.isFinite(raw.fetchedAt)
      ? raw.fetchedAt
      : now,
  }
}

export function parseMetadataResponse(value: unknown, now: number): ChannelMetadata[] {
  if (!value || typeof value !== 'object') return []
  const channels = (value as Record<string, unknown>).channels
  if (!Array.isArray(channels)) return []
  return channels
    .map((entry) => parseChannelMetadata(entry, now))
    .filter((entry): entry is ChannelMetadata => entry !== null)
}

/**
 * The live state a record may still be believed to assert.
 *
 * Past the stale tolerance a record stops being evidence about *now*. Its
 * identity half - name, avatar - is still perfectly good and keeps being used,
 * because a display name from an hour ago is not wrong. Its live half is
 * downgraded to `unknown`, so an old record renders as today's plain card
 * rather than confidently claiming a stream that ended.
 */
export function liveStateOf(
  metadata: ChannelMetadata | undefined,
  now: number,
  tolerance = STALE_TOLERANCE_MS,
): LiveState {
  if (!metadata) return 'unknown'
  return now - metadata.fetchedAt <= tolerance ? metadata.live : 'unknown'
}

/** Whether the live half is old enough to be worth refetching. */
export function needsRefresh(
  metadata: ChannelMetadata | undefined,
  now: number,
  ttl = LIVE_TTL_MS,
): boolean {
  return !metadata || now - metadata.fetchedAt >= ttl
}

/**
 * "18.4K". Compact, because it is context and must not out-shout the friends.
 *
 * Deliberately not `Intl.NumberFormat(notation: 'compact')`: that is
 * locale-dependent, and a viewer count that reads differently for two people
 * looking at the same stream is a support question for no benefit.
 */
export function formatViewers(count: number): string {
  if (count < 1_000) return String(count)
  if (count < 1_000_000) {
    const thousands = count / 1_000
    return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}K`
  }
  const millions = count / 1_000_000
  return `${millions < 10 ? millions.toFixed(1) : Math.round(millions)}M`
}
