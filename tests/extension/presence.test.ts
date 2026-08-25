import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createActivityRegistry } from '../../src/background/activity'
import { createPresenceReporter } from '../../src/background/presence'
import type { PresenceBackend } from '../../src/background/presence'
import { createPresenceSync } from '../../src/background/presenceSync'
import type { PresenceChannel, PresenceChannelHandlers } from '../../src/background/presenceSync'
import { createFriendsService } from '../../src/background/friends'
import type { FriendsBackend } from '../../src/background/friends'
import type { BackendResult } from '../../src/background/auth'
import {
  PRESENCE_STALE_MS,
  effectiveStatus,
  findGatherings,
  isHere,
  isStale,
} from '../../src/core/presence'
import { IDLE } from '../../src/core/types'
import type { Presence } from '../../src/core/types'
import { channelUrl } from '../../src/platforms/twitch/channels'
import type { Friend } from '../../src/client/types'

/**
 * Real presence: which tab counts, what gets written, when someone stops being
 * believed, and how friends' presence arrives.
 */

const WATCHING_LIRIK = { type: 'watching', platform: 'twitch', channel: 'lirik' } as const
const BROWSING = { type: 'browsing', platform: 'twitch' } as const

// --------------------------------------------------------- effective activity

describe('choosing what the user is actually doing', () => {
  it('reports nothing when no Twitch tab is open', () => {
    const registry = createActivityRegistry()
    expect(registry.effective()).toEqual(IDLE)
    expect(registry.hasTabs()).toBe(false)
  })

  it('reports the channel of a single tab', () => {
    const registry = createActivityRegistry()
    registry.update({}, { channel: 'lirik', visible: true, updatedAt: 1 })
    expect(registry.effective()).toEqual(WATCHING_LIRIK)
  })

  it('reports browsing when on Twitch but not on a channel', () => {
    const registry = createActivityRegistry()
    registry.update({}, { channel: null, visible: true, updatedAt: 1 })
    expect(registry.effective()).toEqual(BROWSING)
  })

  it('prefers the visible tab over a background one', () => {
    const registry = createActivityRegistry()
    const background = {}
    const foreground = {}

    // The background tab reported later, but the user is not looking at it.
    registry.update(foreground, { channel: 'lirik', visible: true, updatedAt: 1 })
    registry.update(background, { channel: 'shroud', visible: false, updatedAt: 99 })

    expect(registry.effective()).toEqual(WATCHING_LIRIK)
  })

  it('does not let a background tab steal presence by navigating', () => {
    const registry = createActivityRegistry()
    const foreground = {}
    const background = {}
    registry.update(foreground, { channel: 'lirik', visible: true, updatedAt: 1 })
    registry.update(background, { channel: 'shroud', visible: false, updatedAt: 2 })

    // A background tab autoplaying onward must not change what friends see.
    const changed = registry.update(background, {
      channel: 'xqc',
      visible: false,
      updatedAt: 3,
    })

    expect(changed).toBe(false)
    expect(registry.effective()).toEqual(WATCHING_LIRIK)
  })

  it('follows the user when they switch tabs', () => {
    const registry = createActivityRegistry()
    const first = {}
    const second = {}
    registry.update(first, { channel: 'lirik', visible: true, updatedAt: 1 })
    registry.update(second, { channel: 'shroud', visible: false, updatedAt: 2 })

    // Switching makes the other tab visible and the first hidden.
    registry.update(first, { channel: 'lirik', visible: false, updatedAt: 3 })
    registry.update(second, { channel: 'shroud', visible: true, updatedAt: 4 })

    expect(registry.effective()).toEqual({
      type: 'watching',
      platform: 'twitch',
      channel: 'shroud',
    })
  })

  it('falls back to the most recent tab when none is visible', () => {
    // Chrome minimised, or the user is in another application entirely.
    const registry = createActivityRegistry()
    registry.update({}, { channel: 'lirik', visible: false, updatedAt: 1 })
    registry.update({}, { channel: 'shroud', visible: false, updatedAt: 2 })

    expect(registry.effective()).toEqual({
      type: 'watching',
      platform: 'twitch',
      channel: 'shroud',
    })
  })

  it('goes idle when the last tab closes', () => {
    const registry = createActivityRegistry()
    const tab = {}
    registry.update(tab, { channel: 'lirik', visible: true, updatedAt: 1 })

    expect(registry.remove(tab)).toBe(true)
    expect(registry.effective()).toEqual(IDLE)
  })

  it('keeps reporting when one of several tabs closes', () => {
    const registry = createActivityRegistry()
    const closing = {}
    const staying = {}
    registry.update(staying, { channel: 'lirik', visible: true, updatedAt: 1 })
    registry.update(closing, { channel: 'shroud', visible: false, updatedAt: 2 })

    registry.remove(closing)
    expect(registry.effective()).toEqual(WATCHING_LIRIK)
  })

  it('reports a change only when the effective activity really changed', () => {
    const registry = createActivityRegistry()
    const tab = {}
    expect(registry.update(tab, { channel: 'lirik', visible: true, updatedAt: 1 })).toBe(true)
    // Same channel, later timestamp: nothing for friends to see.
    expect(registry.update(tab, { channel: 'lirik', visible: true, updatedAt: 2 })).toBe(false)
  })
})

