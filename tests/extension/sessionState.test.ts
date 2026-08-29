import { describe, expect, it } from 'vitest'
import {
  openSessionChannels,
  peersOnChannel,
  restoredSessionChannel,
  sessionChannelOf,
  unreadByChannel,
} from '../../src/background/sessionState'
import type { Presence } from '../../src/core/types'
import type { RoomMessage } from '../../src/core/roomMessages'

/**
 * The rules that decide whether the viewer has a Stream Room.
 *
 * These were answered inline in the service worker and protected only by
 * string-matching its source - three such pins existed, one of them broke on a
 * CRLF checkout, and none of them could assert what the rules actually did.
 * They are now importable, so this file asserts behaviour instead.
 */

const NOW = 1_700_000_000_000

const watching = (userId: string, channel: string): Presence => ({
  userId,
  status: 'online',
  activity: { type: 'watching', platform: 'twitch', channel },
  since: NOW - 60_000,
  lastSeenAt: Date.now(),
})

const browsing = (userId: string): Presence => ({
  userId,
  status: 'online',
  activity: { type: 'browsing', platform: 'twitch' },
  since: NOW,
  lastSeenAt: Date.now(),
})

const message = (channel: string, at: number, senderId = 'friend'): RoomMessage => ({
  id: `${channel}-${at}`,
  channel,
  senderId,
  body: 'hello',
  at,
  receivedAt: at,
})

// -------------------------------------------------------- the session gate

describe('a channel is only a room once the write has landed', () => {
  it('is null before the destination is published', () => {
    expect(sessionChannelOf('lirik', [])).toBeNull()
  })

  it('is the channel once it is published', () => {
    expect(sessionChannelOf('lirik', ['lirik'])).toBe('lirik')
  })

  it('is null when the viewer is nowhere', () => {
    expect(sessionChannelOf(null, ['lirik'])).toBeNull()
  })

  /** Multi-destination: any published channel counts, not just the first. */
  it('accepts a channel that is not the published primary', () => {
    expect(sessionChannelOf('timthetatman', ['lirik', 'teamliquid', 'timthetatman'])).toBe(
      'timthetatman',
    )
  })

  it('is null for a channel that was never published', () => {
    expect(sessionChannelOf('shroud', ['lirik', 'teamliquid'])).toBeNull()
  })
})

