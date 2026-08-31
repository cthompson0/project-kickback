/**
 * Watchside's analytics vocabulary.
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

import type { FeedbackCategory } from '../client/types'
import type { ExperimentArm } from './experiment'
import type {
  FailureCode,
  FailureContext,
  RealtimeStatus,
  RealtimeSurface,
} from './failures'

/** Which build produced an event. A property of the build, not a claim about a person. */
export type AnalyticsEnvironment = 'development' | 'private_beta' | 'production'

export const ANALYTICS_ENVIRONMENTS: readonly AnalyticsEnvironment[] = [
  'development',
  'private_beta',
  'production',
]

/**
 * Which Watchside surface an event came from.
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
  | 'social_gravity'
  /*
   * Automatic Together.
   *
   * This slot was reserved as 'stream_room' and is renamed rather than joined
   * by a second name: the product turned out not to be a room at all - nothing
   * is created, owned or joined - and carrying both would mean two words for
   * one surface in every query. It had never been emitted, so nothing
   * recorded changes meaning.
   */
  | 'together'

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
  /**
   * A signed-in session began.
   *
   * `experiment_arm` is present ONLY when the assignment is a real
   * randomisation - see isRandomisedArm(). In development and private beta
   * everybody is forced into `gravity`, and recording that would file a
   * constant as an experiment result, which is how a fake causal claim gets
   * into a deck. Absent is therefore the correct value there, not 'gravity'.
   */
  authenticated_session_started: {
    friend_count: number
    group_count: number
    experiment_arm?: ExperimentArm
  }

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
  gravity_cluster_impression: {
    friend_count: number
    rank: number
    visible_clusters: number
    /** Reserved, as on join_clicked: which opportunity was shown. */
    opportunity_key?: string
    /**
     * Whether Twitch said the destination was streaming when it was shown.
     *
     * Absent when nothing told us, which is a third state and not a false.
     * Answers "are we showing people streams that have ended", and nothing
     * else about the stream is recorded.
     */
    destination_live?: boolean
  }

  // ----------------------------------------------------------- together
  //
  // Four events, and deliberately no lifecycle: watching_together_started /
  // _ended and post_social_retention_ended already measure the shared watch
  // itself, and measuring it twice would be two chances to disagree.
  //
  // No reaction CONTENT anywhere. Which of five emoji somebody pressed
  // answers no question we have, and "what did this person react to" is a
  // surveillance-shaped fact rather than a product one.
  automatic_room_entered: {
    /** Everyone in the connected component, including the viewer. */
    participant_count: number
    /**
     * How many of them the viewer actually knows.
     *
     * Beside the total because it is the question the connected-component
     * model exists to answer: is friend-of-friend exposure really happening,
     * or is every room just the viewer's own friends? The totals alone cannot
     * tell us.
     */
    direct_friend_count: number
  }
  automatic_room_opened: {
    participant_count: number
    direct_friend_count: number
    /**
     * Which way in was used.
     *
     * The whole navigation bet is that a contextual tab gets opened on its own
     * rather than only from the affordance it used to hide behind, so the
     * answer has to be in the event. 'restored' is a selection that survived a
     * Twitch refresh, which is a different claim again - it says the session
     * was worth coming back to.
     */
    opened_from: RoomOpenedFrom
  }
  /**
   * An ephemeral message was sent in a Stream Room.
   *
   * Length bucket and an emote flag only. The body is never recorded - it
   * answers no question we have, and a conversation among four people watching
   * a stream is not ours to keep.
   */
  automatic_room_message_sent: {
    length_bucket: LengthBucket
    has_emote: boolean
    participant_count: number
  }
  automatic_room_reaction: {
    participant_count: number
    /**
     * Sent or received.
     *
     * One event with a direction rather than two events: they are the same
     * interaction seen from two sides, and the viewer's own reaction arrives
     * back through the same realtime path as everyone else's - so recording it
     * once is the only way the two cannot disagree about how many there were.
     */
    direction: 'sent' | 'received'
  }
  automatic_room_combo: {
    /** Distinct people who reacted the same way at the same moment. */
    combo_size: number
    participant_count: number
  }

  // --------------------------------------------------------------------- join
  join_clicked: {
    social_count: number
    already_on_twitch: boolean
    already_on_destination: boolean
    navigated: boolean
    /**
     * Identity of the social opportunity acted on, when there is one.
     *
     * Registered and currently unset. A friend row is one person and needs no
     * key; a Social Gravity cluster is a thing several people can act on
     * separately, and counting how many viewers ONE gathering produced needs
     * them to agree on what one gathering was. Reserved here so that
     * checkpoint sets a property rather than changing a contract.
     */
    opportunity_key?: string
  }
  join_arrived: { elapsed_ms: number }

  // --------------------------------------------------------- watching together
  watching_together_started: { other_count: number; from_join: boolean }
  /**
   * Recorded at the moment co-viewing actually stopped, not when we noticed.
   * See togetherWatch.ts - the two can be forty minutes apart.
   */
  watching_together_ended: {
    other_count_peak: number
    duration_ms: number
    end_reason: TogetherEndReason
    /** How long after the fact this was worked out. Zero when immediate. */
    detection_delay_ms: number
  }
  /**
   * One observed stream-dwell interval: how long Watchside could see one LIVE
   * Twitch stream.
   *
   * THE DENOMINATOR. Every other viewing measurement here is a socially
   * selected subset - watching_together is time spent with a friend,
   * post_social_retention is the tail after they left - so neither can say
   * what share of somebody's viewing Watchside touched, and a future holdout
   * would have nothing to compare because the control arm produces no shared
   * watches at all.
   *
   * PER STREAM, AND CONCURRENT STREAMS BOTH COUNT. Two streams legitimately
   * open for an hour are two observed stream-hours and one wall-clock hour.
   * Both are derivable - `started_at = occurred_at - duration_ms` - and they
   * must never be confused: summed stream-minutes are NOT "minutes the user
   * spent watching Twitch". See docs/ANALYTICS.md §8b and §14.
   *
   * FOCUS IS A DIMENSION, NOT A GATE. A stream on a second monitor is still
   * being consumed, so losing focus does not end an interval; which stream was
   * in front of the viewer is carried alongside instead, with
   * `focused_duration_ms + background_duration_ms = duration_ms` exactly.
   *
   * There is deliberately no matching start event, for the same reason
   * post_social_retention_ended has none: the interval is fully described by
   * its end, and a second event would be a second chance to disagree.
   */
  channel_dwell_ended: {
    duration_ms: number
    /** The part of duration_ms this stream was the viewer's primary destination. */
    focused_duration_ms: number
    /** duration_ms - focused_duration_ms. Carried rather than derived so a
     *  query cannot get the subtraction wrong or forget it exists. */
    background_duration_ms: number
    /** True when an active JOIN attribution legitimately covered this viewing. */
    from_join: boolean
    /** True when a shared watch was open on THIS stream during the interval. */
    had_social: boolean
    end_reason: DwellEndReason
  }

  /**
   * The user stayed on a socially-attributed destination after the last person
   * they were watching with had gone - and has now left it too.
   *
   * There is deliberately no matching start event: the interval begins exactly
   * where watching_together_ended's effective time is, so one would be a second
   * copy of a fact we already have, with a second chance to disagree with it.
   */
  post_social_retention_ended: {
    duration_ms: number
    /** False for organic co-viewing that no JOIN brought about. */
    from_join: boolean
    end_reason: PostSocialEndReason
  }

  // --------------------------------------------------------------- gatherings
  gathering_notification_shown: { friend_count: number }
  gathering_notification_clicked: { friend_count: number }

  // ----------------------------------------------------------- groups and chat
  group_created: Record<string, never>
  group_opened: { member_count: number }
  /** Shape only. No body, no emote identity - see docs/ANALYTICS.md. */
  group_message_sent: { length_bucket: LengthBucket; has_emote: boolean }
  /**
   * Somebody blocked, or unblocked, another user.
   *
   * No properties at all, and that is deliberate. Who was blocked - as an id, a
   * login or a name - would turn this table into a record of who dislikes whom,
   * which is far more sensitive than anything else Watchside keeps and answers no
   * question we have. Whether people need the feature is answered by a count.
   *
   * There is no reason field either. That would be Report, which is a different
   * feature with different obligations.
   */
  user_blocked: Record<string, never>
  user_unblocked: Record<string, never>
  /**
   * Somebody sent in-product feedback.
   *
   * The category, and nothing else. What they wrote lives in public.feedback,
   * which is a different table with different rules - analytics is built on the
   * promise that it never contains free text, and this event keeps that promise
   * while still answering "is anybody using this, and what for".
   */
  feedback_submitted: { category: FeedbackCategory }
  combo_formed: { count: number }
  combo_broken: { count: number }

  // ------------------------------------------------------------- diagnostics
  /*
   * Something failed, and we would like to know that without knowing what.
   *
   * Both properties come from fixed arrays in core/failures.ts - a call site
   * from a known list, and a shape from a known list. Nothing is derived from
   * an exception message, which is the only reason an error event is safe to
   * put through a pipeline built on the promise that it contains no free text.
   * See docs/reports/friends-beta-investigation-2026-08-27.md §17.
   */
  client_error: { context: FailureContext; code: FailureCode }
  /**
   * How many destinations this client published.
   *
   * Bucketed, never the channels themselves - the question is whether a cap of
   * three is too restrictive, and a count answers it while a list would be a
   * viewing record. `at_max` is the specific signal: it is what tells us the
   * limit actually bit rather than merely being high.
   */
  destinations_published: { count_bucket: DestinationCountBucket; at_max: boolean }
  /**
   * A Stream Room surface went away, and why.
   *
   * The counterpart to automatic_room_entered, which had no exit event - so
   * how long rooms last, and what ends them, was unanswerable.
   */
  automatic_room_left: { reason: RoomEndReason; had_messages: boolean }
  /**
   * A realtime subscription changed state.
   *
   * `connected` is recorded as well as failures, because a channel that never
   * connected and a channel nobody opened look identical otherwise - and
   * telling those apart is the single thing that would have made the first
   * external bug report diagnosable.
   */
  realtime_status_changed: { surface: RealtimeSurface; status: RealtimeStatus }
  /**
   * A group message was refused.
   *
   * Separate from client_error because it answers a specific product question:
   * "did she send and never see it, or never send at all". The body is not
   * here and never will be.
   */
  group_message_send_failed: { code: FailureCode }

  /*
   * THE GROWTH LOOP.
   *
   * Acquisition, network formation and the invite cycle. Every one of these is
   * a count, a bucket or a fixed vocabulary - no user ids, no codes, no names.
   * An invite code is a credential-shaped thing and never appears here.
   */
  /** Suggestions were shown. One event per batch, not per row. */
  friend_suggestion_impression: { suggestion_count: number; top_mutual_bucket: MutualBucket }
  friend_suggestion_add_clicked: { mutual_bucket: MutualBucket; position: number }
  friend_suggestion_request_created: { mutual_bucket: MutualBucket; outcome: string }
  invite_link_created: Record<string, never>
  invite_link_shared: { method: InviteShareMethod }
  invite_claimed: { outcome: InviteClaimOutcome }
  referral_succeeded: Record<string, never>
  badge_awarded: { badge_key: string }
  badge_displayed: { badge_key: string }
}

