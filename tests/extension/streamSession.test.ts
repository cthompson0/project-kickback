import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoomMessages } from '../../src/background/roomMessages'
import { createSessionTab, SELECTION_TTL_MS } from '../../src/background/sessionTab'
import {
  MAX_MESSAGES,
  MAX_MESSAGE_LENGTH,
  RETENTION_MS,
  comboStream,
  liveMessages,
  parseRoomMessage,
  pruneMessages,
  roomActivity,
  unreadCount,
  withMessage,
  withMessages,
} from '../../src/core/roomMessages'
import type { RoomMessage } from '../../src/core/roomMessages'
import { ACTIVITY_TTL_MS } from '../../src/core/together'
import type { TogetherReaction } from '../../src/core/together'
import { isMuted, parseMutedIds, withMuted, withoutMuted, withoutMutedSenders } from '../../src/core/mute'
import { scanCombos } from '../../src/core/combos'

/**
 * The contextual stream session, from the lifecycle table in
 * docs/checkpoints/contextual-stream-session-architecture.md.
 *
 * What is asserted here is the parts a browser cannot show you: what survives
 * a refresh, what a stale selection is allowed to reopen, what counts as
 * unread, and what a muted person contributes. The merge and split rules -
 * which are the reason this architecture was chosen - live in
 * tests/db/roomMessages.test.ts, because they are decided in SQL.
 */

const NOW = 1_700_000_000_000
const CHANNEL = 'lirik'

const message = (over: Partial<RoomMessage> = {}): RoomMessage => ({
  id: `m-${over.senderId ?? 'jake'}-${over.at ?? NOW}`,
  senderId: 'jake',
  channel: CHANNEL,
  body: 'holy shit',
  at: NOW,
  receivedAt: over.at ?? NOW,
  ...over,
})

const reaction = (over: Partial<TogetherReaction> = {}): TogetherReaction => ({
  id: `r-${over.senderId ?? 'jake'}-${over.at ?? NOW}`,
  senderId: 'jake',
  channel: CHANNEL,
  reaction: 'lol',
  at: NOW,
  receivedAt: over.at ?? NOW,
  ...over,
})

const nameOf = (userId: string) => userId

// -------------------------------------------------------------- retention