// ------------------------------------------------------------- reporting

class FakePresenceBackend implements PresenceBackend {
  calls: string[] = []
  failWith: string | null = null

  async reportPresence(platform: string | null, channel: string | null) {
    this.calls.push(`report:${platform}:${channel}`)
    if (this.failWith) return { value: null, error: this.failWith }
    return { value: true as const }
  }
  async heartbeat(): Promise<BackendResult<true>> {
    this.calls.push('heartbeat')
    if (this.failWith) return { value: null, error: this.failWith }
    return { value: true as const }
  }
  async reportOffline(): Promise<BackendResult<true>> {
    this.calls.push('offline')
    if (this.failWith) return { value: null, error: this.failWith }
    return { value: true as const }
  }
}

describe('reporting our own presence', () => {
  let backend: FakePresenceBackend

  const reporter = () =>
    createPresenceReporter({
      backend,
      debounceMs: 100,
      heartbeatMs: 1_000,
      offlineGraceMs: 500,
    })

  beforeEach(() => {
    vi.useFakeTimers()
    backend = new FakePresenceBackend()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports the channel being watched', async () => {
    reporter().setActivity(WATCHING_LIRIK)
    await vi.advanceTimersByTimeAsync(200)
    expect(backend.calls).toContain('report:twitch:lirik')
  })

  it('reports browsing with no channel', async () => {
    reporter().setActivity(BROWSING)
    await vi.advanceTimersByTimeAsync(200)
    expect(backend.calls).toContain('report:twitch:null')
  })

  it('collapses rapid channel hopping into one write', async () => {
    const presence = reporter()
    presence.setActivity({ type: 'watching', platform: 'twitch', channel: 'a' })
    presence.setActivity({ type: 'watching', platform: 'twitch', channel: 'b' })
    presence.setActivity({ type: 'watching', platform: 'twitch', channel: 'c' })

    await vi.advanceTimersByTimeAsync(200)

    const writes = backend.calls.filter((call) => call.startsWith('report:'))
    expect(writes).toEqual(['report:twitch:c'])
  })

  it('does not rewrite the same activity', async () => {
    const presence = reporter()
    presence.setActivity(WATCHING_LIRIK)
    await vi.advanceTimersByTimeAsync(200)
    presence.setActivity(WATCHING_LIRIK)
    await vi.advanceTimersByTimeAsync(200)

    expect(backend.calls.filter((call) => call.startsWith('report:'))).toHaveLength(1)
  })

  it('heartbeats while online', async () => {
    reporter().setActivity(WATCHING_LIRIK)
    await vi.advanceTimersByTimeAsync(200)
    await vi.advanceTimersByTimeAsync(3_000)

    expect(backend.calls.filter((call) => call === 'heartbeat').length).toBeGreaterThanOrEqual(2)
  })

  it('waits out a grace period before declaring offline', async () => {
    const presence = reporter()
    presence.setActivity(WATCHING_LIRIK)
    await vi.advanceTimersByTimeAsync(200)

    presence.setActivity(IDLE)
    await vi.advanceTimersByTimeAsync(200)
    expect(backend.calls).not.toContain('offline')

    await vi.advanceTimersByTimeAsync(500)
    expect(backend.calls).toContain('offline')
  })

  it('does not flash offline while JOIN swaps one tab for another', async () => {
    // Clicking JOIN tears down a tab's port and brings a new one up a moment
    // later. Announcing offline in between would look like a bug.
    const presence = reporter()
    presence.setActivity(WATCHING_LIRIK)
    await vi.advanceTimersByTimeAsync(200)

    presence.setActivity(IDLE) // old tab gone
    await vi.advanceTimersByTimeAsync(100)
    presence.setActivity({ type: 'watching', platform: 'twitch', channel: 'shroud' })
    await vi.advanceTimersByTimeAsync(600)

    expect(backend.calls).not.toContain('offline')
    expect(backend.calls).toContain('report:twitch:shroud')
  })

  it('stops heartbeating once offline', async () => {
    const presence = reporter()
    presence.setActivity(WATCHING_LIRIK)
    await vi.advanceTimersByTimeAsync(200)

    await presence.goOffline()
    const afterOffline = backend.calls.length
    await vi.advanceTimersByTimeAsync(5_000)

    expect(backend.calls.length).toBe(afterOffline)
  })

  it('does not retry in a loop when a write fails', async () => {
    backend.failWith = 'network down'
    const presence = reporter()
    presence.setActivity(WATCHING_LIRIK)
    await vi.advanceTimersByTimeAsync(2_000)

    // One attempt, not a storm.
    expect(backend.calls.filter((call) => call.startsWith('report:'))).toHaveLength(1)
    expect(presence.lastReported()).toBeNull()
  })

  it('reports again after a failure once something changes', async () => {
    backend.failWith = 'network down'
    const presence = reporter()
    presence.setActivity(WATCHING_LIRIK)
    await vi.advanceTimersByTimeAsync(200)

    backend.failWith = null
    presence.setActivity({ type: 'watching', platform: 'twitch', channel: 'shroud' })
    await vi.advanceTimersByTimeAsync(200)

    expect(backend.calls).toContain('report:twitch:shroud')
  })

  it('stops cleanly without announcing anything', async () => {
    const presence = reporter()
    presence.setActivity(WATCHING_LIRIK)
    await vi.advanceTimersByTimeAsync(200)
    const before = backend.calls.length

    presence.stop()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(backend.calls.length).toBe(before)
  })
})