export type AnalyticsEventName = keyof AnalyticsEventMap

/**
 * How the contextual stream session was reached.
 *
 * Not an AnalyticsSurface: `source` says which product surface an event came
 * from, and all three of these are the same surface reached three ways.
 */
export type RoomOpenedFrom = 'here_card' | 'tab' | 'restored'

export type SessionEndReason = 'idle' | 'signed_out'
/**
 * Why a shared watch or the retention after it ended.
 *
 * "observation_lost" is the honest answer when the service worker was gone
 * long enough that we cannot say what happened: the interval is closed at the
 * last moment we could vouch for, and labelled so nobody later reads it as
 * something the user did. See background/togetherStore.ts.
 *
 * These are property VALUES, not keys, so adding one needs no migration - the
 * contract constrains which keys an event may carry, not what they may say.
 */
export type TogetherEndReason =
  | 'left_channel'
  | 'alone_again'
  | 'session_ended'
  | 'observation_lost'
export type PostSocialEndReason =
  | 'left_channel'
  | 'rejoined'
  | 'session_ended'
  | 'observation_lost'
/**
 * Why an observed stream-dwell interval stopped.
 *
 *   left_channel      the destination left the observed set - the tab was
 *                     closed, or navigated somewhere else.
 *   stream_ended      the destination is still open, but Twitch no longer says
 *                     it is live. Distinguishable now that dwell tracks the
 *                     destination set and live state separately, and worth
 *                     distinguishing: a stream ending under a viewer who stays
 *                     is a different fact from a viewer leaving.
 *   session_ended     sign-out, or the analytics session closed.
 *   observation_lost  the gap since the last vouched moment exceeded the resume
 *                     window. The interval closes at that last moment; the gap
 *                     is detection lag, never viewing.
 *
 * `switched_channel` was removed in M3C.1. It existed only because focused-tab
 * dwell had to close one interval to open another; per-stream dwell does not,
 * so the value became unreachable. A vocabulary that lists outcomes which can
 * no longer happen misleads whoever reads a group-by next.
 */