describe('what a message is, and how long', () => {
  it('agrees with the server about every bound', () => {
    /*
     * Read from the migration, so the two cannot drift. The client's copies
     * exist to stop a composer before the round trip, not to be the authority.
     */
    const sql = readFileSync('supabase/migrations/0021_room_messages.sql', 'utf8')
    expect(sql).toContain('between 1 and 280')
    expect(MAX_MESSAGE_LENGTH).toBe(280)
    expect(sql).toContain(`interval '30 minutes'`)
    expect(RETENTION_MS).toBe(30 * 60_000)
    expect(sql).toContain('offset 200')
    expect(MAX_MESSAGES).toBe(200)
  })

  it('keeps a message for thirty minutes, not eight seconds', () => {
    // The whole reason messages are not reactions: a refresh, an eviction or
    // an ad break must not destroy what people were saying.
    const old = message({ at: NOW - RETENTION_MS + 1_000 })
    expect(liveMessages([old], CHANNEL, NOW)).toHaveLength(1)
    expect(pruneMessages([old], NOW + 2_000)).toHaveLength(0)
  })

  it('bounds the buffer however fast people talk', () => {
    let buffer: RoomMessage[] = []
    for (let i = 0; i < MAX_MESSAGES + 50; i += 1) {
      buffer = withMessage(buffer, message({ id: `m-${i}`, at: NOW + i }))
    }
    expect(buffer).toHaveLength(MAX_MESSAGES)
    // The newest survive, which is the half that matters.
    expect(buffer[buffer.length - 1].id).toBe(`m-${MAX_MESSAGES + 49}`)
  })

  it('folds a re-delivered row rather than showing it twice', () => {
    // Realtime can redeliver, and a history fetch overlaps with live delivery.
    const one = message({ id: 'same' })
    expect(withMessage([one], { ...one })).toHaveLength(1)
    expect(withMessages([one], [one, message({ id: 'other', at: NOW + 1 })])).toHaveLength(2)
  })

  it('orders by the server clock, so every client agrees', () => {
    const merged = withMessages([], [
      message({ id: 'b', at: NOW + 100 }),
      message({ id: 'a', at: NOW }),
    ])
    expect(merged.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('drops a row that does not validate', () => {
    expect(parseRoomMessage({ id: 1 })).toBeNull()
    expect(parseRoomMessage({ id: 'a', sender_id: 'b', channel: 'BAD!', body: 'x' })).toBeNull()
    expect(
      parseRoomMessage({ id: 'a', sender_id: 'b', channel: CHANNEL, body: 'x'.repeat(281) }),
    ).toBeNull()
    expect(
      parseRoomMessage({
        id: 'a',
        sender_id: 'b',
        channel: CHANNEL,
        body: 'hi',
        created_at: new Date(NOW).toISOString(),
      }),
      // Arrival is stamped on OUR clock; see receivedAt.
    ).toMatchObject({ id: 'a', senderId: 'b', channel: CHANNEL, body: 'hi', at: NOW })
  })

  it('belongs to one channel', () => {
    const elsewhere = message({ channel: 'xqc' })
    expect(liveMessages([elsewhere], CHANNEL, NOW)).toEqual([])
    expect(liveMessages([message()], null, NOW)).toEqual([])
  })
})

// ------------------------------------------------------------------ unread

describe('unread is something waiting, not something happening', () => {
  it('counts what arrived after the watermark', () => {
    const messages = [
      message({ id: 'a', senderId: 'jake', at: NOW }),
      message({ id: 'b', senderId: 'jake', at: NOW + 1_000 }),
    ]
    expect(unreadCount(messages, CHANNEL, NOW, 'me', NOW + 2_000)).toBe(1)
    expect(unreadCount(messages, CHANNEL, 0, 'me', NOW + 2_000)).toBe(2)
    expect(unreadCount(messages, CHANNEL, NOW + 5_000, 'me', NOW + 6_000)).toBe(0)
  })

  it('never counts the viewer\'s own', () => {
    // Not because sending also marks read - because a thing you said is not a
    // thing waiting for you.
    const messages = [message({ id: 'mine', senderId: 'me', at: NOW + 1_000 })]
    expect(unreadCount(messages, CHANNEL, NOW, 'me', NOW + 2_000)).toBe(0)
  })

  it('does not count messages that have expired', () => {
    const messages = [message({ senderId: 'jake', at: NOW })]
    expect(unreadCount(messages, CHANNEL, 0, 'me', NOW + RETENTION_MS + 1)).toBe(0)
  })

  it('is per channel', () => {
    const messages = [message({ senderId: 'jake', channel: 'xqc', at: NOW + 1_000 })]
    expect(unreadCount(messages, CHANNEL, NOW, 'me', NOW + 2_000)).toBe(0)
  })
})

// ------------------------------------------------------------ one combo

describe('one combo stream, over reactions and messages', () => {
  it('merges both by time', () => {
    const stream = comboStream(
      [reaction({ id: 'r1', senderId: 'jake', at: NOW })],
      [message({ id: 'm1', senderId: 'matt', body: ':lol:', at: NOW + 100 })],
      nameOf,
    )
    expect(stream.map((entry) => entry.id)).toEqual(['r1', 'm1'])
  })

  it('lets a reaction and an emote-only message build the same run', () => {
    // A reaction IS an emote; an emote-only message is the same emote sent the
    // slow way. There is no rule here - scanCombos already had it.
    const activity = roomActivity(
      [reaction({ senderId: 'jake', reaction: 'lol', at: NOW })],
      [message({ senderId: 'matt', body: ':lol:', at: NOW + 100 })],
      CHANNEL,
      nameOf,
      NOW + 200,
    )
    expect(activity?.count).toBe(2)
    expect(activity?.emote.id).toBe('lol')
  })

  it('does not let text contribute', () => {
    const activity = roomActivity(
      [reaction({ senderId: 'jake', at: NOW })],
      [message({ senderId: 'matt', body: 'what just happened', at: NOW + 100 })],
      CHANNEL,
      nameOf,
      NOW + 200,
    )
    // Text closes the run rather than extending it, so nothing is happening.
    expect(activity).toBeNull()
  })

  it('lets text break a combo, which a room could never do before', () => {
    const { annotations } = scanCombos(
      comboStream(
        [],
        [
          message({ id: 'a', senderId: 'jake', body: ':lol:', at: NOW }),
          message({ id: 'b', senderId: 'matt', body: ':lol:', at: NOW + 10 }),
          message({ id: 'c', senderId: 'sara', body: ':lol:', at: NOW + 20 }),
          message({ id: 'd', senderId: 'jake', body: 'enough', at: NOW + 30 }),
        ],
        nameOf,
      ),
    )
    expect(annotations.get('d')?.brokeCombo?.count).toBe(3)
  })

  it('vanishes after the activity window, while the messages stay', () => {
    /*
     * The two lifetimes, in one assertion. The log still has the conversation;
     * the indicator has stopped claiming it is happening.
     */
    const messages = [
      message({ id: 'a', senderId: 'jake', body: ':lol:', at: NOW }),
      message({ id: 'b', senderId: 'matt', body: ':lol:', at: NOW + 10 }),
    ]
    expect(roomActivity([], messages, CHANNEL, nameOf, NOW + 20)?.count).toBe(2)
    expect(roomActivity([], messages, CHANNEL, nameOf, NOW + ACTIVITY_TTL_MS + 20)).toBeNull()
    expect(liveMessages(messages, CHANNEL, NOW + ACTIVITY_TTL_MS + 20)).toHaveLength(2)
  })
})

// -------------------------------------------------------------------- mute

describe('mute is local, and reaches the count', () => {
  it('adds, removes and recognises', () => {
    expect(isMuted(withMuted([], 'jake'), 'jake')).toBe(true)
    expect(isMuted(withoutMuted(['jake'], 'jake'), 'jake')).toBe(false)
    expect(withMuted(['jake'], 'jake')).toEqual(['jake'])
    expect(parseMutedIds(['a', 'a', 1, null, 'b'])).toEqual(['a', 'b'])
  })

  it('removes their contribution before the engine sees it', () => {
    /*
     * The non-obvious half. A muted person inflating a ×6 in your panel is
     * still them getting your attention, so they are filtered BEFORE the
     * count rather than after it.
     */
    const messages = [
      message({ id: 'a', senderId: 'jake', body: ':lol:', at: NOW }),
      message({ id: 'b', senderId: 'matt', body: ':lol:', at: NOW + 10 }),
    ]
    expect(roomActivity([], messages, CHANNEL, nameOf, NOW + 20)?.count).toBe(2)
    expect(
      roomActivity([], withoutMutedSenders(messages, ['matt']), CHANNEL, nameOf, NOW + 20)?.count,
    ).toBe(1)
  })

  it('filters reactions and messages through the same rule', () => {
    expect(withoutMutedSenders([reaction({ senderId: 'jake' })], ['jake'])).toEqual([])
    expect(withoutMutedSenders([message({ senderId: 'jake' })], ['jake'])).toEqual([])
    // Nobody muted is the identity, and must not copy.
    const messages = [message()]
    expect(withoutMutedSenders(messages, [])).toBe(messages)
  })

  it('never reaches the server', () => {
    // No table, no RPC, no migration. Asserted by reading them.
    const sql = readFileSync('supabase/migrations/0021_room_messages.sql', 'utf8')
    expect(sql).not.toContain('mute')
    const core = readFileSync('src/core/mute.ts', 'utf8')
    expect(core).not.toContain('supabase')
    expect(core).not.toContain('rpc')
  })
})

// -------------------------------------------------- the remembered session

describe('the remembered session tab', () => {
  function memoryStorage() {
    let items: Record<string, unknown> = {}
    return {
      items: () => items,
      seed(next: Record<string, unknown>) {
        items = { ...next }
      },
      storage: {
        async get(keys: string | string[]) {
          const wanted = Array.isArray(keys) ? keys : [keys]
          const out: Record<string, unknown> = {}
          for (const key of wanted) if (key in items) out[key] = items[key]
          return out
        },
        set(next: Record<string, unknown>) {
          items = { ...items, ...next }
        },
        remove(keys: string | string[]) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete items[key]
        },
      },
    }
  }

  let clock = NOW
  const now = () => clock

  beforeEach(() => {
    clock = NOW
  })

  it('remembers an intentional selection, and forgets leaving', () => {
    const mem = memoryStorage()
    const tab = createSessionTab({ storage: mem.storage, now })

    tab.select(CHANNEL)
    expect(tab.selected()).toBe(CHANNEL)
    expect(mem.items()['kickback:sessionTab']).toEqual({ channel: CHANNEL, selectedAt: NOW })

    tab.select(null)
    expect(tab.selected()).toBeNull()
    expect(mem.items()['kickback:sessionTab']).toBeUndefined()
  })

  it('survives a worker restart', async () => {
    const mem = memoryStorage()
    mem.seed({ 'kickback:sessionTab': { channel: CHANNEL, selectedAt: NOW - 1_000 } })

    const tab = createSessionTab({ storage: mem.storage, now })
    await tab.hydrate()
    expect(tab.selected()).toBe(CHANNEL)
  })

  it('will not honour a selection older than the bound', async () => {
    /*
     * Belt and braces on top of the real guard, which is that the caller
     * checks the channel is still the eligible one. This stops a forgotten key
     * resurfacing after a weekend.
     */
    const mem = memoryStorage()
    mem.seed({
      'kickback:sessionTab': { channel: CHANNEL, selectedAt: NOW - SELECTION_TTL_MS - 1 },
    })

    const tab = createSessionTab({ storage: mem.storage, now })
    await tab.hydrate()
    expect(tab.selected()).toBeNull()
  })

  it('refuses a stored value that is not a channel', async () => {
    const mem = memoryStorage()
    mem.seed({ 'kickback:sessionTab': { channel: '../evil', selectedAt: NOW } })

    const tab = createSessionTab({ storage: mem.storage, now })
    await tab.hydrate()
    expect(tab.selected()).toBeNull()
  })

  it('keeps a read watermark per channel, and ages it out', async () => {
    const mem = memoryStorage()
    const tab = createSessionTab({ storage: mem.storage, now })

    tab.markRead(CHANNEL)
    expect(tab.readAt(CHANNEL)).toBe(NOW)
    expect(tab.readAt('xqc')).toBe(0)

    clock = NOW + SELECTION_TTL_MS + 1
    const restarted = createSessionTab({ storage: mem.storage, now })
    await restarted.hydrate()
    expect(restarted.readAt(CHANNEL)).toBe(0)
  })

  it('keeps mutes across a restart', async () => {
    const mem = memoryStorage()
    const tab = createSessionTab({ storage: mem.storage, now })

    tab.setMuted('jake', true)
    expect(tab.muted()).toEqual(['jake'])

    const restarted = createSessionTab({ storage: mem.storage, now })
    await restarted.hydrate()
    expect(restarted.muted()).toEqual(['jake'])

    restarted.setMuted('jake', false)
    expect(restarted.muted()).toEqual([])
  })

  it('refreshes the clock when the same session is reselected', () => {
    // A long evening's viewing must not expire out from under the viewer.
    const mem = memoryStorage()
    const tab = createSessionTab({ storage: mem.storage, now })
    tab.select(CHANNEL)

    clock = NOW + SELECTION_TTL_MS - 1
    tab.select(CHANNEL)

    clock = NOW + SELECTION_TTL_MS + 1
    expect(tab.selected()).toBe(CHANNEL)
  })
})

// ------------------------------------------------------------ the inbox

describe('the message inbox', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function harness(history: unknown[] = []) {
    let deliver: ((row: unknown) => void) | null = null
    const sent: Array<{ channel: string; body: string }> = []
    let historyCalls = 0

    const service = createRoomMessages({
      channel: {
        async open(_userId, handlers) {
          deliver = handlers.onMessage
          return () => {
            deliver = null
          }
        },
      },
      backend: {
        async send(channel, body) {
          sent.push({ channel, body })
          return 2
        },
        async history() {
          historyCalls += 1
          return history
        },
      },
      now: () => Date.now(),
    })

    return {
      service,
      sent,
      historyCalls: () => historyCalls,
      deliver: (row: unknown) => deliver?.(row),
    }
  }

  const row = (over: Record<string, unknown> = {}) => ({
    id: 'row-1',
    sender_id: 'jake',
    channel: CHANNEL,
    body: 'holy shit',
    created_at: new Date(NOW).toISOString(),
    ...over,
  })

  it('recovers the conversation after a refresh', async () => {
    /*
     * The one functional difference from reactions, and the reason 0021 has an
     * inbox index that 0020 deliberately denied. A refresh must not start an
     * empty conversation.
     */
    const h = harness([row()])
    h.service.setUser('me')
    h.service.setChannels(CHANNEL ? [CHANNEL] : [])
    await vi.advanceTimersByTimeAsync(0)

    expect(h.service.snapshot()).toHaveLength(1)
    expect(h.service.snapshot()[0].body).toBe('holy shit')
  })

  it('re-fetches when the same channel is set again', async () => {
    // Which is what a refresh looks like from the worker's side: the viewer
    // has not moved, but this client may never have seen what was said.
    const h = harness([row()])
    h.service.setUser('me')
    h.service.setChannels(CHANNEL ? [CHANNEL] : [])
    await vi.advanceTimersByTimeAsync(0)
    h.service.setChannels(CHANNEL ? [CHANNEL] : [])
    await vi.advanceTimersByTimeAsync(0)

    expect(h.historyCalls()).toBeGreaterThan(1)
    // And still one message, because the row folded by id.
    expect(h.service.snapshot()).toHaveLength(1)
  })

  it('drops a message for a channel the viewer has left', async () => {
    const h = harness()
    h.service.setUser('me')
    h.service.setChannels(CHANNEL ? [CHANNEL] : [])
    await vi.advanceTimersByTimeAsync(0)

    h.deliver(row({ id: 'elsewhere', channel: 'xqc' }))
    expect(h.service.snapshot()).toHaveLength(0)
  })

  it('clears the conversation when the viewer moves', async () => {
    const h = harness()
    h.service.setUser('me')
    h.service.setChannels(CHANNEL ? [CHANNEL] : [])
    await vi.advanceTimersByTimeAsync(0)
    h.deliver(row())
    expect(h.service.snapshot()).toHaveLength(1)

    h.service.setChannels(['xqc'])
    expect(h.service.snapshot()).toHaveLength(0)
  })

  it('sends to the channel the worker knows about, never one it is told', () => {
    const h = harness()
    h.service.setUser('me')
    h.service.setChannels(CHANNEL ? [CHANNEL] : [])
    h.service.send(CHANNEL, '  hello  ')

    expect(h.sent).toEqual([{ channel: CHANNEL, body: 'hello' }])
  })

  it('sends nothing when there is nowhere to send it', () => {
    const h = harness()
    h.service.setUser('me')
    h.service.send(CHANNEL, 'into the void')
    expect(h.sent).toEqual([])
  })

  it('draws nothing optimistically', () => {
    // The sender's own copy comes back through the same inbox, so a message
    // the server declined does not appear for the one person who could not
    // otherwise tell.
    const h = harness()
    h.service.setUser('me')
    h.service.setChannels(CHANNEL ? [CHANNEL] : [])
    h.service.send(CHANNEL, 'hello')
    expect(h.service.snapshot()).toHaveLength(0)
  })

  it('forgets everything on sign-out', async () => {
    const h = harness()
    h.service.setUser('me')
    h.service.setChannels(CHANNEL ? [CHANNEL] : [])
    await vi.advanceTimersByTimeAsync(0)
    h.deliver(row())

    h.service.reset()
    expect(h.service.snapshot()).toHaveLength(0)
    expect(h.service.subscribedTo()).toBeNull()
  })
})

// ------------------------------------------------------------ the wiring

describe('the panel and the worker wire it the way the lifecycle says', () => {
  const PANEL = readFileSync('src/ui/KickbackPanel.tsx', 'utf8')
  const WORKER = readFileSync('src/background/index.ts', 'utf8')

  it('has a session tab that exists only while there is one', () => {
    expect(PANEL).toContain(`type Tab = 'friends' | 'groups' | 'session'`)
    // Either kind of evidence: presence for a direct friend, or the server for
    // anybody reached through one. Requiring only the second is what made a
    // card say "1 friend watching with you" and offer nowhere to go.
    //
    // Both are still required to be there, individually, so neither can be
    // dropped while the expression is being edited. A third condition -
    // retained messages - was added in Patch 1 as an explicitly temporary fix
    // for finding #10 and is covered by tests/extension/roomSurfaceRelief.tsx,
    // including the guard that it stays labelled as removable.
    // Both kinds of evidence survive, now read from THIS tab's channel.
    expect(PANEL).toContain('roomPeers.length > 0 || roomMembers.length > 0')
    // And the third condition is no longer temporary: a conversation keeps
    // its own room reachable for as long as its messages live.
    expect(PANEL).toContain('retainedHere')
    expect(PANEL).toContain('const sessionAvailable =')
    expect(PANEL).toContain('sessionChannel !== null &&')
    expect(PANEL).toContain('{sessionAvailable && sessionChannel && (')
  })

  it('never auto-selects it', () => {
    /*
     * A tab appearing must not move somebody's feet. The only automatic
     * selection is a RESTORE, which requires a remembered intent.
     */
    expect(PANEL).toContain(`requestedTab === null`)
    expect(PANEL).toContain('const restorable = view.sessionChannel !== null && sessionAvailable')
  })

  it('falls back to Friends rather than showing an empty session', () => {
    expect(PANEL).toContain(`requestedTab === 'session' && !sessionAvailable`)
  })

  it('makes the streamer tab the only way in', () => {
    // The card had a permanent button, then a combo CTA. Both are gone: the
    // tab is the doorway and the card's combo is only a signal.
    expect(PANEL).toContain(`chooseTab('session')`)
    expect(PANEL).not.toContain('onOpenRoom')
  })

  it('checks eligibility again before honouring a remembered selection', () => {
    // A stale record must never reopen an unrelated streamer's session, so
    // the worker re-derives all three conditions rather than trusting storage.
    expect(WORKER).toContain('function restoredSession()')
    expect(WORKER).toContain('if (remembered !== sessionChannel()) return null')
    expect(WORKER).toContain(
      // Restorable on either kind of presence OR on a retained conversation -
      // the lifecycle that supersedes the Patch 1 workaround.
      'room.snapshot(remembered).length > 0',
    )
  })

  it('only ever remembers the channel the viewer is actually on', () => {
    expect(WORKER).toContain('if (wanted && wanted === here) {')
  })

  it('follows the same session channel everything else does', () => {
    expect(WORKER).toContain('roomChat.setChannels(open)')
    // And the LIVE question is asked once, for analytics only.
    expect((WORKER.match(/canWatchLiveTogether\(/g) ?? []).length).toBe(1)
  })

  it('records a sent message on delivery, and never its body', () => {
    expect(WORKER).toContain(`'automatic_room_message_sent'`)
    expect(WORKER).toContain('length_bucket: lengthBucket(message.body.length)')
    expect(WORKER).not.toContain('body: message.body')
  })
})
