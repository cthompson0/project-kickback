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
): Array<GravitySection<T>> {
  const clusters = clusterMembers(friends, localActivity, now, selfId)

  let rank = 0
  return clusters.map((cluster) => {
    const destination = cluster.kind === 'channel' && cluster.channel !== null
    if (destination) rank += 1

    return {
      kind:
        cluster.kind === 'here'
          ? 'here'
          : cluster.kind === 'channel'
            ? 'destination'
            : cluster.kind === 'browsing'
              ? 'around'
              : 'offline',
      channel: cluster.channel,
      friends: cluster.members,
      count: cluster.members.length,
      rank: destination ? rank : null,
      // Never for `here`: the viewer is already on that channel, and offering
      // to take them there would reload the stream they are watching.
      canJoin: destination,
    }
  })
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