export type DwellEndReason =
  | 'left_channel'
  | 'stream_ended'
  | 'session_ended'
  | 'observation_lost'

export type LengthBucket = 'short' | 'medium' | 'long'

/**
 * How many streams somebody had open, as a bucket.
 *
 * Enumerated rather than a raw integer so the property can never become a
 * fingerprint, and so the answer we actually want - "is one enough, is three
 * too few" - is readable straight off a group-by.
 */
export type DestinationCountBucket = 'none' | 'one' | 'two' | 'three'

/**
 * How much social proof a suggestion carried.
 *
 * Bucketed rather than raw, for the same reason every other count here is:
 * the question is 'does more overlap convert better', which a handful of
 * buckets answers and a long tail of exact numbers does not.
 */
export type MutualBucket = 'one' | 'two_to_three' | 'four_plus'

/** How an invite link left the panel. */
export type InviteShareMethod = 'copy' | 'share_sheet'

/** What the server said about a claim. Mirrors claim_invite's return. */
export type InviteClaimOutcome = 'attributed' | 'already' | 'self' | 'blocked' | 'unknown'

/** Bucket the number of mutual friends behind a suggestion. */
export function mutualBucket(count: number): MutualBucket {
  if (count <= 1) return 'one'
  if (count <= 3) return 'two_to_three'
  return 'four_plus'
}

