/**
 * Where everyone is, arranged so the answer is the first thing you see.
 *
 * Kickback's whole thesis is Presence -> Social Gravity -> JOIN -> Together,
 * and this is the middle step. A flat friends list makes you read four rows
 * and notice that three of them say the same channel. Social Gravity does that
 * reading for you: the destination becomes the thing on screen, and the people
 * become its weight.
 *
 * NOTHING HERE REINTERPRETS PRESENCE
 *
 * The clustering is clusterMembers, unchanged - the same function the group
 * roster uses, with the same self-exclusion, the same staleness rule and the
 * same privacy behaviour. A friend who hides their activity arrives already
 * looking like someone with nothing to share, because presence is redacted at
 * WRITE time; there is no branch here that could reveal a channel somebody
 * chose not to publish. Gravity only decides how to rank and present what
 * clusterMembers already found.
 *
 * That reuse is deliberate. "Watching with you", the group clusters, the user
 * card, JOIN eligibility and now Gravity all answer from one interpretation,
 * so a friend cannot read one way here and another way three inches below.
 *
 * ONE FRIEND IS STILL A DESTINATION
 *
 * A single friend on a stream is real social discovery, so it gets a row of
 * its own rather than being hidden until a second person turns up. What
 * changes with size is emphasis, not existence - see `isGravity`.
 */

import { clusterMembers } from './groupPresence'
import type { MemberLike } from './groupPresence'
import type { Activity } from './types'
import { liveStateOf } from './twitchMetadata'
import type { ChannelMetadata, LiveState } from './twitchMetadata'

/**
 * What a section of the map is.
 *
 *   here        - the channel the viewer is on. Not somewhere to go.
 *   destination - somewhere they could go, with at least one friend on it.
 *   around      - online, on Twitch, not on a channel we may name.
 *   offline     - everyone else, including friends we have no presence for.
 */
export type GravityKind = 'here' | 'destination' | 'around' | 'offline'

/** Two friends is where a list of people becomes a gathering. */
export const GRAVITY_THRESHOLD = 2

export interface GravitySection<T> {
  kind: GravityKind
  /**
   * Whether Twitch says this destination is streaming.
   *
   * `unknown` whenever nothing told us, which is the default and the state
   * every section is in when metadata is absent, slow or broken. It is not a
   * synonym for offline and is never presented as one.
   */
  live: LiveState
  /** Lowercase Twitch login for `here` and `destination`; null otherwise. */
  channel: string | null
  friends: T[]
  count: number
  /**
   * Position among JOINABLE destinations, 1-based. Null for everything else.
   *
   * `here` is deliberately unranked: it is not an opportunity, because the
   * viewer is already there. Counting it would put rows in the denominator of
   * impression-to-JOIN conversion that can never convert.
   */
  rank: number | null
  /** True only where a JOIN would actually take the viewer somewhere. */
  canJoin: boolean
}

/**
 * How long one social opportunity lasts before a later gathering on the same
 * channel counts as a different one.
 *
 * Matched to the impression window on purpose: a cluster that is still visible
 * after this long is re-impressed anyway, so the two rolling over together
 * keeps "how many people saw this opportunity" and "which opportunity was it"
 * from drifting apart.
 */
export const OPPORTUNITY_WINDOW_MS = 30 * 60 * 1000

/**
 * A stable name for the social opportunity a destination represents.
 *
 * Amplification is the question this exists for: how many viewers did ONE
 * gathering produce. Answering it needs every viewer who acts on the same
 * gathering to write down the same name for it - so the key is derived only
 * from things every viewer sees identically, which is the channel and the
 * clock. Nothing about who is in the cluster goes into it: viewers see
 * different subsets of the same gathering, and friend identities have no place
 * in analytics regardless.
 *
 * The window is what makes it an *opportunity* rather than a channel: a
 * gathering that forms again tomorrow is a new one, while a friend flickering
 * out for thirty seconds is not.
 *
 * KNOWN COST, ACCEPTED. A gathering that spans a window boundary is recorded
 * as two opportunities. The alternative - anchoring to when the cluster formed
 * - keeps a long gathering whole but gives late arrivals a different key from
 * the people already there, and late arrivals are precisely who amplification
 * counts. Cross-viewer agreement is worth more than boundary continuity here.
 * Queries that want the whole gathering group by channel and a time range.
 */
