import { describe, expect, it } from 'vitest'
import { socialGravity } from '../../src/core/socialGravity'
import { createActivityRegistry, MAX_DESTINATIONS } from '../../src/background/activity'
import { createStreamRoom } from '../../src/background/streamRoom'
import type { Activity, Presence } from '../../src/core/types'

/**
 * Multi-destination behaviour on the client.
 *
 * The server half is covered by tests/db/presenceDestinations.test.ts. This is
 * the other side: what the tab registry publishes, how Gravity reads a friend
 * who is in two places at once, and whether one room's roster can disturb
 * another's.
 */

const NOW = 1_700_000_000_000

function watching(userId: string, channel: string): Presence {
  return {
    userId,
    status: 'online',
    activity: { type: 'watching', platform: 'twitch', channel },
    lastSeenAt: NOW,
    since: NOW,
  }
}

const IDLE_VIEWER: Activity = { type: 'idle' }

/**
 * The expansion KickbackPanel performs: one entry per friend per active
 * destination, each carrying the same presence with a different channel.
 *
 * Mirrored here rather than imported because the panel is a whole shell, and
 * what is being tested is the CLUSTERING consequence of the expansion.
 */
function expand(
  friends: Array<{ userId: string; presence: Presence }>,
  destinations: Record<string, string[]>,
) {
  return friends.flatMap((friend) => {
    const base = { member: friend.userId, presence: friend.presence, userId: friend.userId }
    const open = [...new Set(destinations[friend.userId] ?? [])]
    if (open.length === 0) return [base]
    if (friend.presence.activity.type !== 'watching') return [base]
    return open.map((channel) => ({
      ...base,
      presence: {
        ...friend.presence,
        activity: { ...friend.presence.activity, channel },
      },
    }))
  })
}

function clusterFor(sections: ReturnType<typeof socialGravity<string>>, channel: string) {
  return sections.find((section) => section.channel === channel)
}

// ------------------------------------------------------------------ Gravity

describe('Social Gravity across multiple destinations', () => {
  /*
   * The scenario the architecture review specified.
   *
   *   Alice -> shroud + lirik
   *   Bob   -> lirik
   *   Carol -> shroud
   */
  const FRIENDS = [
    { userId: 'alice', presence: watching('alice', 'shroud') },
    { userId: 'bob', presence: watching('bob', 'lirik') },
    { userId: 'carol', presence: watching('carol', 'shroud') },
  ]
  const DESTINATIONS = {
    alice: ['shroud', 'lirik'],
    bob: ['lirik'],
    carol: ['shroud'],
  }

  const sections = () => socialGravity(expand(FRIENDS, DESTINATIONS), IDLE_VIEWER, NOW, 'me')

  it('puts Alice and Carol on shroud', () => {
    const shroud = clusterFor(sections(), 'shroud')
    expect(shroud?.friends.sort()).toEqual(['alice', 'carol'])
  })

  it('puts Alice and Bob on lirik', () => {
    const lirik = clusterFor(sections(), 'lirik')
    expect(lirik?.friends.sort()).toEqual(['alice', 'bob'])
  })

  /** The point of the whole model: presence at a destination is binary. */
  it('lets Alice contribute to both, in full', () => {
    const all = sections()
    expect(clusterFor(all, 'shroud')?.count).toBe(2)
    expect(clusterFor(all, 'lirik')?.count).toBe(2)
  })

  it('does not weight Alice fractionally for having two streams open', () => {
    const withTwo = clusterFor(sections(), 'shroud')?.count

    // The same world with Alice on shroud only. Her contribution to shroud is
    // identical - there is no weight, and nowhere to put one.
    const single = socialGravity(
      expand(FRIENDS, { ...DESTINATIONS, alice: ['shroud'] }),
      IDLE_VIEWER,
      NOW,
      'me',
    )
    expect(clusterFor(single, 'shroud')?.count).toBe(withTwo)
  })

  /**
   * Duplicate destination rows must not duplicate a person inside one cluster.
   *
   * The server de-duplicates before its cap, so this should be unreachable -
   * which is exactly why it is worth asserting: a duplicated friend would
   * inflate a gathering count, and gathering counts are what the product is
   * about.
   */
  it('cannot duplicate Alice within one cluster if the data repeats a destination', () => {
    const dupes = socialGravity(
      expand(FRIENDS, { ...DESTINATIONS, alice: ['shroud', 'shroud', 'lirik'] }),
      IDLE_VIEWER,
      NOW,
      'me',
    )
    const shroud = clusterFor(dupes, 'shroud')
    expect(shroud?.friends.filter((id) => id === 'alice')).toHaveLength(1)
    expect(shroud?.count).toBe(2)
  })

  it('still excludes the viewer from their own clusters', () => {
    const withSelf = [...FRIENDS, { userId: 'me', presence: watching('me', 'shroud') }]
    const sections = socialGravity(
      expand(withSelf, { ...DESTINATIONS, me: ['shroud', 'lirik'] }),
      IDLE_VIEWER,
      NOW,
      'me',
    )
    for (const section of sections) {
      expect(section.friends).not.toContain('me')
    }
  })

  it('falls back to a friend’s single presence when no destinations are known', () => {
    // A v0.4.1 client publishes only presence.channel, so its friends arrive
    // here with no destination entry. They must still appear.
    const sections = socialGravity(expand(FRIENDS, {}), IDLE_VIEWER, NOW, 'me')
    expect(clusterFor(sections, 'shroud')?.friends.sort()).toEqual(['alice', 'carol'])
    expect(clusterFor(sections, 'lirik')?.friends).toEqual(['bob'])
  })
})