// --------------------------------------------------------------- freshness

describe('when to stop believing a presence', () => {
  const fresh = (overrides: Partial<Presence> = {}): Presence => ({
    userId: 'u-nina',
    status: 'online',
    activity: WATCHING_LIRIK,
    since: Date.now(),
    lastSeenAt: Date.now(),
    ...overrides,
  })

  it('trusts a recent heartbeat', () => {
    expect(isStale(fresh())).toBe(false)
    expect(effectiveStatus(fresh())).toBe('online')
  })

  it('stops trusting one that went quiet', () => {
    const gone = fresh({ lastSeenAt: Date.now() - PRESENCE_STALE_MS - 1_000 })
    expect(isStale(gone)).toBe(true)
    // Says online, but nobody has heard from them: treat as offline.
    expect(effectiveStatus(gone)).toBe('offline')
  })

  it('still trusts one just inside the window', () => {
    expect(effectiveStatus(fresh({ lastSeenAt: Date.now() - PRESENCE_STALE_MS + 5_000 }))).toBe(
      'online',
    )
  })

  it('applies no staleness where there is no heartbeat to judge', () => {
    // Demo presence carries no lastSeenAt and must not decay.
    expect(isStale(fresh({ lastSeenAt: undefined }))).toBe(false)
  })

  it('never resurrects an explicitly offline presence', () => {
    expect(effectiveStatus(fresh({ status: 'offline' }))).toBe('offline')
  })

  it('does not count a stale friend as HERE', () => {
    const gone = fresh({ lastSeenAt: Date.now() - PRESENCE_STALE_MS - 1_000 })
    expect(isHere(gone, WATCHING_LIRIK)).toBe(false)
  })

  it('leaves a stale friend out of gatherings', () => {
    const gone = fresh({ userId: 'u-gone', lastSeenAt: Date.now() - PRESENCE_STALE_MS - 1_000 })
    const here = fresh({ userId: 'u-here' })
    expect(findGatherings([gone, here])).toEqual([
      { platform: 'twitch', channel: 'lirik', userIds: ['u-here'] },
    ])
  })
})