export function opportunityKey(
  channel: string,
  now: number,
  windowMs: number = OPPORTUNITY_WINDOW_MS,
): string {
  return `gravity:${channel.toLowerCase()}:${Math.floor(now / windowMs)}`
}

/** Whether a destination has enough people to read as a gathering. */
export function isGravity<T>(section: GravitySection<T>): boolean {
  return section.kind === 'destination' && section.count >= GRAVITY_THRESHOLD
}

/**
 * One entry per friend PER ACTIVE DESTINATION - the input Gravity clusters.
 *
 * This is the whole of multi-destination on the read side, and it lives here,
 * once, because it has already been got wrong by existing twice: the panel
 * computed this expansion for its analytics exposure report while the rendered
 * component clustered the plain singular friends list beside it. Both were
 * individually correct and the feature was invisible.
 *
 * `clusterMembers` buckets by the channel it finds on a presence, and is
 * deliberately not changed: HERE, group rosters, the user card, JOIN
 * eligibility and Gravity all still answer from one interpretation of
 * presence. What changes is the INPUT - a friend watching two streams arrives
 * as two entries, each carrying the same presence with a different channel.
 *
 * Presence at a destination is BINARY. Somebody with three streams open counts
 * once at each, not a third at each: there is no weight here and deliberately
 * nowhere to put one. See
 * docs/reports/multi-stream-room-architecture-2026-08-27.md §6.
 *
 * A friend with no destination entry falls through unchanged, which is what
 * keeps a v0.4.1 client - who publishes only presence.channel - visible during
 * the rollout.
 */
export function expandDestinations<T>(
  friends: readonly MemberLike<T>[],
  destinations: DestinationsByUser,
): Array<MemberLike<T>> {
  return friends.flatMap((friend) => {
    const id = friend.userId ?? friend.presence?.userId
    /*
     * De-duplicated defensively.
     *
     * apply_destinations already de-duplicates before its cap, so a repeat
     * should be unreachable - which is exactly why it is worth guarding. One
     * duplicated entry would put the same person into a cluster twice and
     * inflate a gathering count, and gathering counts are what the product is
     * about.
     */
    const open = id ? [...new Set(destinations[id] ?? [])] : []
    if (open.length === 0) return [friend]

    // Only a watching presence has a destination to be at. Somebody browsing,
    // hiding their activity or offline is left exactly as they are.
    const presence = friend.presence
    if (!presence || presence.activity.type !== 'watching') return [friend]

    return open.map((channel) => ({
      ...friend,
      presence: { ...presence, activity: { ...presence.activity, channel } },
    }))
  })
}

/**
 * The live social map.
 *
 * ORDER, AND WHY
 *
 *   1. here          - where the viewer already is, so the people they are
 *                      with are the first thing they see.
 *   2. destinations  - most friends first. That IS social gravity: the biggest
 *                      pull goes to the top.
 *   3. around        - on Twitch, nothing to join.
 *   4. offline
 *
 * WHAT METADATA IS AND IS NOT ALLOWED TO DO TO THAT ORDER
 *
 * It may do exactly one thing: move a destination Twitch says has STOPPED
 * STREAMING below the ones that have not. It may not do anything else, and in
 * particular viewer count, category and popularity have no influence here at
 * all - a fifty-viewer stream with five friends on it outranks a
 * fifty-thousand-viewer stream with one, and always will. Friend count is why
 * a destination matters; metadata only says whether it is still there.
 *
 * Demoting an ended stream is not ranking by Twitch data, it is declining to
 * put a JOIN that leads nowhere at the top of the map. The card is kept, with
 * its friends and its count, because presence is the authority on where
 * people are and a destination that vanished would be a worse lie than one
 * marked OFFLINE.
 *
 * `unknown` ranks with `live`, deliberately. A metadata outage, a cold cache
 * and a channel we have simply not asked about yet all produce `unknown`, and
 * if that demoted anything then a backend blip would silently reorder the
 * whole map. With no metadata at all the order is byte-for-byte what it was
 * before metadata existed.
 *
 * Ties between destinations break alphabetically by channel login, and
 * NOT by recency. Recency looks appealing and is quietly awful here: presence
 * heartbeats land every 45 seconds, so a freshness tie-break would reorder the
 * map underneath somebody's cursor several times a minute. Alphabetical is
 * arbitrary but completely stable, which is the property that matters.
 *
 * This is clusterMembers' own ordering, kept rather than re-derived.
 */
