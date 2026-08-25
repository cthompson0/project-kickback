import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SocialGravity } from '../../src/ui/components/SocialGravity'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import { createStreamRoom } from '../../src/background/streamRoom'
import { createPresenceReporter } from '../../src/background/presence'
import type { ChannelMetadata } from '../../src/core/twitchMetadata'
import type { Activity, Presence } from '../../src/core/types'
import type { Friend, KickbackClient } from '../../src/client/types'

/**
 * The ROOM button that never appeared.
 *
 * Two real accounts, both on the same LIVE channel, both showing "1 friend
 * watching with you" - and neither card offering a way into the room.
 *
 * Nothing was failing. `stream_room_members` refuses unless the CALLER's own
 * presence row says they are on the channel, and it refuses by returning no
 * rows rather than by erroring. Presence writes are debounced by a second;
 * metadata resolves from the hydrated cache in the same tick as the first
 * activity report. So the membership query fired about a second before our own
 * presence row existed, came back legitimately empty, and was then cached as
 * the answer - on both accounts, every page load, symmetrically.
 *
 * And nothing re-asked. `room.want` was only reached from `pushActivity`,
 * which presence updates do not run, so the empty answer survived until the
 * viewer navigated or half an hour passed.
 *
 * This file reproduces the whole chain with the real services composed the way
 * the worker composes them: eligibility → presence written → membership query
 * → members → the affordance.
 */

const NOW = 1_700_000_000_000
const CHANNEL = 'cdnthe3rd'
const FRIEND = 'friend-1'

const LIVE: Record<string, ChannelMetadata> = {
  [CHANNEL]: {
    login: CHANNEL,
    userId: null,
    displayName: 'CDNThe3rd',
    profileImageUrl: null,
    live: 'live',
    gameName: null,
    title: null,
    viewerCount: null,
    startedAt: null,
    fetchedAt: NOW,
  },
}

const WATCHING: Activity = { type: 'watching', platform: 'twitch', channel: CHANNEL }

/** The same record, stamped now: the freshness rule reads the real clock. */
const liveNow = (): Record<string, ChannelMetadata> => ({
  [CHANNEL]: { ...LIVE[CHANNEL], fetchedAt: Date.now() },
})

/**
 * The server, behaving exactly as 0020 does.
 *
 * The important half is that an absent caller is not an error. The RPC returns
 * early, which reaches the client as an empty result set - indistinguishable
 * from a real room of nobody unless you know why you asked.
 */
function fakeServer() {
  const present = new Set<string>()
  let calls = 0

  return {
    present,
    calls: () => calls,
    backend: {
      async members(channel: string): Promise<unknown> {
        calls += 1
        if (channel !== CHANNEL) return []
        // `if not exists (caller present) then return; end if;`
        if (!present.has('me')) return []
        return [...present]
          .filter((id) => id !== 'me')
          .map((id) => ({ user_id: id, hops: 1, via_user_id: null }))
      },
    },
  }
}


const FRIEND_ROW: Friend = {
  user: {
    id: FRIEND,
    username: 'bianca',
    displayName: 'Bianca',
    avatarUrl: null,
    accentColor: '#ff8452',
  },
  presence: {
    userId: FRIEND,
    status: 'online',
    activity: WATCHING,
    since: NOW - 60_000,
    lastSeenAt: Date.now(),
  } as Presence,
}

/** The HERE card, with whatever membership the server has confirmed. */
function drawCard(roomMembers: Array<{ userId: string; hops: number; viaUserId: string | null }>) {
  return renderToStaticMarkup(
    <ChannelNameProvider people={[]} seen={{}}>
      <SocialGravity
        friends={[FRIEND_ROW]}
        localActivity={WATCHING}
        client={{ sendReaction: () => {} } as unknown as KickbackClient}
        cardContext={{
          selfId: 'me',
          viewerActivity: WATCHING,
          friendIds: new Set([FRIEND]),
          outgoingRequestIds: new Set(),
        }}
        metadata={liveNow()}
        reactions={[]}
        roomMembers={roomMembers}
        onOpenRoom={() => {}}
      />
    </ChannelNameProvider>,
  )
}

