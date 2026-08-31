/**
 * Deciding whether a follow baseline may be recorded at all.
 *
 * Kept pure and apart from index.ts because this is where a request stops being
 * a claim and becomes permission to write a row. Every rule here is one a client
 * would otherwise be trusted to follow, and none of them should only be
 * exercisable through a deployed function.
 *
 * WHAT AN ATTRIBUTION ID ACTUALLY IS
 *
 * When somebody clicks JOIN, the worker mints an attribution and the resulting
 * `join_clicked` event reaches `analytics_events` through `analytics_track`,
 * whose actor is `auth.uid()` server-side. So the event is a record the client
 * cannot forge on somebody else's behalf, and it carries everything the binding
 * needs: whose JOIN it was, which creator it was aimed at, when it happened, and
 * how many friends were there.
 *
 * That is what makes an attribution id checkable rather than merely quoted. A
 * client supplying a random one finds no event; a client supplying somebody
 * else's finds an event belonging to another actor.
 */

/**
 * How long after the JOIN click a baseline still counts as "at the JOIN".
 *
 * The arrival window is 90 seconds, so this is deliberately a little wider -
 * enough for the arrival and a Twitch round trip, and nowhere near enough for
 * the answer to drift into "followed some time later". A request outside it is
 * refused rather than recorded with a caveat, because a caveat in a column
 * nobody reads becomes a false baseline in every downstream number.
 *
 * THE FUTURE CALLER MUST RESPECT THIS. A queue, a retry after a long backoff,
 * or a background sweep would all silently turn following_at_join into
 * following_some_time_later.
 */
export const BASELINE_WINDOW_MS = 120_000

/** The `join_clicked` row, as the server reads it back. */
export interface JoinContext {
  actorId: string
  destinationChannel: string | null
  occurredAt: string
  socialCount: number
}

export type AttributionCheck =
  | { ok: true }
  | {
      ok: false
      reason:
        | 'unknown_attribution'
        | 'destination_mismatch'
        | 'not_socially_initiated'
        | 'outside_baseline_window'
    }

/** Twitch's own login grammar. Anything else is not a creator. */
export function isLogin(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9_]{1,25}$/.test(value)
}

export function normalizeLogin(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const login = value.trim().toLowerCase()
  return isLogin(login) ? login : null
}

/**
 * May this actor record a baseline for this creator, against this attribution?
 *
 * The order is deliberate: existence, then ownership is already implied by how
 * the row was fetched, then destination, then social context, then timing. Each
 * failure has its own reason so the caller can say something true about why
 * nothing was recorded.
 */
export function validateAttribution(input: {
  /** Null when no `join_clicked` row exists for this attribution AND actor. */
  join: JoinContext | null
  broadcasterLogin: string
  now: number
  windowMs?: number
}): AttributionCheck {
  const { join, broadcasterLogin, now } = input
  const windowMs = input.windowMs ?? BASELINE_WINDOW_MS

  // No such JOIN, or it belongs to somebody else. The lookup is always scoped
  // to the authenticated actor, so both cases arrive here identically - and
  // both must refuse.
  if (!join) return { ok: false, reason: 'unknown_attribution' }

  /*
   * The destination is bound to the attribution, not supplied alongside it.
   *
   * Without this a caller could quote a real JOIN of their own and name any
   * creator they liked, manufacturing baselines for channels they never
   * visited.
   */
  if (join.destinationChannel !== broadcasterLogin) {
    return { ok: false, reason: 'destination_mismatch' }
  }

  // M3D measures SOCIALLY INITIATED discovery. A JOIN with nobody there is a
  // real JOIN and simply not part of this population.
  if (!(join.socialCount > 0)) return { ok: false, reason: 'not_socially_initiated' }

  const clickedAt = Date.parse(join.occurredAt)
  if (Number.isNaN(clickedAt)) return { ok: false, reason: 'outside_baseline_window' }
  if (now - clickedAt > windowMs || clickedAt - now > windowMs) {
    return { ok: false, reason: 'outside_baseline_window' }
  }

  return { ok: true }
}

/**
 * What the caller is told.
 *
 * Deliberately never the answer. `recorded` means a baseline now exists;
 * `unavailable` means one does not, and why in terms that describe Watchside's
 * own state rather than the user's Twitch relationships.
 *
 * A client that could distinguish "recorded true" from "recorded false" would
 * have the follow result, which is the one thing this whole boundary exists to
 * keep server-side.
 */
export type RelationshipReason =
  | 'unknown_attribution'
  | 'destination_mismatch'
  | 'not_socially_initiated'
  | 'outside_baseline_window'
  | 'unknown_broadcaster'
  | 'needs_follow_permission'
  | 'needs_reauthorization'
  | 'temporarily_unavailable'
  | 'twitch_unavailable'

export type RelationshipResult =
  | { state: 'recorded' }
  | { state: 'unavailable'; reason: RelationshipReason }

/**
 * Strips a result down to what may cross the boundary.
 *
 * A single funnel every response passes through, so "did we accidentally return
 * the follow result" is one place to check rather than a property of every
 * branch.
 */
export function toClientResponse(result: RelationshipResult): Record<string, unknown> {
  return result.state === 'recorded'
    ? { state: 'recorded' }
    : { state: 'unavailable', reason: result.reason }
}
