/**
 * Kickback's analytics vocabulary.
 *
 * This is the whole contract: every event that may be emitted, every property
 * it may carry, and the shape that goes on the wire. It is pure - no Supabase,
 * no chrome, no React - so feature code can name an event without knowing that
 * a database exists, and so the rules can be tested without either.
 *
 * WHAT THIS DELIBERATELY CANNOT EXPRESS
 *
 * A property is one small fact: a count, a bucket, a flag, a short enum. There
 * is no way to attach a message body, a search term, a token, an email or a
 * URL, because values are capped at 64 characters and unknown keys are dropped
 * on both sides of the wire. The privacy rule is enforced by the type of the
 * data, not by remembering to be careful at each call site.
 *
 * The same contract is stated again in supabase/migrations/0013_analytics.sql,
 * because the server must not trust this file - a modified extension can send
 * anything. tests/extension/analyticsContract.test.ts reads the SQL and asserts
 * the two agree, so the duplication cannot drift.
 */

/** Which build produced an event. A property of the build, not a claim about a person. */
export type AnalyticsEnvironment = 'development' | 'private_beta' | 'production'

export const ANALYTICS_ENVIRONMENTS: readonly AnalyticsEnvironment[] = [
  'development',
  'private_beta',
  'production',
]

/**
 * Which Kickback surface an event came from.
 *
 * Shared with JoinSource rather than parallel to it: "which surface drove a
 * JOIN" and "which surface showed the opportunity" have to use the same
 * vocabulary or the funnel cannot be joined up.
 */
export type AnalyticsSurface =
  | 'friend_row'
  | 'user_card'
  | 'gathering'
  | 'notification'
  | 'group'
  /** Reserved. Nothing emits these yet; see the Social Gravity checkpoint. */
  | 'social_gravity'
  | 'stream_room'

/** A property value is a small fact. Never a document, never content. */
export type AnalyticsValue = string | number | boolean | null

export const MAX_PROPERTY_VALUE_LENGTH = 64
export const MAX_PROPERTIES = 12

/**
 * Every event, with the exact properties it carries.
 *
 * Adding one is this entry plus a row in analytics_event_names. Nothing else -
 * no transport change, no message type, no plumbing.
 */
export interface AnalyticsEventMap {
  // ---------------------------------------------------------------- lifecycle
  extension_session_started: Record<string, never>
  extension_session_ended: { duration_ms: number; end_reason: SessionEndReason }
  authenticated_session_started: { friend_count: number; group_count: number }

  // ------------------------------------------------------------- social graph
  /** The query itself is never recorded - only whether it found anyone. */
  friend_search: { result_count: number; matched_by: 'twitch_login' | 'friend_code' | 'none' }
  friend_request_sent: { outcome: string }
  friend_request_accepted: { direction: 'incoming' | 'outgoing' }
  friend_removed: Record<string, never>
  group_invite_sent: { member_count: number }
  group_invite_accepted: { member_count: number }

  // -------------------------------------------------------- presence exposure
  /**
   * Social information was SHOWN, not merely held. Deduped per person and
   * channel; see exposure.ts for the window.
   */
  friend_presence_impression: { state: 'watching_with_you' | 'watching_elsewhere'; visible_count: number }
  gathering_impression: { friend_count: number; rank: number; visible_count: number }
  /** Reserved for Social Gravity. Registered now so that checkpoint adds no plumbing. */
  gravity_cluster_impression: { friend_count: number; rank: number; visible_clusters: number }

  // --------------------------------------------------------------------- join
  join_clicked: {
    social_count: number
    already_on_twitch: boolean
    already_on_destination: boolean
    navigated: boolean
  }
  join_arrived: { elapsed_ms: number }

  // --------------------------------------------------------- watching together
  watching_together_started: { other_count: number; from_join: boolean }
  watching_together_ended: {
    other_count_peak: number
    duration_ms: number
    end_reason: TogetherEndReason
  }

  // --------------------------------------------------------------- gatherings
  gathering_notification_shown: { friend_count: number }
  gathering_notification_clicked: { friend_count: number }

  // ----------------------------------------------------------- groups and chat
  group_created: Record<string, never>
  group_opened: { member_count: number }
  /** Shape only. No body, no emote identity - see docs/ANALYTICS.md. */
  group_message_sent: { length_bucket: LengthBucket; has_emote: boolean }
  combo_formed: { count: number }
  combo_broken: { count: number }
}

export type AnalyticsEventName = keyof AnalyticsEventMap

export type SessionEndReason = 'idle' | 'signed_out'
export type TogetherEndReason = 'left_channel' | 'alone_again' | 'session_ended'
export type LengthBucket = 'short' | 'medium' | 'long'

/** Message length as a bucket, because the length itself is nearly the message. */
export function lengthBucket(length: number): LengthBucket {
  if (length <= 20) return 'short'
  if (length <= 120) return 'medium'
  return 'long'
}

/**
 * The property keys each event may carry.
 *
 * Derived by hand rather than from the types, because types vanish at runtime
 * and this list is what actually does the stripping.
 */
