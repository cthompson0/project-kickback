import { effectiveStatus, isWatching } from './presence'
import type { Activity, Presence } from './types'

/**
 * What a group is doing, arranged so you can read it at a glance.
 *
 * A group is a persistent social circle, not a chat room with a roster
 * attached. The question it exists to answer is the same one Kickback has
 * always answered - *where are my people, and where can I join them* - so the
 * member list is organised by what people are doing rather than alphabetically.
 *
 * The clustering is the point: everyone under one heading is, literally,
 * together. Two friends on the same stream become one row you can act on
 * instead of two rows you have to notice are the same.
 *
 * Ordering is deliberate, most actionable first:
 *
 *   1. HERE - members on the channel you are watching right now
 *   2. Channels, biggest cluster first, ties broken alphabetically
 *   3. Browsing Twitch but not on a channel
 *   4. Offline
 *
 * SELF IS NOT ONE OF THE PEOPLE. These clusters answer "where is everyone
 * ELSE", so the viewer is removed before anything is counted or grouped -
 * at the aggregation, not with a render-time filter. Otherwise you end up in
 * your own "watching with you" row, which reads as though you had company you
 * do not have, and the count is one too high. Membership and management lists
 * are a different question and still show everybody.
 *
 * PRIVACY. This function invents nothing. Presence is redacted when it is
 * written, so a member who hides their activity arrives here already looking
 * like someone with nothing to share, and lands in the last cluster. There is
 * no branch that could reveal a channel a member chose not to publish.
 */

export type ClusterKind = 'here' | 'channel' | 'browsing' | 'offline'

export interface MemberLike<T> {
  member: T
  presence: Presence | null
  /**
   * Who this is.
   *
   * Carried separately from the presence because a member with no presence
   * still has an identity - and if that member is the viewer, they must be
   * excluded from "everyone else" whether or not they happen to be sharing
   * anything.
   */
  userId?: string
}

export interface MemberCluster<T> {
  kind: ClusterKind
  /** The Twitch login for 'here' and 'channel'; null otherwise. */
  channel: string | null
  members: T[]
}

/** The channel the local user is on, or null. */
function localChannel(activity: Activity): string | null {
  return isWatching(activity) ? activity.channel.toLowerCase() : null
}

/**
 * Where a member belongs, or null when they are not visibly active.
 *
 * Anything other than a confirmed online-and-watching state is treated as
 * "nothing to show", which is what keeps hidden presence hidden.
 */
function channelOf(presence: Presence | null, now: number): string | null {
  if (!presence) return null
  if (effectiveStatus(presence, now) !== 'online') return null
  if (!isWatching(presence.activity)) return null
  const channel = presence.activity.channel?.trim().toLowerCase()
  return channel ? channel : null
}

function isAround(presence: Presence | null, now: number): boolean {
  return presence !== null && effectiveStatus(presence, now) === 'online'
}

/**
 * Groups members into clusters.
 *
 * Generic over the member type so the UI can pass its own row objects and get
 * them back, and so this stays testable without any UI types.
 */
export function clusterMembers<T>(
  members: readonly MemberLike<T>[],
  localActivity: Activity,
  now: number = Date.now(),
  /** The viewer, who is never one of the other people. */
  selfId: string | null = null,
): Array<MemberCluster<T>> {
  const here = localChannel(localActivity)

  const byChannel = new Map<string, T[]>()
  const browsing: T[] = []
  const offline: T[] = []

  for (const entry of members) {
    // The viewer is not somebody they are watching with.
    if (selfId !== null && (entry.userId ?? entry.presence?.userId) === selfId) continue

    const channel = channelOf(entry.presence, now)
    if (channel) {
      const bucket = byChannel.get(channel)
      if (bucket) bucket.push(entry.member)
      else byChannel.set(channel, [entry.member])
      continue
    }
    // Online but not on a channel is meaningfully different from offline:
    // they are around, and might come and watch something with you.
    if (isAround(entry.presence, now)) browsing.push(entry.member)
    else offline.push(entry.member)
  }

  const clusters: Array<MemberCluster<T>> = []

  // The channel you are on comes first and is labelled differently: those
  // people are not somewhere you could go, they are already with you.
  if (here && byChannel.has(here)) {
    clusters.push({ kind: 'here', channel: here, members: byChannel.get(here)! })
    byChannel.delete(here)
  }

  const rest = [...byChannel.entries()].sort(
    ([channelA, a], [channelB, b]) =>
      // Bigger clusters first - that is where the group actually is - then
      // alphabetically so the order is stable between renders.
      b.length - a.length || channelA.localeCompare(channelB),
  )
  for (const [channel, group] of rest) {
    clusters.push({ kind: 'channel', channel, members: group })
  }

  if (browsing.length > 0) clusters.push({ kind: 'browsing', channel: null, members: browsing })
  if (offline.length > 0) clusters.push({ kind: 'offline', channel: null, members: offline })

  return clusters
}

/** How many members are visibly around, for a one-line summary. */
export function aroundCount<T>(
  members: readonly MemberLike<T>[],
  now: number = Date.now(),
  selfId: string | null = null,
): number {
  return members.filter(
    (entry) =>
      (selfId === null || (entry.userId ?? entry.presence?.userId) !== selfId) &&
      isAround(entry.presence, now),
  ).length
}
