import { describe, expect, it } from 'vitest'
import {
  clearPresence,
  forgetPresence,
  mergePresence,
  setPresence,
  stampFriends,
  stampMembers,
  watchedUserIds,
} from '../../src/background/presenceIndex'
import { clusterMembers } from '../../src/core/groupPresence'
import { effectiveStatus, isWatching } from '../../src/core/presence'
import type { Friend, GroupMember } from '../../src/client/types'
import type { Presence } from '../../src/core/types'

/**
 * One presence per person, everywhere.
 *
 * THE BUG. Friends kept their presence up to date from the realtime channel.
 * Group members got a snapshot from `list_group_members` and never another
 * one, because payloads were applied only to friends and the channel only ever
 * subscribed to friend ids. So the same person, at the same moment, was
 * "watching Lirik" in the Friends tab and "offline" in the group - and their
 * user card said they were not sharing activity at all.
 *
 * The invariant these tests defend: for one viewer and one target at one
 * moment, every surface resolves the same presence.
 */

const NOW = 1_700_000_000_000

const watching = (userId: string, channel: string, at = NOW): Presence => ({
  userId,
  status: 'online',
  activity: { type: 'watching', platform: 'twitch', channel },
  since: at,
  lastSeenAt: at,
})

const browsing = (userId: string, at = NOW): Presence => ({
  userId,
  status: 'online',
  activity: { type: 'browsing', platform: 'twitch' },
  since: at,
  lastSeenAt: at,
})

const offline = (userId: string, at = NOW): Presence => ({
  userId,
  status: 'offline',
  activity: { type: 'idle' },
  since: at,
  lastSeenAt: at,
})

const user = (id: string) => ({
  id,
  username: id,
  displayName: id.toUpperCase(),
  avatarUrl: null,
  accentColor: '#ff8452',
})

const friend = (id: string, presence: Presence | null): Friend => ({ user: user(id), presence })
const member = (id: string, presence: Presence | null): GroupMember => ({
  user: user(id),
  role: 'member',
  presence,
})

// --------------------------------------------------------------- the index

describe('the presence index', () => {
  it('keeps the freshest of two snapshots for one person', () => {
    // The friends list and a group roster both carry presence for a mutual
    // friend, and they were fetched at different moments.
    const older = watching('u1', 'lirik', NOW - 60_000)
    const newer = watching('u1', 'xqc', NOW)

    expect(mergePresence(mergePresence({}, [older]), [newer]).u1).toBe(newer)
    expect(mergePresence(mergePresence({}, [newer]), [older]).u1).toBe(newer)
  })

  it('ignores nothing-shaped entries', () => {
    expect(mergePresence({}, [null, undefined])).toEqual({})
  })

  it('returns the same object when nothing changed, so renders are not woken', () => {
    const index = mergePresence({}, [watching('u1', 'lirik')])
    expect(mergePresence(index, [])).toBe(index)
  })

  it('lets a realtime patch win over a snapshot regardless of timestamps', () => {
    // Two clocks are involved and neither is authoritative about the other.
    // The newest thing anyone said is the newest thing we know.
    const snapshot = watching('u1', 'lirik', NOW + 60_000)
    const patch = watching('u1', 'xqc', NOW)
    const index = setPresence(mergePresence({}, [snapshot]), patch)
    expect(index.u1).toBe(patch)
  })

  it('treats a vanished presence row as offline, not as stale data', () => {
    const index = clearPresence(mergePresence({}, [watching('u1', 'lirik')]), 'u1', NOW)
    expect(index.u1.status).toBe('offline')
    expect(isWatching(index.u1.activity)).toBe(false)
  })

  it('forgets people we can no longer see', () => {
    // Leaving a group must not leave their last known presence behind.
    const index = mergePresence({}, [watching('u1', 'lirik'), watching('u2', 'xqc')])
    expect(Object.keys(forgetPresence(index, ['u2']))).toEqual(['u1'])
  })
})

// ------------------------------------------------------- the shared answer