describe('the open session set', () => {
  it('is the intersection of open and published', () => {
    expect(openSessionChannels(['a', 'b', 'c'], ['a', 'c'])).toEqual(['a', 'c'])
  })

  it('drops a tab that is open but not yet published', () => {
    expect(openSessionChannels(['a', 'b'], ['a'])).toEqual(['a'])
  })

  it('drops a destination that is published but no longer open', () => {
    expect(openSessionChannels(['a'], ['a', 'b'])).toEqual(['a'])
  })

  /** The server's order, because that order decides the legacy primary. */
  it('keeps the published order rather than the tab order', () => {
    expect(openSessionChannels(['b', 'a'], ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('is empty when nothing is both', () => {
    expect(openSessionChannels(['a'], ['b'])).toEqual([])
  })
})

// ------------------------------------------------------------------- peers

describe('who is here with the viewer', () => {
  const base = {
    channel: 'lirik',
    friendIds: new Set(['friend-1', 'friend-2']),
    selfId: 'me',
  }

  it('finds a friend on the same channel', () => {
    expect(
      peersOnChannel({ ...base, presence: { 'friend-1': watching('friend-1', 'lirik') } }),
    ).toEqual(['friend-1'])
  })

  it('ignores a friend somewhere else', () => {
    expect(
      peersOnChannel({ ...base, presence: { 'friend-1': watching('friend-1', 'shroud') } }),
    ).toEqual([])
  })

  it('ignores somebody who is merely browsing', () => {
    expect(peersOnChannel({ ...base, presence: { 'friend-1': browsing('friend-1') } })).toEqual([])
  })

  /** Presence for somebody we only know through a group is not a peer here. */
  it('ignores a non-friend on the same channel', () => {
    expect(
      peersOnChannel({ ...base, presence: { stranger: watching('stranger', 'lirik') } }),
    ).toEqual([])
  })

  it('never counts the viewer', () => {
    expect(peersOnChannel({ ...base, presence: { me: watching('me', 'lirik') } })).toEqual([])
  })

  it('is sorted, so the answer is stable between renders', () => {
    expect(
      peersOnChannel({
        ...base,
        presence: {
          'friend-2': watching('friend-2', 'lirik'),
          'friend-1': watching('friend-1', 'lirik'),
        },
      }),
    ).toEqual(['friend-1', 'friend-2'])
  })

  /** Each destination has its own set; they must not merge. */
  it('answers per channel', () => {
    const presence = {
      'friend-1': watching('friend-1', 'lirik'),
      'friend-2': watching('friend-2', 'teamliquid'),
    }
    expect(peersOnChannel({ ...base, presence })).toEqual(['friend-1'])
    expect(peersOnChannel({ ...base, channel: 'teamliquid', presence })).toEqual(['friend-2'])
  })
})

// ------------------------------------------------------- restoring a room

describe('restoring a remembered session', () => {
  const here = 'lirik'

  it('restores it when the server says somebody is in the room', () => {
    expect(
      restoredSessionChannel({ remembered: here, here, members: [{}], peers: [], messages: [] }),
    ).toBe(here)
  })

  it('restores it when presence says a friend is here', () => {
    expect(
      restoredSessionChannel({
        remembered: here,
        here,
        members: [],
        peers: ['friend-1'],
        messages: [],
      }),
    ).toBe(here)
  })

  /**
   * The lifecycle that superseded the Patch 1 workaround: a room stays
   * restorable for exactly as long as its conversation lives.
   */
  it('restores it when only the conversation remains', () => {
    expect(
      restoredSessionChannel({
        remembered: here,
        here,
        members: [],
        peers: [],
        messages: [message(here, Date.now())],
      }),
    ).toBe(here)
  })

  it('does not restore it on no evidence at all', () => {
    expect(
      restoredSessionChannel({ remembered: here, here, members: [], peers: [], messages: [] }),
    ).toBeNull()
  })

  /** A stale record must never reopen an unrelated streamer's session. */
  it('does not restore a session for somewhere else', () => {
    expect(
      restoredSessionChannel({
        remembered: here,
        here: 'someone_else',
        members: [{}],
        peers: ['friend-1'],
        messages: [message(here, Date.now())],
      }),
    ).toBeNull()
  })

  /** Another room's conversation is not evidence for this one. */
  it('does not accept messages from a different channel', () => {
    expect(
      restoredSessionChannel({
        remembered: here,
        here,
        members: [],
        peers: [],
        messages: [message('teamliquid', Date.now())],
      }),
    ).toBeNull()
  })

  it('is null when nothing was remembered', () => {
    expect(
      restoredSessionChannel({ remembered: null, here, members: [{}], peers: [], messages: [] }),
    ).toBeNull()
  })
})

// ------------------------------------------------------------------ unread

describe('unread, per destination', () => {
  const selfId = 'me'
  const readAt = () => 0

  it('counts a channel with messages', () => {
    const counts = unreadByChannel({
      messages: [message('lirik', Date.now())],
      open: ['lirik'],
      readAt,
      selfId,
    })
    expect(counts.lirik).toBe(1)
  })

  it('keeps two rooms apart', () => {
    const counts = unreadByChannel({
      messages: [
        message('lirik', Date.now()),
        message('teamliquid', Date.now()),
        message('teamliquid', Date.now() + 1),
      ],
      open: ['lirik', 'teamliquid'],
      readAt,
      selfId,
    })
    expect(counts.lirik).toBe(1)
    expect(counts.teamliquid).toBe(2)
  })

  it('reports zero for an open channel with nothing in it', () => {
    const counts = unreadByChannel({ messages: [], open: ['lirik'], readAt, selfId })
    expect(counts.lirik).toBe(0)
  })

  /** A room kept alive only by its conversation still carries a count. */
  it('counts a channel that is retained but no longer open', () => {
    const counts = unreadByChannel({
      messages: [message('teamliquid', Date.now())],
      open: ['lirik'],
      readAt,
      selfId,
    })
    expect(counts.teamliquid).toBe(1)
  })

  it('does not count the viewer’s own messages', () => {
    const counts = unreadByChannel({
      messages: [message('lirik', Date.now(), selfId)],
      open: ['lirik'],
      readAt,
      selfId,
    })
    expect(counts.lirik).toBe(0)
  })

  it('does not count what was already read', () => {
    const at = Date.now()
    const counts = unreadByChannel({
      messages: [message('lirik', at)],
      open: ['lirik'],
      readAt: () => at + 1,
      selfId,
    })
    expect(counts.lirik).toBe(0)
  })
})