export function socialGravity<T>(
  friends: readonly MemberLike<T>[],
  localActivity: Activity,
  now?: number,
  selfId: string | null = null,
  /**
   * What Twitch says about each channel, keyed by login.
   *
   * The MAP rather than a lookup function, so the freshness check happens in
   * here where the clock already lives. Callers are React render paths, and a
   * render that reads the clock is a render that can disagree with itself.
   *
   * Omitting it produces exactly the map this function produced before
   * metadata existed.
   */
  metadata?: Readonly<Record<string, ChannelMetadata>>,
): Array<GravitySection<T>> {
  const clusters = clusterMembers(friends, localActivity, now, selfId)

  /*
   * One clock reading for the whole map.
   *
   * Same reason clusterMembers takes `now`: two destinations evaluated a
   * millisecond apart must not be able to land on opposite sides of the
   * staleness boundary.
   */
  const at = now ?? Date.now()
  const liveOf = (channel: string): LiveState =>
    metadata ? liveStateOf(metadata[channel], at) : 'unknown'

  const sections = clusters.map((cluster) => {
    const destination = cluster.kind === 'channel' && cluster.channel !== null

    return {
      kind: (cluster.kind === 'here'
        ? 'here'
        : cluster.kind === 'channel'
          ? 'destination'
          : cluster.kind === 'browsing'
            ? 'around'
            : 'offline') as GravityKind,
      // `here` is asked too: the viewer deserves to know the stream they are
      // watching has ended, even though there is nowhere for them to go.
      live: cluster.channel ? liveOf(cluster.channel) : ('unknown' as LiveState),
      channel: cluster.channel,
      friends: cluster.members,
      count: cluster.members.length,
      rank: null as number | null,
      // Never for `here`: the viewer is already on that channel, and offering
      // to take them there would reload the stream they are watching.
      canJoin: destination,
    }
  })

  /*
   * Sink the ended streams, and change nothing else.
   *
   * A stable partition rather than a sort: everything keeps clusterMembers'
   * ordering within its group, so friend count still decides and the
   * alphabetical tie-break still holds. Only the live/not-live boundary moves,
   * and only for destinations - `here`, `around` and `offline` sections stay
   * exactly where they were.
   */
  const ordered = [
    ...sections.filter((section) => section.kind !== 'destination' || section.live !== 'offline'),
    ...sections.filter((section) => section.kind === 'destination' && section.live === 'offline'),
  ]

  /*
   * Rank AFTER ordering, so rank 1 is the top card on screen.
   *
   * Analytics joins impressions to clicks on rank, so a rank that disagreed
   * with what the user saw would quietly corrupt the funnel rather than break
   * anything visible.
   */
  let rank = 0
  return ordered.map((section) =>
    section.canJoin ? { ...section, rank: (rank += 1) } : section,
  )
}

/**
 * The destinations worth reporting as social opportunities, in rank order.
 *
 * `here` is excluded for the reason given on `rank`, and so is everything
 * without a channel. What is left is exactly the set a viewer could act on.
 */
export function gravityOpportunities<T>(
  sections: readonly GravitySection<T>[],
): Array<GravitySection<T> & { channel: string; rank: number }> {
  return sections.filter(
    (section): section is GravitySection<T> & { channel: string; rank: number } =>
      section.canJoin && section.channel !== null && section.rank !== null,
  )
}

/**
 * Every ACTIVE destination each friend has open, keyed by user id.
 *
 * The read-side counterpart of what report_destinations publishes. Named
 * rather than written inline at each boundary so the same idea is not spelled
 * three slightly different ways.
 */
export type DestinationsByUser = Readonly<Record<string, readonly string[]>>

/**
 * Everything needed to build the map, in one object.
 *
 * WHY AN OBJECT, AND WHY `metadata` IS REQUIRED HERE
 *
 * `socialGravity` takes five positional parameters and `metadata` is the last
 * and optional. Forgetting it is silent and total: every card loses its Twitch
 * casing, live badge, category, viewer count, title and avatar, and still
 * renders - as a raw lowercase login with nothing on it. That is precisely the
 * regression this type exists to make impossible, and it is not a defect a
 * reader spots, because the call still compiles and the map still appears.
 *
 * So the canonical entry point takes a named object and REQUIRES the metadata
 * field. Passing `{}` is still allowed - a cold cache is a real state - but it
 * has to be said out loud rather than fallen into.
 */