export const EVENT_PROPERTIES: Record<AnalyticsEventName, readonly string[]> = {
  extension_session_started: [],
  extension_session_ended: ['duration_ms', 'end_reason'],
  authenticated_session_started: ['friend_count', 'group_count'],

  friend_search: ['result_count', 'matched_by'],
  friend_request_sent: ['outcome'],
  friend_request_accepted: ['direction'],
  friend_removed: [],
  group_invite_sent: ['member_count'],
  group_invite_accepted: ['member_count'],

  friend_presence_impression: ['state', 'visible_count'],
  gathering_impression: ['friend_count', 'rank', 'visible_count'],
  gravity_cluster_impression: ['friend_count', 'rank', 'visible_clusters'],

  join_clicked: ['social_count', 'already_on_twitch', 'already_on_destination', 'navigated'],
  join_arrived: ['elapsed_ms'],

  watching_together_started: ['other_count', 'from_join'],
  watching_together_ended: ['other_count_peak', 'duration_ms', 'end_reason'],

  gathering_notification_shown: ['friend_count'],
  gathering_notification_clicked: ['friend_count'],

  group_created: [],
  group_opened: ['member_count'],
  group_message_sent: ['length_bucket', 'has_emote'],
  combo_formed: ['count'],
  combo_broken: ['count'],
}

export const ANALYTICS_EVENT_NAMES = Object.keys(EVENT_PROPERTIES) as AnalyticsEventName[]

/** What one event looks like on the wire, and in the database. */
export interface AnalyticsEvent {
  event_name: AnalyticsEventName
  environment: AnalyticsEnvironment
  occurred_at: string
  session_id: string | null
  app_version: string | null
  source: AnalyticsSurface | null
  /** Lowercase Twitch login. Never a URL, never a path. */
  destination_channel: string | null
  attribution_id: string | null
  properties: Record<string, AnalyticsValue>
}

/** Everything a call site supplies; the recorder fills in the rest. */
export interface TrackRequest<N extends AnalyticsEventName = AnalyticsEventName> {
  name: N
  properties?: Partial<AnalyticsEventMap[N]>
  source?: AnalyticsSurface
  channel?: string | null
  attributionId?: string | null
  /**
   * For events the worker reconstructs after the fact - notably the end of a
   * session that expired while the worker was asleep, which belongs to the old
   * session rather than the one now starting.
   */
  sessionId?: string | null
  /** Defaults to now. Set when reconstructing something that already happened. */
  occurredAt?: number
}

/** The same channel rule the database enforces, applied before sending. */
const CHANNEL = /^[a-z0-9_]{1,25}$/

export function normalizeChannel(channel: string | null | undefined): string | null {
  if (typeof channel !== 'string') return null
  const login = channel.trim().toLowerCase()
  return CHANNEL.test(login) ? login : null
}

/**
 * Keeps only what the contract allows.
 *
 * Applied here as well as in SQL. Not because the server's copy is optional -
 * it is the one that counts - but because stripping locally means a stray
 * value never leaves the machine at all, and because it makes the rule
 * testable without a database.
 */
export function cleanProperties(
  name: AnalyticsEventName,
  properties: Record<string, unknown> | undefined,
): Record<string, AnalyticsValue> {
  const allowed = EVENT_PROPERTIES[name]
  const out: Record<string, AnalyticsValue> = {}
  if (!allowed || !properties) return out

  for (const key of allowed) {
    if (!Object.hasOwn(properties, key)) continue
    if (Object.keys(out).length >= MAX_PROPERTIES) break

    const value = properties[key]
    if (value === null) {
      out[key] = null
    } else if (typeof value === 'boolean') {
      out[key] = value
    } else if (typeof value === 'number') {
      // NaN and Infinity are not facts about anything.
      if (Number.isFinite(value)) out[key] = value
    } else if (typeof value === 'string') {
      if (value.length <= MAX_PROPERTY_VALUE_LENGTH) out[key] = value
    }
    // Objects, arrays and functions are dropped without comment: a property is
    // never a document.
  }

  return out
}

export function isAnalyticsEventName(value: unknown): value is AnalyticsEventName {
  return typeof value === 'string' && Object.hasOwn(EVENT_PROPERTIES, value)
}

/**
 * Turns a call site's request into the wire shape.
 *
 * Returns null for an event name the contract does not know, so a typo is
 * dropped at the boundary rather than sent and silently discarded by the
 * server.
 */
export function buildEvent(
  request: TrackRequest,
  context: {
    environment: AnalyticsEnvironment
    sessionId: string | null
    appVersion: string | null
    now: number
  },
): AnalyticsEvent | null {
  if (!isAnalyticsEventName(request.name)) return null

  return {
    event_name: request.name,
    environment: context.environment,
    occurred_at: new Date(request.occurredAt ?? context.now).toISOString(),
    session_id: request.sessionId ?? context.sessionId,
    app_version: context.appVersion,
    source: request.source ?? null,
    destination_channel: normalizeChannel(request.channel),
    attribution_id: request.attributionId ?? null,
    properties: cleanProperties(request.name, request.properties),
  }
}