// ------------------------------------------------------- the tab registry

describe('what the tab registry publishes', () => {
  const tab = (channel: string | null, updatedAt: number, visible = true) => ({
    channel,
    visible,
    updatedAt,
  })

  it('publishes one destination for one tab', () => {
    const registry = createActivityRegistry()
    registry.update({}, tab('shroud', 1))
    expect(registry.destinations()).toEqual(['shroud'])
  })

  it('publishes three, most recently updated first', () => {
    const registry = createActivityRegistry()
    registry.update({}, tab('shroud', 1))
    registry.update({}, tab('lirik', 2))
    registry.update({}, tab('summit1g', 3))
    expect(registry.destinations()).toEqual(['summit1g', 'lirik', 'shroud'])
  })

  it('caps at three, dropping the least recently updated', () => {
    const registry = createActivityRegistry()
    registry.update({}, tab('a_one', 1))
    registry.update({}, tab('b_two', 2))
    registry.update({}, tab('c_three', 3))
    registry.update({}, tab('d_four', 4))
    expect(registry.destinations()).toHaveLength(MAX_DESTINATIONS)
    expect(registry.destinations()).toEqual(['d_four', 'c_three', 'b_two'])
  })

  /** Duplicate tabs are one destination - the whole reason this is a set. */
  it('collapses duplicate tabs on one stream', () => {
    const registry = createActivityRegistry()
    registry.update({}, tab('shroud', 1))
    registry.update({}, tab('shroud', 2))
    registry.update({}, tab('lirik', 3))
    expect(registry.destinations()).toEqual(['lirik', 'shroud'])
  })

  it('keeps the destination when one duplicate tab closes', () => {
    const registry = createActivityRegistry()
    const tabA = {}
    const tabB = {}
    registry.update(tabA, tab('shroud', 1))
    registry.update(tabB, tab('shroud', 2))
    expect(registry.destinations()).toEqual(['shroud'])

    registry.remove(tabA)
    // Still open in tab B, so nothing changes - and because the published set
    // is unchanged, the reporter writes nothing at all.
    expect(registry.destinations()).toEqual(['shroud'])
  })

  it('drops the destination when the last duplicate closes', () => {
    const registry = createActivityRegistry()
    const tabA = {}
    const tabB = {}
    registry.update(tabA, tab('shroud', 1))
    registry.update(tabB, tab('shroud', 2))
    registry.remove(tabA)
    registry.remove(tabB)
    expect(registry.destinations()).toEqual([])
  })

  it('de-duplicates before capping, so a duplicate never costs a slot', () => {
    const registry = createActivityRegistry()
    registry.update({}, tab('a_one', 1))
    registry.update({}, tab('a_one', 2))
    registry.update({}, tab('b_two', 3))
    registry.update({}, tab('c_three', 4))
    expect(registry.destinations().sort()).toEqual(['a_one', 'b_two', 'c_three'])
  })

  it('ignores a tab that is on Twitch but not on a channel', () => {
    const registry = createActivityRegistry()
    registry.update({}, tab(null, 1))
    registry.update({}, tab('shroud', 2))
    expect(registry.destinations()).toEqual(['shroud'])
  })

  /** Focus is local. A hidden tab is still an open stream. */
  it('publishes a hidden tab’s stream just the same', () => {
    const registry = createActivityRegistry()
    registry.update({}, tab('shroud', 1, false))
    expect(registry.destinations()).toEqual(['shroud'])
  })

  it('survives rapid channel changes in one tab', () => {
    const registry = createActivityRegistry()
    const only = {}
    for (let i = 1; i <= 20; i += 1) {
      registry.update(only, tab(i % 2 === 0 ? 'shroud' : 'lirik', i))
    }
    // One tab is one destination however fast it moved.
    expect(registry.destinations()).toHaveLength(1)
  })
})