export interface GravityModelInput<T> {
  friends: readonly MemberLike<T>[]
  /** Read-side multi-destination. `{}` for a client that has none yet. */
  destinations: DestinationsByUser
  localActivity: Activity
  /** The viewer, who is never one of the people on the map. */
  selfId: string | null
  /**
   * What Twitch says about each channel, keyed by login.
   *
   * Required, not optional. See above - this is the whole point of the type.
   */
  metadata: Readonly<Record<string, ChannelMetadata>>
  /** Left undefined in render paths; the selector reads the clock once. */
  now?: number
}

/**
 * THE canonical Social Gravity model.
 *
 * One function, one definition of what Gravity contains, for every consumer:
 * the rendered map, the analytics exposure report, and the worker diagnostic.
 *
 * This exists because separate consumers deriving Gravity separately has
 * already shipped two regressions. The panel once computed the expanded map
 * for analytics while the component clustered the singular list for the
 * screen, so analytics recorded three impressions for a screen showing one.
 * Nothing about either half was wrong; there was simply no single answer to
 * "what is on the map".
 *
 * There is now. Consumers that need a different PROJECTION - opportunities,
 * impressions, a diagnostic - derive it from this result rather than rebuilding
 * it. See gravityOpportunities.
 */
export function gravityModel<T>(input: GravityModelInput<T>): Array<GravitySection<T>> {
  return socialGravity(
    expandDestinations(input.friends, input.destinations),
    input.localActivity,
    input.now,
    input.selfId,
    input.metadata,
  )
}

/**
 * Every channel the map will name, so enrichment can be asked for exactly it.
 *
 * The third derivation of "what destinations are on screen" used to live in the
 * worker and enumerate `presence.channel` alone - the legacy singular primary.
 * A friend at three destinations therefore had metadata fetched for one of
 * them, and the other two rendered as bare lowercase logins with no live
 * state, category, viewer count or avatar. Deriving the set from the same
 * expansion the map is built from is what keeps enrichment and presentation
 * describing the same world.
 */
export function gravityChannels<T>(
  friends: readonly MemberLike<T>[],
  destinations: DestinationsByUser,
): string[] {
  const channels = new Set<string>()
  for (const entry of expandDestinations(friends, destinations)) {
    const presence = entry.presence
    if (presence?.activity.type === 'watching') channels.add(presence.activity.channel)
  }
  return [...channels]
}

/**
 * A destination whose card would be blank, and whose metadata is on its way.
 *
 * THE PROBLEM THIS SOLVES
 *
 * A newly discovered destination reaches the map before Twitch has been asked
 * about it. For the half second that follows, the card has no display casing,
 * no live badge, no category, no viewers and no avatar - it renders as a raw
 * lowercase login and then visibly transforms. Correct, and cheap-looking.
 *
 * WHY THIS IS NOT A TIMER
 *
 * The answer is already in the state. A channel with a fetch open is ARRIVING;
 * a channel with no record and no fetch open will not arrive, because a failed
 * request clears itself and a request that was never made is not pending. So
 * "wait" and "give up" are read from the metadata service rather than guessed
 * from a clock, and a failure degrades to the plain card the panel has always
 * drawn rather than to an indefinite spinner.
 *
 * NEVER THE VIEWER'S OWN CARD, and never `around` or `offline`. HERE is where
 * the viewer already is - hiding it would remove the people they are actually
 * with - and the quiet sections carry no metadata at all.
 */
export function awaitingEnrichment<T>(
  section: GravitySection<T>,
  metadata: Readonly<Record<string, ChannelMetadata>>,
  pending: readonly string[],
): boolean {
  if (section.kind !== 'destination' || !section.channel) return false
  if (metadata[section.channel]) return false
  return pending.includes(section.channel)
}

/**
 * The map as it should be drawn right now.
 *
 * Destinations still waiting for their first enrichment are held back; every
 * other section renders exactly as before. Holding one card back never holds
 * the map back - the rest of Gravity, and the friends below it, are untouched.
 */
export function visibleGravity<T>(
  sections: readonly GravitySection<T>[],
  metadata: Readonly<Record<string, ChannelMetadata>>,
  pending: readonly string[],
): Array<GravitySection<T>> {
  if (pending.length === 0) return [...sections]
  return sections.filter((section) => !awaitingEnrichment(section, metadata, pending))
}