describe('every surface resolves the same presence', () => {
  /** What each surface would show for one person, from one index. */
  function surfaces(index: Record<string, Presence>, targetId: string) {
    const friends = stampFriends([friend(targetId, null)], index)
    const members = stampMembers({ g1: [member(targetId, null)] }, index)

    const roster = members.g1
    const clusters = clusterMembers(
      roster.map((entry) => ({ member: entry, presence: entry.presence })),
      { type: 'idle' },
      NOW,
    )

    return {
      friendsTab: friends[0].presence,
      memberList: roster[0].presence,
      // The card is handed the member's presence, so this is what it renders.
      userCard: roster[0].presence,
      chatCard: roster[0].presence,
      clusterKind: clusters[0]?.kind ?? null,
      clusterChannel: clusters[0]?.channel ?? null,
    }
  }

  const CASES: Array<[string, Presence, string | null, string]> = [
    ['visibly watching', watching('u1', 'lirik'), 'lirik', 'channel'],
    ['browsing Twitch', browsing('u1'), null, 'browsing'],
    ['offline', offline('u1'), null, 'offline'],
  ]

  it.each(CASES)('agrees on a member who is %s', (_name, presence, channel, kind) => {
    const index = mergePresence({}, [presence])
    const view = surfaces(index, 'u1')

    // The literal invariant: one value, reached four ways.
    expect(view.friendsTab).toBe(view.memberList)
    expect(view.memberList).toBe(view.userCard)
    expect(view.userCard).toBe(view.chatCard)

    expect(view.clusterKind).toBe(kind)
    expect(view.clusterChannel).toBe(channel)
  })

  it('agrees after a realtime channel switch', () => {
    let index = mergePresence({}, [watching('u1', 'lirik')])
    expect(surfaces(index, 'u1').clusterChannel).toBe('lirik')

    index = setPresence(index, watching('u1', 'xqc'))
    const after = surfaces(index, 'u1')
    expect(after.clusterChannel).toBe('xqc')
    // And still one value everywhere, not a mix of old and new.
    expect(after.friendsTab).toBe(after.chatCard)
  })

  it('agrees when someone goes invisible', () => {
    // Invisible is redacted server-side, so it arrives as an offline row.
    const index = setPresence(mergePresence({}, [watching('u1', 'lirik')]), offline('u1'))
    const view = surfaces(index, 'u1')
    expect(effectiveStatus(view.memberList!, NOW)).toBe('offline')
    expect(view.clusterKind).toBe('offline')
    expect(view.friendsTab).toBe(view.userCard)
  })

  it('agrees when someone hides their activity but stays online', () => {
    // Hide-activity is also redacted at write time: online, no channel. Every
    // surface must say "around", and none may name a channel.
    const index = mergePresence({}, [browsing('u1')])
    const view = surfaces(index, 'u1')
    expect(view.clusterKind).toBe('browsing')
    expect(view.clusterChannel).toBeNull()
    expect(isWatching(view.userCard!.activity)).toBe(false)
  })

  it('agrees that a stale heartbeat is offline', () => {
    const stale = { ...watching('u1', 'lirik'), lastSeenAt: NOW - 60 * 60_000 }
    const index = mergePresence({}, [stale])
    const view = surfaces(index, 'u1')
    expect(effectiveStatus(view.memberList!, NOW)).toBe('offline')
    expect(view.clusterKind).toBe('offline')
  })

  it('shows a non-friend group member their group-scoped presence', () => {
    // The presence came from the group roster, which RLS allowed because we
    // share a group. It belongs in the group surfaces.
    const index = mergePresence({}, [watching('stranger', 'lirik')])
    const roster = stampMembers({ g1: [member('stranger', null)] }, index).g1
    expect(isWatching(roster[0].presence!.activity)).toBe(true)
  })

  it('never leaks a non-friend into the Friends tab', () => {
    // stampFriends only ever touches the friends list, and a non-friend is not
    // in it, so group-scoped presence has nowhere to leak to.
    const index = mergePresence({}, [watching('stranger', 'lirik')])
    const friends = stampFriends([friend('u1', offline('u1'))], index)
    expect(friends).toHaveLength(1)
    expect(friends[0].user.id).toBe('u1')
    expect(friends.some((entry) => entry.user.id === 'stranger')).toBe(false)
  })

  it('leaves a person alone when the index knows nothing about them', () => {
    const original = member('u1', watching('u1', 'lirik'))
    const stamped = stampMembers({ g1: [original] }, {}).g1
    expect(stamped[0].presence).toBe(original.presence)
  })
})

// ------------------------------------------------------------ subscription

describe('who we subscribe to', () => {
  it('watches friends and group members alike', () => {
    // The half that was missing: the channel filtered on friend ids, so a
    // non-friend group member's updates never arrived at all.
    const watched = watchedUserIds(
      [friend('a', null)],
      { g1: [member('b', null)], g2: [member('c', null)] },
      'me',
    )
    expect(watched).toEqual(['a', 'b', 'c'])
  })

  it('counts someone who is both a friend and a co-member once', () => {
    const watched = watchedUserIds([friend('a', null)], { g1: [member('a', null)] }, 'me')
    expect(watched).toEqual(['a'])
  })

  it('never subscribes to itself', () => {
    // Our own presence comes from this browser, not from a subscription.
    const watched = watchedUserIds([friend('me', null)], { g1: [member('me', null)] }, 'me')
    expect(watched).toEqual([])
  })

  it('is stable, so an unchanged set does not resubscribe', () => {
    const a = watchedUserIds([friend('b', null), friend('a', null)], {}, 'me')
    const b = watchedUserIds([friend('a', null), friend('b', null)], {}, 'me')
    expect(a).toEqual(b)
  })

  it('drops someone once they are neither a friend nor a co-member', () => {
    const before = watchedUserIds([], { g1: [member('b', null)] }, 'me')
    const after = watchedUserIds([], {}, 'me')
    expect(before).toEqual(['b'])
    expect(after).toEqual([])
  })
})