/** Why a Stream Room surface stopped being available. */
export type RoomEndReason = 'destination_closed' | 'retention_expired' | 'signed_out'

/** Bucket a destination count. Three is the cap, so there is no "more". */
export function destinationBucket(count: number): DestinationCountBucket {
  if (count <= 0) return 'none'
  if (count === 1) return 'one'
  if (count === 2) return 'two'
  return 'three'
}

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
  authenticated_session_started: ['friend_count', 'group_count', 'experiment_arm'],

  friend_search: ['result_count', 'matched_by'],
  friend_request_sent: ['outcome'],
  friend_request_accepted: ['direction'],
  friend_removed: [],
  group_invite_sent: ['member_count'],
  group_invite_accepted: ['member_count'],

  friend_presence_impression: ['state', 'visible_count'],
  gathering_impression: ['friend_count', 'rank', 'visible_count'],
  gravity_cluster_impression: [
    'friend_count',
    'rank',
    'visible_clusters',
    'opportunity_key',
    'destination_live',
  ],

  automatic_room_entered: ['participant_count', 'direct_friend_count'],
  automatic_room_opened: ['participant_count', 'direct_friend_count', 'opened_from'],
  automatic_room_message_sent: ['length_bucket', 'has_emote', 'participant_count'],
  automatic_room_reaction: ['participant_count', 'direction'],
  automatic_room_combo: ['combo_size', 'participant_count'],

  join_clicked: [
    'social_count',
    'already_on_twitch',
    'already_on_destination',
    'navigated',
    'opportunity_key',
  ],
  join_arrived: ['elapsed_ms'],

  watching_together_started: ['other_count', 'from_join'],
  watching_together_ended: [
    'other_count_peak',
    'duration_ms',
    'end_reason',
    'detection_delay_ms',
  ],
  post_social_retention_ended: ['duration_ms', 'from_join', 'end_reason'],
  channel_dwell_ended: [
    'duration_ms',
    'focused_duration_ms',
    'background_duration_ms',
    'from_join',
    'had_social',
    'end_reason',
  ],

  gathering_notification_shown: ['friend_count'],
  gathering_notification_clicked: ['friend_count'],

  group_created: [],
  group_opened: ['member_count'],
  group_message_sent: ['length_bucket', 'has_emote'],
  user_blocked: [],
  user_unblocked: [],
  feedback_submitted: ['category'],
  combo_formed: ['count'],
  combo_broken: ['count'],

  client_error: ['context', 'code'],
  destinations_published: ['count_bucket', 'at_max'],
  automatic_room_left: ['reason', 'had_messages'],
  realtime_status_changed: ['surface', 'status'],
  group_message_send_failed: ['code'],

  friend_suggestion_impression: ['suggestion_count', 'top_mutual_bucket'],
  friend_suggestion_add_clicked: ['mutual_bucket', 'position'],
  friend_suggestion_request_created: ['mutual_bucket', 'outcome'],
  invite_link_created: [],
  invite_link_shared: ['method'],
  invite_claimed: ['outcome'],
  referral_succeeded: [],
  badge_awarded: ['badge_key'],
  badge_displayed: ['badge_key'],
}