// -------------------------------------------------------------- HERE / JOIN

describe('HERE and JOIN', () => {
  const watching = (userId: string, channel: string): Presence => ({
    userId,
    status: 'online',
    activity: { type: 'watching', platform: 'twitch', channel },
    since: Date.now(),
    lastSeenAt: Date.now(),
  })

  it('counts a friend on my channel as HERE', () => {
    expect(isHere(watching('u-nina', 'lirik'), WATCHING_LIRIK)).toBe(true)
  })

  it('does not count a friend on another channel as HERE', () => {
    expect(isHere(watching('u-nina', 'shroud'), WATCHING_LIRIK)).toBe(false)
  })

  it('ignores casing, so HERE is not missed on a capitalised URL', () => {
    expect(isHere(watching('u-nina', 'LIRIK'), WATCHING_LIRIK)).toBe(true)
  })

  it('does not count a browsing friend as HERE', () => {
    const browsing: Presence = {
      userId: 'u-nina',
      status: 'online',
      activity: BROWSING,
      since: Date.now(),
      lastSeenAt: Date.now(),
    }
    expect(isHere(browsing, WATCHING_LIRIK)).toBe(false)
  })

  it('sends JOIN to the friend’s channel on Twitch', () => {
    expect(channelUrl('lirik')).toBe('https://www.twitch.tv/lirik')
  })

  it('groups several friends on one channel into a gathering', () => {
    const gatherings = findGatherings(
      [watching('a', 'lirik'), watching('b', 'lirik'), watching('c', 'shroud')],
      { type: 'watching', platform: 'twitch', channel: 'xqc' },
    )
    expect(gatherings[0]).toEqual({
      platform: 'twitch',
      channel: 'lirik',
      userIds: ['a', 'b'],
    })
  })

  it('leaves my own channel out of the gatherings list', () => {
    // Friends here are shown as HERE; a "go over there" prompt would be absurd.
    const gatherings = findGatherings(
      [watching('a', 'lirik'), watching('b', 'lirik')],
      WATCHING_LIRIK,
    )
    expect(gatherings).toEqual([])
  })
})

// ------------------------------------------------ friends' presence updates

class QuietFriendsBackend implements FriendsBackend {
  friends: Friend[] = []
  async listFriends() {
    return { value: [...this.friends] }
  }
  async listFriendRequests() {
    return { value: [] }
  }
  async searchUsers() {
    return { value: [] }
  }
  async sendFriendRequest() {
    return { value: 'requested' as const }
  }
  async respondToFriendRequest() {
    return { value: 'accepted' as const }
  }
  async cancelFriendRequest() {
    return { value: 'cancelled' as const }
  }
  async removeFriend() {
    return { value: true }
  }
  async blockUser() {
    return { value: true as const }
  }
  async unblockUser() {
    return { value: true as const }
  }
  async listBlocked() {
    return { value: [] }
  }
}

function friendOf(userId: string, name: string): Friend {
  return {
    user: { id: userId, username: name.toLowerCase(), displayName: name, avatarUrl: null },
    presence: {
      userId,
      status: 'offline',
      activity: IDLE,
      since: Date.now(),
      lastSeenAt: Date.now(),
    },
  }
}

