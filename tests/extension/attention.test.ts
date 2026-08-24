import { beforeEach, describe, expect, it } from 'vitest'
import { createGatheringWatcher } from '../../src/background/gatherings'
import type { GatheringNotice, GatheringSnapshot } from '../../src/background/gatherings'
import {
  createAttentionService,
  friendRequestKey,
  gatheringKey,
} from '../../src/background/attention'
import { createPreferences, DEFAULT_PREFERENCES } from '../../src/background/preferences'
import { createMemoryStorageArea } from '../../src/background/storage'
import {
  channelFromNotificationId,
  createNotifier,
  describeNames,
} from '../../src/background/notifier'
import type { NotificationOptions } from '../../src/background/notifier'
import { findGatherings, PRESENCE_STALE_MS } from '../../src/core/presence'
import { IDLE } from '../../src/core/types'
import type { Presence } from '../../src/core/types'

/**
 * Attention mechanics: when a gathering is worth interrupting someone for,
 * what counts as unread, and what a desktop notification is allowed to say.
 *
 * The point of nearly every test here is restraint - proving Kickback stays
 * quiet in all the situations where a naive implementation would not.
 */

const at = (channel: string, ...friendIds: string[]): GatheringSnapshot => ({
  channel,
  friendIds,
})

// ------------------------------------------------------------- gatherings

describe('deciding when a gathering deserves an interruption', () => {
  let notices: GatheringNotice[]
  let clock: number

  const watcher = (overrides: { cooldownMs?: number } = {}) =>
    createGatheringWatcher({
      onNotify: (notice) => notices.push(notice),
      now: () => clock,
      cooldownMs: overrides.cooldownMs ?? 30 * 60_000,
    })

  beforeEach(() => {
    notices = []
    clock = 1_000_000
  })

  it('says nothing about the world it wakes up to', () => {
    // A service-worker restart must not announce gatherings already under way.
    const gathering = watcher()
    gathering.update([at('lirik', 'a', 'b', 'c')], null)

    expect(notices).toEqual([])
    expect(gathering.activeChannels()).toEqual(['lirik'])
  })

  it('notifies once when a gathering forms', () => {
    const gathering = watcher()
    gathering.update([], null)

    gathering.update([at('lirik', 'a', 'b')], null)

    expect(notices).toEqual([{ channel: 'lirik', friendIds: ['a', 'b'] }])
  })

  it('does not notify for a single friend', () => {
    const gathering = watcher()
    gathering.update([], null)
    gathering.update([at('lirik', 'a')], null)

    expect(notices).toEqual([])
  })

  it('stays quiet through repeated identical updates', () => {
    // Presence heartbeats arrive constantly; none of them are news.
    const gathering = watcher()
    gathering.update([], null)
    gathering.update([at('lirik', 'a', 'b')], null)

    for (let i = 0; i < 20; i++) gathering.update([at('lirik', 'a', 'b')], null)

    expect(notices).toHaveLength(1)
  })

  it('does not notify again just because more friends arrive', () => {
    const gathering = watcher()
    gathering.update([], null)
    gathering.update([at('lirik', 'a', 'b')], null)
    gathering.update([at('lirik', 'a', 'b', 'c')], null)
    gathering.update([at('lirik', 'a', 'b', 'c', 'd')], null)

    expect(notices).toHaveLength(1)
  })

  it('does not notify when a gathering shrinks but survives', () => {
    const gathering = watcher()
    gathering.update([], null)
    gathering.update([at('lirik', 'a', 'b', 'c')], null)
    gathering.update([at('lirik', 'a', 'b')], null)

    expect(notices).toHaveLength(1)
    expect(gathering.activeChannels()).toEqual(['lirik'])
  })

  it('does not fire repeatedly when a gathering oscillates around the threshold', () => {
    // 2 -> 1 -> 2 -> 1 -> 2 within the cooldown is one social event, not four.
    const gathering = watcher()
    gathering.update([], null)
    gathering.update([at('lirik', 'a', 'b')], null)

    for (let i = 0; i < 5; i++) {
      gathering.update([at('lirik', 'a')], null)
      gathering.update([at('lirik', 'a', 'b')], null)
    }

    expect(notices).toHaveLength(1)
  })

  it('notifies again for a genuinely new gathering after the cooldown', () => {
    const gathering = watcher({ cooldownMs: 30 * 60_000 })
    gathering.update([], null)
    gathering.update([at('lirik', 'a', 'b')], null)
    expect(notices).toHaveLength(1)

    gathering.update([], null) // everyone left
    clock += 31 * 60_000 // an evening later
    gathering.update([at('lirik', 'a', 'b')], null)

    expect(notices).toHaveLength(2)
  })

  it('still refuses a re-formed gathering inside the cooldown', () => {
    const gathering = watcher({ cooldownMs: 30 * 60_000 })
    gathering.update([], null)
    gathering.update([at('lirik', 'a', 'b')], null)

    gathering.update([], null)
    clock += 60_000 // a minute later
    gathering.update([at('lirik', 'a', 'b')], null)

    expect(notices).toHaveLength(1)
  })

  it('never tells the user to join the channel they are already watching', () => {
    const gathering = watcher()
    gathering.update([], 'lirik')
    gathering.update([at('lirik', 'a', 'b')], 'lirik')

    expect(notices).toEqual([])
  })

  it('does not pounce the moment the user leaves that channel', () => {
    // They just walked out; announcing it would be absurd.
    const gathering = watcher()
    gathering.update([], 'lirik')
    gathering.update([at('lirik', 'a', 'b')], 'lirik')
    gathering.update([at('lirik', 'a', 'b')], 'shroud')

    expect(notices).toEqual([])
  })

  it('handles several channels independently', () => {
    const gathering = watcher()
    gathering.update([], null)
    gathering.update([at('lirik', 'a', 'b')], null)
    gathering.update([at('lirik', 'a', 'b'), at('shroud', 'c', 'd')], null)

    expect(notices.map((notice) => notice.channel)).toEqual(['lirik', 'shroud'])
  })

  it('forgets everything on sign-out', () => {
    const gathering = watcher()
    gathering.update([], null)
    gathering.update([at('lirik', 'a', 'b')], null)

    gathering.reset()
    // A fresh start seeds again rather than re-announcing.
    gathering.update([at('lirik', 'a', 'b')], null)

    expect(notices).toHaveLength(1)
  })

  it('treats channel casing as the same gathering', () => {
    const gathering = watcher()
    gathering.update([], null)
    gathering.update([at('lirik', 'a', 'b')], null)
    gathering.update([at('LIRIK', 'a', 'b')], null)

    expect(notices).toHaveLength(1)
  })
})