// -------------------------------------------------------- the roster cache

describe('room rosters are independent per channel', () => {
  const member = (userId: string) => ({ user_id: userId, hops: 1, via_user_id: null })

  it('keeps two rosters at once', async () => {
    const room = createStreamRoom({
      backend: {
        members: async (channel) =>
          channel === 'shroud' ? [member('carol')] : [member('bob')],
      },
    })
    room.want(['shroud', 'lirik'])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(room.snapshot('shroud').map((m) => m.userId)).toEqual(['carol'])
    expect(room.snapshot('lirik').map((m) => m.userId)).toEqual(['bob'])
  })

  /**
   * The failure per-channel state makes unrepresentable: a slow answer for one
   * channel landing after another was opened used to be able to overwrite it,
   * because there was only one `members` array.
   */
  it('cannot let a slow answer for one channel populate another', async () => {
    let releaseShroud: (rows: unknown) => void = () => {}
    const room = createStreamRoom({
      backend: {
        members: (channel) =>
          channel === 'shroud'
            ? new Promise((resolve) => {
                releaseShroud = resolve
              })
            : Promise.resolve([member('bob')]),
      },
    })

    room.want(['shroud', 'lirik'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(room.snapshot('lirik').map((m) => m.userId)).toEqual(['bob'])

    releaseShroud([member('carol')])
    await new Promise((resolve) => setTimeout(resolve, 0))

    // shroud got its own answer; lirik was never touched by it.
    expect(room.snapshot('shroud').map((m) => m.userId)).toEqual(['carol'])
    expect(room.snapshot('lirik').map((m) => m.userId)).toEqual(['bob'])
  })

  it('scopes a failure to the channel that failed', async () => {
    const room = createStreamRoom({
      backend: {
        members: async (channel) => {
          if (channel === 'shroud') throw new Error('server said no')
          return [member('bob')]
        },
      },
      onError: () => {},
    })
    room.want(['shroud', 'lirik'])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(room.snapshot('shroud')).toEqual([])
    expect(room.snapshot('lirik').map((m) => m.userId)).toEqual(['bob'])
  })

  it('forgets a roster when its stream closes, and keeps the others', async () => {
    const room = createStreamRoom({
      backend: { members: async () => [member('bob')] },
    })
    room.want(['shroud', 'lirik'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(room.channels().sort()).toEqual(['lirik', 'shroud'])

    room.want(['lirik'])
    expect(room.snapshot('shroud')).toEqual([])
    expect(room.snapshot('lirik')).toHaveLength(1)
    expect(room.channels()).toEqual(['lirik'])
  })

  it('exposes every roster it holds', async () => {
    const room = createStreamRoom({
      backend: {
        members: async (channel) => (channel === 'shroud' ? [member('carol')] : [member('bob')]),
      },
    })
    room.want(['shroud', 'lirik'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(Object.keys(room.rosters()).sort()).toEqual(['lirik', 'shroud'])
  })
})