describe('applying friends presence', () => {
  let backend: QuietFriendsBackend

  beforeEach(() => {
    backend = new QuietFriendsBackend()
  })

  it('updates one friend without re-reading everyone', async () => {
    backend.friends = [friendOf('u-nina', 'Nina'), friendOf('u-omar', 'Omar')]
    const friends = createFriendsService({ backend })
    await friends.refresh()

    friends.applyPresence({
      userId: 'u-nina',
      status: 'online',
      activity: WATCHING_LIRIK,
      since: Date.now(),
      lastSeenAt: Date.now(),
    })

    const state = friends.getState()
    expect(state.friends.find((f) => f.user.id === 'u-nina')?.presence?.activity).toEqual(
      WATCHING_LIRIK,
    )
    expect(state.friends.find((f) => f.user.id === 'u-omar')?.presence?.status).toBe('offline')
  })

  it('ignores presence for somebody who is not a friend, without waking the tabs', async () => {
    backend.friends = [friendOf('u-nina', 'Nina')]
    const friends = createFriendsService({ backend })
    await friends.refresh()

    let broadcasts = 0
    friends.subscribe(() => {
      broadcasts += 1
    })
    const atStart = broadcasts

    friends.applyPresence({
      userId: 'u-stranger',
      status: 'online',
      activity: WATCHING_LIRIK,
      since: Date.now(),
      lastSeenAt: Date.now(),
    })

    expect(friends.getState().friends).toHaveLength(1)
    expect(friends.getState().friends[0].user.id).toBe('u-nina')
    // Every state change is broadcast to every open Twitch tab; a stranger's
    // event must not cost one.
    expect(broadcasts).toBe(atStart)
  })

  it('treats a vanished presence row as offline', async () => {
    backend.friends = [friendOf('u-nina', 'Nina')]
    const friends = createFriendsService({ backend })
    await friends.refresh()
    friends.applyPresence({
      userId: 'u-nina',
      status: 'online',
      activity: WATCHING_LIRIK,
      since: Date.now(),
      lastSeenAt: Date.now(),
    })

    friends.clearPresence('u-nina')

    const presence = friends.getState().friends[0].presence
    expect(presence?.status).toBe('offline')
    expect(presence?.activity).toEqual(IDLE)
  })

  it('drops presence with the friendship when someone is removed', async () => {
    backend.friends = [friendOf('u-nina', 'Nina')]
    const friends = createFriendsService({ backend })
    await friends.refresh()
    friends.applyPresence({
      userId: 'u-nina',
      status: 'online',
      activity: WATCHING_LIRIK,
      since: Date.now(),
      lastSeenAt: Date.now(),
    })

    backend.friends = []
    await friends.remove('u-nina')

    expect(friends.getState().friends).toEqual([])
    // And a late event for the ex-friend cannot bring them back.
    friends.applyPresence({
      userId: 'u-nina',
      status: 'online',
      activity: WATCHING_LIRIK,
      since: Date.now(),
      lastSeenAt: Date.now(),
    })
    expect(friends.getState().friends).toEqual([])
  })

  it('clears presence along with everything else on sign-out', async () => {
    backend.friends = [friendOf('u-nina', 'Nina')]
    const friends = createFriendsService({ backend })
    await friends.refresh()

    friends.clear()
    expect(friends.getState().friends).toEqual([])
  })
})

// --------------------------------------------------- presence subscription

interface OpenedPresence {
  friendIds: string[]
  handlers: PresenceChannelHandlers
  closed: boolean
}

class FakePresenceChannel implements PresenceChannel {
  opened: OpenedPresence[] = []

  async open(friendIds: string[], handlers: PresenceChannelHandlers): Promise<() => void> {
    const entry: OpenedPresence = { friendIds, handlers, closed: false }
    this.opened.push(entry)
    return () => {
      entry.closed = true
    }
  }

  get live(): OpenedPresence[] {
    return this.opened.filter((entry) => !entry.closed)
  }
  latest(): OpenedPresence {
    return this.opened[this.opened.length - 1]
  }
}