describe('the membership query and our own presence row', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('caches an empty room, so asking before our presence is written is permanent', async () => {
    /*
     * The failure, pinned so it cannot come back. This is what the shipped
     * build did, and every assertion here is the WRONG outcome on purpose.
     */
    const server = fakeServer()
    server.present.add(FRIEND) // the friend is already there
    const room = createStreamRoom({ backend: server.backend, now: () => Date.now() })

    room.want(CHANNEL)
    await vi.advanceTimersByTimeAsync(0)

    expect(server.calls()).toBe(1)
    expect(room.snapshot()).toEqual([])

    // Our presence lands a second later. Nothing re-asks, and the cache holds.
    server.present.add('me')
    room.want(CHANNEL)
    await vi.advanceTimersByTimeAsync(0)
    expect(server.calls()).toBe(1)
    expect(room.snapshot()).toEqual([])
  })

  it('resolves when the query waits for the presence write, as the worker now does', async () => {
    const server = fakeServer()
    server.present.add(FRIEND)

    const written: Activity[] = []
    const reporter = createPresenceReporter({
      backend: {
        reportPresence: async () => {
          server.present.add('me')
          return { value: true as const }
        },
        heartbeat: async () => ({ value: true as const }),
        reportOffline: async () => ({ value: true as const }),
      },
      onReported: (activity) => written.push(activity),
    })

    const room = createStreamRoom({ backend: server.backend, now: () => Date.now() })

    /**
     * The worker's sessionChannel(), in the order the worker applies it.
     *
     * Live status is deliberately NOT part of it any more - a session needs
     * somewhere to be and somebody to be there with, not a broadcast. What
     * remains is the precondition the server itself applies: our own presence
     * row has to exist before stream_room_members will answer.
     */
    const sessionChannel = (): string | null => {
      const reported = reporter.lastReported()
      if (reported?.type !== 'watching' || reported.channel !== CHANNEL) return null
      return CHANNEL
    }

    // First activity report: eligible, but we are not visibly there yet.
    reporter.setActivity(WATCHING)
    expect(sessionChannel()).toBeNull()
    room.want(sessionChannel())
    await vi.advanceTimersByTimeAsync(0)
    expect(server.calls()).toBe(0)

    // The debounced write lands, and onReported re-runs the same decision.
    await vi.advanceTimersByTimeAsync(1_100)
    expect(written).toHaveLength(1)

    room.want(sessionChannel())
    await vi.advanceTimersByTimeAsync(0)

    expect(server.calls()).toBe(1)
    expect(room.snapshot()).toEqual([{ userId: FRIEND, hops: 1, viaUserId: null }])
  })

  it('asks again when a friend arrives after the room resolved empty', async () => {
    /*
     * The second half. We were alone, so the room legitimately held nobody;
     * a friend arriving is the only thing that changes that answer, and
     * membership is cached for two heartbeats - so the arrival has to
     * invalidate rather than wait.
     */
    const server = fakeServer()
    server.present.add('me')
    const room = createStreamRoom({ backend: server.backend, now: () => Date.now() })

    room.want(CHANNEL)
    await vi.advanceTimersByTimeAsync(0)
    expect(room.snapshot()).toEqual([])
    expect(server.calls()).toBe(1)

    // Presence says somebody arrived. Without invalidate the cache holds.
    server.present.add(FRIEND)
    room.want(CHANNEL)
    await vi.advanceTimersByTimeAsync(0)
    expect(server.calls()).toBe(1)

    room.invalidate()
    room.want(CHANNEL)
    await vi.advanceTimersByTimeAsync(0)

    expect(server.calls()).toBe(2)
    expect(room.snapshot()).toEqual([{ userId: FRIEND, hops: 1, viaUserId: null }])
  })

  it('does not ask again while nobody has come or gone', async () => {
    // The reason the cache exists: a heartbeat is not a change.
    const server = fakeServer()
    server.present.add('me')
    server.present.add(FRIEND)
    const room = createStreamRoom({ backend: server.backend, now: () => Date.now() })

    room.want(CHANNEL)
    await vi.advanceTimersByTimeAsync(0)
    for (let beat = 0; beat < 5; beat += 1) {
      await vi.advanceTimersByTimeAsync(1_000)
      room.want(CHANNEL)
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(server.calls()).toBe(1)
  })
})

describe('the worker wires the whole chain', () => {
  const WORKER = readFileSync('src/background/index.ts', 'utf8')

  it('will not ask for a room before our presence row exists', () => {
    expect(WORKER).toContain('const reported = presenceReporter.lastReported()')
    expect(WORKER).toContain(`if (reported?.type !== 'watching' || reported.channel !== here) return null`)
  })

  it('re-evaluates the moment the presence write lands', () => {
    // Without this the debounce leaves the first eligible page load with
    // nothing to re-trigger on, which is the bug in one line.
    expect(WORKER).toContain('onReported: () => pushActivity()')
  })

  it('re-asks when somebody arrives on or leaves the channel', () => {
    expect(WORKER).toContain('function coPresenceKey(')
    expect(WORKER).toContain('room.invalidate()')
    const index = WORKER.slice(WORKER.indexOf('function indexPresence('))
    expect(index.slice(0, 1_600)).toContain('room.want(here)')
  })

  it('keys the re-ask on who is here, not on every presence tick', () => {
    // One query per real arrival or departure. A count would miss two people
    // swapping; a bare tick would be a query per heartbeat per friend.
    expect(WORKER).toContain('if (key !== coPresence)')
    expect(WORKER).toContain('return here.sort().join(')
  })
})

// ------------------------------------------------------ and then it renders

describe('one resolved member puts ROOM on the card', () => {
  it('renders the affordance for metadata live + one friend + one member', () => {
    /*
     * The end of the chain the bug report described: live metadata, the
     * observer and one friend on the same channel, HERE count 1 - and now a
     * membership answer, which is what the affordance actually depends on.
     */
    const html = drawCard([{ userId: FRIEND, hops: 1, viaUserId: null }])

    expect(html).toContain('kb-badge-here')
    expect(html).toContain('1 friend watching with you')
    expect(html).toContain('kb-live')
    expect(html).toContain('kb-together-open')
    expect(html).toContain('ROOM')
  })

  it('is the membership answer, not the HERE count, that puts it there', () => {
    /*
     * The screenshot itself: live, HERE 1, and no members.
     *
     * This must STILL draw no doorway. The fix is that the members now arrive,
     * not that the condition was loosened - a card that offered a room the
     * server had not confirmed would be back to promising somewhere to go and
     * then arriving nowhere.
     */
    const html = drawCard([])

    expect(html).toContain('1 friend watching with you')
    expect(html).toContain('kb-live')
    expect(html).not.toContain('kb-together-open')
  })
})