export const ANALYTICS_EVENT_NAMES = Object.keys(EVENT_PROPERTIES) as AnalyticsEventName[]

/**
 * Mozilla's data-collection taxonomy, as it applies to Watchside.
 *
 * These are the five categories any Watchside event can fall into. Four of them
 * are declared REQUIRED in the Firefox manifest, because the product cannot do
 * what it says it does without them - see scripts/manifest.mjs.
 *
 * The fifth, `technicalAndInteraction`, Mozilla permits ONLY as optional, which
 * means asking the user separately and honouring a refusal. Watchside does not
 * ask: F6's owner decision is that Firefox collects none of it. So this type
 * exists to identify that family precisely, and the analytics boundary drops it
 * on Gecko.
 */
export type MozillaDataCategory =
  | 'authenticationInfo'
  | 'browsingActivity'
  | 'personalCommunications'
  | 'websiteActivity'
  | 'technicalAndInteraction'

/**
 * What each event actually collects, in Mozilla's words.
 *
 * A `Record` over every event name on purpose: adding an event without
 * classifying it is a COMPILE ERROR, not a silent omission. That is the whole
 * safety property here - a future diagnostic event cannot quietly start
 * transmitting from Firefox because somebody forgot a list.
 *
 * HOW THE BOUNDARY WAS DRAWN
 *
 * `technicalAndInteraction` is "device and browser info, extension usage and
 * settings data, crash and error reports". Watchside collects NO device or
 * browser information at all - the envelope carries an app version, an
 * environment label and a session id, and nothing about the machine - so the
 * question reduces to: is this event a report about our software's health, or a
 * record of something the person did?
 *
 *   something the person did   -> websiteActivity / browsingActivity / etc.
 *   our software misbehaving   -> technicalAndInteraction
 *
 * That line puts three events on the technical side and leaves every product
 * and funnel measurement where it was. Gravity exposure, JOIN and its source,
 * arrival, shared watches, post-social linger, the growth loop and session
 * framing are all records of user activity, and they stay exactly as they are
 * on both engines.
 */