describe('subscribing to friends presence', () => {
  let channel: FakePresenceChannel
  let received: Presence[]
  let gone: string[]
  let resyncs: number

  const sync = () =>
    createPresenceSync({
      channel,
      onPresence: (presence) => received.push(presence),
      onPresenceGone: (userId) => gone.push(userId),
      onResync: () => {
        resyncs += 1
      },
      retryDelaysMs: [1_000, 5_000],
    })

  beforeEach(() => {
    vi.useFakeTimers()
    channel = new FakePresenceChannel()
    received = []
    gone = []
    resyncs = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('subscribes to exactly the current friends', async () => {
    sync().setFriends(['u-b', 'u-a'])
    await vi.advanceTimersByTimeAsync(0)

    expect(channel.opened).toHaveLength(1)
    expect(channel.latest().friendIds).toEqual(['u-a', 'u-b'])
  })

  it('opens nothing when there are no friends', async () => {
    sync().setFriends([])
    await vi.advanceTimersByTimeAsync(0)
    expect(channel.opened).toHaveLength(0)
  })

  it('does not resubscribe when the friend set is unchanged', async () => {
    const presence = sync()
    presence.setFriends(['u-a'])
    await vi.advanceTimersByTimeAsync(0)
    channel.latest().handlers.onStatus('connected')

    presence.setFriends(['u-a'])
    await vi.advanceTimersByTimeAsync(0)

    expect(channel.opened).toHaveLength(1)
    expect(channel.live).toHaveLength(1)
  })

  it('resubscribes when a friend is added, closing the old subscription', async () => {
    const presence = sync()
    presence.setFriends(['u-a'])
    await vi.advanceTimersByTimeAsync(0)

    presence.setFriends(['u-a', 'u-b'])
    await vi.advanceTimersByTimeAsync(0)

    expect(channel.opened).toHaveLength(2)
    expect(channel.opened[0].closed).toBe(true)
    expect(channel.live).toHaveLength(1)
    expect(channel.latest().friendIds).toEqual(['u-a', 'u-b'])
  })

  it('passes presence payloads straight through', async () => {
    sync().setFriends(['u-a'])
    await vi.advanceTimersByTimeAsync(0)

    const presence: Presence = {
      userId: 'u-a',
      status: 'online',
      activity: WATCHING_LIRIK,
      since: Date.now(),
      lastSeenAt: Date.now(),
    }
    channel.latest().handlers.onPresence(presence)

    expect(received).toEqual([presence])
  })

  it('reports a deleted presence row', async () => {
    sync().setFriends(['u-a'])
    await vi.advanceTimersByTimeAsync(0)
    channel.latest().handlers.onPresenceGone('u-a')
    expect(gone).toEqual(['u-a'])
  })

  it('asks for a fresh read after reconnecting', async () => {
    sync().setFriends(['u-a'])
    await vi.advanceTimersByTimeAsync(0)

    channel.latest().handlers.onStatus('connected')
    expect(resyncs).toBe(1)
  })

  it('reopens after a channel error', async () => {
    sync().setFriends(['u-a'])
    await vi.advanceTimersByTimeAsync(0)

    channel.latest().handlers.onStatus('error')
    expect(channel.live).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(channel.opened).toHaveLength(2)
  })

  it('ignores events from a superseded subscription', async () => {
    const presence = sync()
    presence.setFriends(['u-a'])
    await vi.advanceTimersByTimeAsync(0)
    const stale = channel.latest().handlers

    presence.setFriends(['u-a', 'u-b'])
    await vi.advanceTimersByTimeAsync(0)

    stale.onPresence({
      userId: 'u-a',
      status: 'online',
      activity: WATCHING_LIRIK,
      since: Date.now(),
      lastSeenAt: Date.now(),
    })

    expect(received).toEqual([])
  })

  it('stops everything on sign-out', async () => {
    const presence = sync()
    presence.setFriends(['u-a'])
    await vi.advanceTimersByTimeAsync(0)

    presence.stop()

    expect(channel.live).toHaveLength(0)
    expect(presence.getFriendIds()).toEqual([])
    expect(presence.getStatus()).toBe('idle')
  })

  it('recovers after a service-worker restart', async () => {
    const first = sync()
    first.setFriends(['u-a'])
    await vi.advanceTimersByTimeAsync(0)
    first.stop()

    const revived = sync()
    revived.setFriends(['u-a'])
    await vi.advanceTimersByTimeAsync(0)

    expect(channel.live).toHaveLength(1)
  })
})