// -------------------------------------------- gatherings from real presence

describe('gatherings come only from real, visible presence', () => {
  const now = Date.now()
  const watching = (userId: string, channel: string, lastSeenAt = now): Presence => ({
    userId,
    status: 'online',
    activity: { type: 'watching', platform: 'twitch', channel },
    since: now,
    lastSeenAt,
  })

  it('forms at two friends on the same channel', () => {
    const found = findGatherings([watching('a', 'lirik'), watching('b', 'lirik')])
    expect(found).toEqual([{ platform: 'twitch', channel: 'lirik', userIds: ['a', 'b'] }])
  })

  it('excludes a friend whose presence went stale', () => {
    const found = findGatherings([
      watching('a', 'lirik'),
      watching('b', 'lirik', now - PRESENCE_STALE_MS - 1_000),
    ])
    expect(found[0].userIds).toEqual(['a'])
  })

  it('excludes a friend who is hiding their activity', () => {
    // hide_activity is applied server-side, so the row simply has no channel:
    // that friend is browsing, and browsing is not a place to gather.
    const hidden: Presence = {
      userId: 'b',
      status: 'online',
      activity: { type: 'browsing', platform: 'twitch' },
      since: now,
      lastSeenAt: now,
    }
    const found = findGatherings([watching('a', 'lirik'), hidden])
    expect(found[0].userIds).toEqual(['a'])
  })

  it('excludes an invisible friend entirely', () => {
    // Invisible arrives as an offline row with no activity at all.
    const invisible: Presence = {
      userId: 'b',
      status: 'offline',
      activity: IDLE,
      since: now,
      lastSeenAt: now,
    }
    const found = findGatherings([watching('a', 'lirik'), invisible])
    expect(found[0].userIds).toEqual(['a'])
  })

  it('leaves out the channel the user is on, which is HERE not a gathering', () => {
    const found = findGatherings([watching('a', 'lirik'), watching('b', 'lirik')], {
      type: 'watching',
      platform: 'twitch',
      channel: 'lirik',
    })
    expect(found).toEqual([])
  })
})