export const EVENT_DATA_CATEGORY: Record<AnalyticsEventName, MozillaDataCategory> = {
  // ---------------------------------------------------------------- lifecycle
  /*
   * The session frame, and the denominator of nearly every funnel.
   *
   * Website activity, not "extension usage": a Watchside session is bounded by
   * the person being active on Twitch, and `duration_ms` measures how long they
   * were. Reading it as technical data would gate the denominator and quietly
   * bias every rate computed against it.
   */
  extension_session_started: 'websiteActivity',
  extension_session_ended: 'websiteActivity',
  authenticated_session_started: 'authenticationInfo',

  // ------------------------------------------------------------- social graph
  friend_search: 'websiteActivity',
  friend_request_sent: 'websiteActivity',
  friend_request_accepted: 'websiteActivity',
  friend_removed: 'websiteActivity',
  group_invite_sent: 'websiteActivity',
  group_invite_accepted: 'websiteActivity',

  // ------------------------------------------- gravity, exposure and arrival
  /* All channel-bearing: the envelope carries destination_channel. */
  friend_presence_impression: 'browsingActivity',
  gathering_impression: 'browsingActivity',
  gravity_cluster_impression: 'browsingActivity',
  join_clicked: 'browsingActivity',
  join_arrived: 'browsingActivity',
  watching_together_started: 'browsingActivity',
  watching_together_ended: 'browsingActivity',
  post_social_retention_ended: 'browsingActivity',
  /*
   * How long somebody had a live stream open, per stream.
   *
   * browsingActivity, the same as every other destination-bearing event: it is
   * a record of what the person did on a website, not a report about our
   * software's health. Already declared REQUIRED in the Firefox manifest, so
   * this needs no manifest change - but it IS a new KIND of record, and
   * docs/PRIVACY.md says so plainly rather than folding it in quietly.
   *
   * The M3C.1 correction widened WHAT is observed (background streams, several
   * at once) without widening the CATEGORY: it is still a duration and a
   * channel login, and still nothing about the stream itself.
   */
  channel_dwell_ended: 'browsingActivity',
  gathering_notification_shown: 'browsingActivity',
  gathering_notification_clicked: 'browsingActivity',
  destinations_published: 'browsingActivity',

  // -------------------------------------------------------------- the room
  automatic_room_entered: 'browsingActivity',
  automatic_room_opened: 'browsingActivity',
  automatic_room_left: 'browsingActivity',
  /* A bucket and a flag, never a body - but it is still a record that a message
   * happened, which is what personalCommunications describes. Already required. */
  automatic_room_message_sent: 'personalCommunications',
  automatic_room_reaction: 'personalCommunications',
  automatic_room_combo: 'personalCommunications',
  combo_formed: 'personalCommunications',
  combo_broken: 'personalCommunications',

  // -------------------------------------------------------------- groups
  group_created: 'websiteActivity',
  group_opened: 'websiteActivity',
  group_message_sent: 'personalCommunications',

  // -------------------------------------------------------------- safety
  user_blocked: 'websiteActivity',
  user_unblocked: 'websiteActivity',
  /* The category only. What the person wrote goes to submit_feedback, which is
   * a different table with different rules, and never through analytics. */
  feedback_submitted: 'websiteActivity',

  // ---------------------------------------------------------- the growth loop
  friend_suggestion_impression: 'websiteActivity',
  friend_suggestion_add_clicked: 'websiteActivity',
  friend_suggestion_request_created: 'websiteActivity',
  invite_link_created: 'websiteActivity',
  invite_link_shared: 'websiteActivity',
  invite_claimed: 'websiteActivity',
  referral_succeeded: 'websiteActivity',
  badge_awarded: 'websiteActivity',
  badge_displayed: 'websiteActivity',

  // ----------------------------------------------------------- DIAGNOSTICS
  /*
   * The three events that are reports about Watchside rather than records of
   * the person using it. On Firefox these are never sent.
   */
  /** A caught failure, as a call site and a code. Nobody did this on purpose. */
  client_error: 'technicalAndInteraction',
  /** A realtime subscription changed state. Transport health, not behaviour. */
  realtime_status_changed: 'technicalAndInteraction',
  /*
   * A group message was refused.
   *
   * The nearest thing to a borderline case, because a person did try to send
   * something - but the event carries a FailureCode and nothing else, and what
   * it measures is whether our messaging works. That is an error report. The
   * SUCCESSFUL send is `group_message_sent`, which is product data and is not
   * gated, so what Firefox loses here is reliability visibility rather than any
   * part of the funnel.
   */
  group_message_send_failed: 'technicalAndInteraction',
}

/**
 * The events Firefox must never transmit.
 *
 * Derived from the classification rather than written out again, so the two
 * cannot disagree.
 */
export const TECHNICAL_AND_INTERACTION_EVENTS: readonly AnalyticsEventName[] =
  ANALYTICS_EVENT_NAMES.filter((name) => EVENT_DATA_CATEGORY[name] === 'technicalAndInteraction')

/** Does this event collect what Mozilla classifies as optional technical data? */
export function isTechnicalAndInteraction(name: AnalyticsEventName): boolean {
  return EVENT_DATA_CATEGORY[name] === 'technicalAndInteraction'
}


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
