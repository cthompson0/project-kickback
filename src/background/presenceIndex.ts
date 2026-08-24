import type { GroupMember, Friend } from '../client/types'
import type { Presence } from '../core/types'

/**
 * One presence per person, for the whole extension.
 *
 * THE BUG THIS EXISTS FOR
 *
 * Presence used to be carried separately by whoever fetched it. The friends
 * list got it from `list_friends` and then kept it current from the realtime
 * channel. Group members got it from `list_group_members` - once - and then
 * never again, because realtime payloads were applied only to friends and the
 * channel only subscribed to friend ids in the first place.
 *
 * So a group member's presence was a photograph taken when you opened the
 * panel. Within a couple of minutes the staleness rule turned it into
 * "offline", and the user card said "not sharing activity right now" about
 * somebody the Friends tab was, at that exact moment, showing as watching
 * Lirik. Two surfaces, two copies, two answers.
 *
 * THE RULE NOW
 *
 * There is one map from user id to presence. Every source writes into it -
 * the friends snapshot, every group member snapshot, and every realtime patch -
 * and every surface is served from it. Two surfaces cannot disagree about a
 * person because there is only one value to read.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not decide who may see whom. The database already did: presence is
 * redacted at write time for people who hide their activity, and RLS decides
 * whose rows come back at all. Nothing here invents access - it only stops us
 * from holding two answers to a question the server already answered once.
 */

export type PresenceIndex = Readonly<Record<string, Presence>>

/** Picks the presence to keep when two arrive for the same person. */
function newer(a: Presence | undefined, b: Presence): Presence {
  if (!a) return b
  // `lastSeenAt` is the heartbeat; `since` is when the activity started. A row
  // without a heartbeat is older information than one with it.
  const aAt = a.lastSeenAt ?? a.since
  const bAt = b.lastSeenAt ?? b.since
  return bAt >= aAt ? b : a
}

/** Folds presences into the index, keeping the freshest for each person. */
export function mergePresence(
  index: PresenceIndex,
  incoming: readonly (Presence | null | undefined)[],
): PresenceIndex {
  let changed = false
  const next: Record<string, Presence> = { ...index }

  for (const presence of incoming) {
    if (!presence) continue
    const kept = newer(next[presence.userId], presence)
    if (kept !== next[presence.userId]) {
      next[presence.userId] = kept
      changed = true
    }
  }

  return changed ? next : index
}

/**
 * Records a realtime patch.
 *
 * Unlike a snapshot merge this always wins: it is the newest thing anyone has
 * said about that person, even if its timestamps look older because the clocks
 * involved are not the same clock.
 */
export function setPresence(index: PresenceIndex, presence: Presence): PresenceIndex {
  if (index[presence.userId] === presence) return index
  return { ...index, [presence.userId]: presence }
}

/** Their presence row is gone: they are offline, not merely quiet. */
export function clearPresence(index: PresenceIndex, userId: string, now: number): PresenceIndex {
  const current = index[userId]
  if (!current) return index
  return {
    ...index,
    [userId]: { userId, status: 'offline', activity: { type: 'idle' }, since: now },
  }
}

/** Forgets people entirely - used when access to them goes away. */
export function forgetPresence(index: PresenceIndex, userIds: readonly string[]): PresenceIndex {
  const drop = new Set(userIds)
  const next: Record<string, Presence> = {}
  let changed = false
  for (const [userId, presence] of Object.entries(index)) {
    if (drop.has(userId)) {
      changed = true
      continue
    }
    next[userId] = presence
  }
  return changed ? next : index
}

/**
 * Stamps the index onto a friends list.
 *
 * Safe by construction: the friends list only contains friends, so a
 * group-scoped presence can never reach the Friends tab for someone who is
 * merely in a group with you.
 */
export function stampFriends(friends: readonly Friend[], index: PresenceIndex): Friend[] {
  return friends.map((friend) => {
    const presence = index[friend.user.id]
    return presence && presence !== friend.presence ? { ...friend, presence } : friend
  })
}

/** Stamps the index onto every group's member list. */
export function stampMembers(
  members: Readonly<Record<string, GroupMember[]>>,
  index: PresenceIndex,
): Record<string, GroupMember[]> {
  const next: Record<string, GroupMember[]> = {}
  for (const [groupId, roster] of Object.entries(members)) {
    next[groupId] = roster.map((member) => {
      const presence = index[member.user.id]
      return presence && presence !== member.presence ? { ...member, presence } : member
    })
  }
  return next
}

/** Everyone whose presence is worth subscribing to: friends and co-members. */
export function watchedUserIds(
  friends: readonly Friend[],
  members: Readonly<Record<string, GroupMember[]>>,
  selfId: string | null,
): string[] {
  const ids = new Set<string>()
  for (const friend of friends) ids.add(friend.user.id)
  for (const roster of Object.values(members)) {
    for (const member of roster) ids.add(member.user.id)
  }
  // Our own presence comes from this browser, not from a subscription.
  if (selfId) ids.delete(selfId)
  return [...ids].sort()
}