// ---------------------------------------------------------------- attention

describe('unread attention', () => {
  it('starts with nothing to notice', () => {
    expect(createAttentionService().getState()).toMatchObject({ unreadCount: 0 })
  })

  it('counts a new friend request as unread', () => {
    const attention = createAttentionService()
    attention.setItems([{ key: friendRequestKey('r1'), kind: 'friend_request', count: 1 }])

    expect(attention.getState().unreadCount).toBe(1)
  })

  it('counts a busy gathering as one thing, not one per person', () => {
    const attention = createAttentionService()
    attention.setItems([{ key: gatheringKey('lirik'), kind: 'gathering', count: 5 }])

    expect(attention.getState().unreadCount).toBe(1)
  })

  it('clears when the user looks at it', () => {
    const attention = createAttentionService()
    attention.setItems([{ key: gatheringKey('lirik'), kind: 'gathering', count: 3 }])
    attention.markKindSeen('gathering')

    expect(attention.getState().unreadCount).toBe(0)
    expect(attention.getState().items).toHaveLength(1) // still there, just seen
  })

  it('clears only the kind that was looked at', () => {
    const attention = createAttentionService()
    attention.setItems([
      { key: friendRequestKey('r1'), kind: 'friend_request', count: 1 },
      { key: gatheringKey('lirik'), kind: 'gathering', count: 2 },
    ])

    attention.markKindSeen('friend_request')

    expect(attention.getState().unread.map((item) => item.kind)).toEqual(['gathering'])
  })

  it('does not go unread again while the same thing persists', () => {
    const attention = createAttentionService()
    const item = { key: gatheringKey('lirik'), kind: 'gathering' as const, count: 2 }
    attention.setItems([item])
    attention.markKindSeen('gathering')

    // Presence keeps updating; the gathering grows. Still the same gathering.
    attention.setItems([{ ...item, count: 4 }])

    expect(attention.getState().unreadCount).toBe(0)
  })

  it('becomes unread again for a genuinely new gathering on that channel', () => {
    const attention = createAttentionService()
    attention.setItems([{ key: gatheringKey('lirik'), kind: 'gathering', count: 2 }])
    attention.markKindSeen('gathering')

    attention.setItems([]) // it ended
    attention.setItems([{ key: gatheringKey('lirik'), kind: 'gathering', count: 2 }])

    expect(attention.getState().unreadCount).toBe(1)
  })

  it('survives a worker restart', async () => {
    const area = createMemoryStorageArea()
    const first = createAttentionService({ storage: area })
    first.setItems([{ key: friendRequestKey('r1'), kind: 'friend_request', count: 1 }])
    first.markKindSeen('friend_request')

    const revived = createAttentionService({ storage: area })
    await revived.hydrate()
    revived.setItems([{ key: friendRequestKey('r1'), kind: 'friend_request', count: 1 }])

    expect(revived.getState().unreadCount).toBe(0)
  })

  it('forgets what was seen on sign-out', () => {
    const attention = createAttentionService()
    attention.setItems([{ key: friendRequestKey('r1'), kind: 'friend_request', count: 1 }])
    attention.markKindSeen('friend_request')

    attention.clear()
    attention.setItems([{ key: friendRequestKey('r1'), kind: 'friend_request', count: 1 }])

    expect(attention.getState().unreadCount).toBe(1)
  })

  it('notifies subscribers when unread changes', () => {
    const attention = createAttentionService()
    const seen: number[] = []
    attention.subscribe((state) => seen.push(state.unreadCount))

    attention.setItems([{ key: gatheringKey('lirik'), kind: 'gathering', count: 2 }])
    attention.markKindSeen('gathering')

    expect(seen).toEqual([0, 1, 0])
  })
})

// -------------------------------------------------------------- preferences

describe('notification preferences', () => {
  it('defaults gathering alerts on', () => {
    expect(createPreferences().get()).toEqual(DEFAULT_PREFERENCES)
    expect(DEFAULT_PREFERENCES.gatheringNotifications).toBe(true)
  })

  it('turns alerts off', async () => {
    const preferences = createPreferences()
    await preferences.set({ gatheringNotifications: false })
    expect(preferences.get().gatheringNotifications).toBe(false)
  })

  it('persists across a worker restart', async () => {
    const area = createMemoryStorageArea()
    await createPreferences(area).set({ gatheringNotifications: false })

    const revived = createPreferences(area)
    await revived.hydrate()

    expect(revived.get().gatheringNotifications).toBe(false)
  })

  it('falls back to defaults when nothing is stored', async () => {
    const preferences = createPreferences(createMemoryStorageArea())
    await preferences.hydrate()
    expect(preferences.get()).toEqual(DEFAULT_PREFERENCES)
  })

  it('ignores junk in storage rather than crashing', async () => {
    const area = createMemoryStorageArea()
    await area.set({ 'kickback:preferences': 'not an object' })
    const preferences = createPreferences(area)
    await preferences.hydrate()

    expect(preferences.get()).toEqual(DEFAULT_PREFERENCES)
  })
})

// ------------------------------------------------------------ notifications

describe('desktop notifications', () => {
  interface Created {
    id: string
    options: NotificationOptions
  }

  function harness() {
    const created: Created[] = []
    const cleared: string[] = []
    const opened: string[] = []
    let clickHandler: (id: string) => void = () => {}
    let buttonHandler: (id: string, index: number) => void = () => {}

    const notifier = createNotifier({
      create: (id, options) => created.push({ id, options }),
      clear: (id) => cleared.push(id),
      onClicked: (handler) => {
        clickHandler = handler
      },
      onButtonClicked: (handler) => {
        buttonHandler = handler
      },
      openUrl: (url) => opened.push(url),
      iconUrl: 'icons/icon-128.png',
    })

    return {
      notifier,
      created,
      cleared,
      opened,
      click: (id: string) => clickHandler(id),
      clickButton: (id: string, index = 0) => buttonHandler(id, index),
    }
  }

  it('names the friends and the channel', () => {
    const h = harness()
    h.notifier.notifyGathering({
      channel: 'lirik',
      names: ['Jake', 'Matt', 'Chris'],
      channelName: 'LIRIK',
    })

    expect(h.created).toHaveLength(1)
    expect(h.created[0].options.title).toBe('Jake, Matt and Chris on Twitch')
    expect(h.created[0].options.message).toBe('Watching LIRIK')
    expect(h.created[0].options.buttons?.[0].title).toBe('Join them')
  })

  it('shows the login rather than inventing capitalisation', () => {
    // Nothing knows how this channel spells itself, and `Anoterostv` would be
    // a name its owner never chose. The login is plain but true.
    const h = harness()
    h.notifier.notifyGathering({ channel: 'anoterostv', names: ['Jake'] })
    expect(h.created[0].options.message).toBe('Watching anoterostv')
  })

  it('refuses a display name that is a different word', () => {
    // A mismatched name would rename someone's channel in a desktop alert.
    const h = harness()
    h.notifier.notifyGathering({ channel: 'lirik', names: ['Jake'], channelName: 'Somebody Else' })
    expect(h.created[0].options.message).toBe('Watching lirik')
  })

  it('reuses one id per channel, so Chrome replaces rather than stacks', () => {
    const h = harness()
    h.notifier.notifyGathering({ channel: 'lirik', names: ['Jake', 'Matt'] })
    h.notifier.notifyGathering({ channel: 'lirik', names: ['Jake', 'Matt', 'Chris'] })

    expect(new Set(h.created.map((entry) => entry.id)).size).toBe(1)
  })

  it('opens the right Twitch channel when clicked', () => {
    const h = harness()
    h.notifier.notifyGathering({ channel: 'lirik', names: ['Jake', 'Matt'] })
    h.click(h.created[0].id)

    expect(h.opened).toEqual(['https://www.twitch.tv/lirik'])
  })

  it('opens from the Join button too', () => {
    const h = harness()
    h.notifier.notifyGathering({ channel: 'shroud', names: ['Jake', 'Matt'] })
    h.clickButton(h.created[0].id)

    expect(h.opened).toEqual(['https://www.twitch.tv/shroud'])
  })

  it('ignores notifications that are not ours', () => {
    const h = harness()
    h.click('some-other-extension:thing')
    expect(h.opened).toEqual([])
  })

  it('refuses to navigate anywhere a channel name could not go', () => {
    // The destination is rebuilt by re-parsing, never by string concatenation.
    const h = harness()
    h.click('kickback:gathering:../../evil')
    h.click('kickback:gathering:https://evil.test')
    h.click('kickback:gathering:')

    expect(h.opened).toEqual([])
  })

  it('will not create a notification for an invalid channel', () => {
    const h = harness()
    h.notifier.notifyGathering({ channel: 'not a channel!', names: ['Jake'] })
    expect(h.created).toEqual([])
  })

  it('reads a channel back out of its own id', () => {
    expect(channelFromNotificationId('kickback:gathering:lirik')).toBe('lirik')
    expect(channelFromNotificationId('nope')).toBeNull()
  })

  it('describes groups of friends readably', () => {
    expect(describeNames(['Jake'])).toBe('Jake')
    expect(describeNames(['Jake', 'Matt'])).toBe('Jake and Matt')
    expect(describeNames(['Jake', 'Matt', 'Chris'])).toBe('Jake, Matt and Chris')
    expect(describeNames(['Jake', 'Matt', 'Chris', 'Nina'])).toBe('Jake, Matt and 2 others')
    expect(describeNames([])).toBe('Friends')
  })
})

// --------------------------------------------- preference gates the alert

describe('the preference actually gates the alert', () => {
  it('stays silent when gathering alerts are off', async () => {
    const preferences = createPreferences()
    await preferences.set({ gatheringNotifications: false })

    const notified: string[] = []
    const gathering = createGatheringWatcher({
      onNotify: ({ channel }) => {
        // This mirrors the worker: the decision fires, the delivery checks.
        if (!preferences.get().gatheringNotifications) return
        notified.push(channel)
      },
    })

    gathering.update([], null)
    gathering.update([at('lirik', 'a', 'b')], null)

    expect(notified).toEqual([])
  })

  it('alerts again once they are turned back on', async () => {
    const preferences = createPreferences()
    await preferences.set({ gatheringNotifications: false })

    const notified: string[] = []
    const gathering = createGatheringWatcher({
      onNotify: ({ channel }) => {
        if (!preferences.get().gatheringNotifications) return
        notified.push(channel)
      },
    })
    gathering.update([], null)
    gathering.update([at('lirik', 'a', 'b')], null)

    await preferences.set({ gatheringNotifications: true })
    gathering.update([], null)
    gathering.update([at('shroud', 'a', 'b')], null)

    expect(notified).toEqual(['shroud'])
  })
})

// ------------------------------------------------------------------- misc

describe('no invented attention', () => {
  it('produces nothing from an empty world', () => {
    const attention = createAttentionService()
    attention.setItems([])
    expect(attention.getState()).toMatchObject({ items: [], unread: [], unreadCount: 0 })
  })

  it('never notifies without a real gathering to notify about', () => {
    const notices: GatheringNotice[] = []
    const gathering = createGatheringWatcher({ onNotify: (n) => notices.push(n) })

    gathering.update([], null)
    gathering.update([], null)
    gathering.update([at('lirik', 'a')], null)

    expect(notices).toEqual([])
  })
})
