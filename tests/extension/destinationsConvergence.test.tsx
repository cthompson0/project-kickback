import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { KickbackPanel } from '../../src/ui/KickbackPanel'
import { createFriendDestinations } from '../../src/background/friendDestinations'
import { createMetadataService } from '../../src/background/metadata'
import { gravityChannels } from '../../src/core/socialGravity'
import { INITIAL_STATE } from '../../src/client/types'
import type { Friend, KickbackClient, KickbackState } from '../../src/client/types'
import type { Presence } from '../../src/core/types'

/**
 * Does a growing destination set actually converge on enriched cards?
 *
 * The owner's report: the right cards appear, the metadata is right when it
 * arrives, but arrival is unreliable - delayed, partial, and cured by a
 * refresh. That is an ASYNC LIFECYCLE question, not a data-model one, so this
 * file composes the real pieces the worker composes and drives them with fake
 * timers and deferred responses.
 *
 * Real: createFriendDestinations, createMetadataService, gravityChannels, and
 * KickbackPanel. Faked: the network and the clock. The wiring between them is
 * the worker's own, pinned at the bottom of the file so this harness cannot
 * drift away from what ships.
 */

const NOW = 1_700_000_000_000

const friend = (id: string, name: string, presence: Presence | null): Friend => ({
  user: { id, username: id, displayName: name, avatarUrl: null, accentColor: '#ff8452' },
  presence,
})

const watching = (userId: string, channel: string): Presence => ({
  userId,
  status: 'online',
  activity: { type: 'watching', platform: 'twitch', channel },
  since: NOW - 60_000,
  lastSeenAt: Date.now(),
})

const FRIEND_A = friend('a', 'Friend A', watching('a', 'lirik'))

const ONE = { a: ['lirik'] }
const THREE = { a: ['lirik', 'teamliquid', 'timthetatman'] }

const NAMES: Record<string, string> = {
  lirik: 'LIRIK',
  teamliquid: 'TeamLiquid',
  timthetatman: 'TimTheTatman',
}

/** What the Twitch metadata function returns, in its real wire shape. */
const payload = (logins: string[]) => ({
  channels: logins.map((login) => ({
    login,
    userId: '12345',
    displayName: NAMES[login] ?? login,
    profileImageUrl: `https://static-cdn.jtvnw.net/jtv_user_pictures/${login}.png`,
    live: 'live',
    gameName: 'Just Chatting',
    title: `${login} stream`,
    viewerCount: 1_000,
    startedAt: NOW - 3_600_000,
  })),
})

// ------------------------------------------------------------ the harness

/** One deferred fetch, so responses can be resolved out of order. */
interface Pending {
  logins: string[]
  resolve(value: unknown): void
  reject(error: unknown): void
}

function createWorker(
  options: {
    destinations?: Record<string, string[]>
    /**
     * How a destination change is wired.
     *
     * `enrich` is what ships. `broadcast-only` is the defect this file was
     * written for, kept so the failure can be reproduced rather than only
     * described - see "the wiring this replaced".
     */
    wiring?: 'enrich' | 'broadcast-only'
  } = {},
) {
  let served: Record<string, string[]> = options.destinations ?? {}
  const pending: Pending[] = []
  /** Every batch of channels the metadata backend was asked for, in order. */
  const requested: string[][] = []
  const broadcasts: string[] = []

  const metadata = createMetadataService({
    fetcher: {
      fetch: (logins: string[]) => {
        requested.push([...logins])
        return new Promise((resolve, reject) => {
          pending.push({ logins: [...logins], resolve, reject })
        })
      },
    },
    onChange: () => {
      broadcasts.push('metadata')
    },
    onError: () => {},
  })

  let friends: Friend[] = [FRIEND_A]

  /** The worker's wantMetadata, verbatim in shape. */
  const wantMetadata = () => {
    metadata.want(
      gravityChannels(
        friends.map((f) => ({ member: f, presence: f.presence, userId: f.user.id })),
        destinations.snapshot(),
      ),
    )
  }

  const destinations = createFriendDestinations({
    fetch: async () => ({ value: served }),
    // The worker's onChange, verbatim in shape.
    onChange: () => {
      if (options.wiring !== 'broadcast-only') wantMetadata()
      broadcasts.push('destinations')
    },
    onError: () => {},
    coalesceMs: 1_000,
  })

  return {
    metadata,
    destinations,
    requested,
    broadcasts,
    wantMetadata,
    setFriends(next: Friend[]) {
      friends = next
    },
    /** What list_friend_destinations will return next. */
    serve(next: Record<string, string[]>) {
      served = next
    },
    /** Resolve one in-flight metadata request by the channel it asked for. */
    respond(channel: string) {
      const index = pending.findIndex((entry) => entry.logins.includes(channel))
      expect(index).toBeGreaterThanOrEqual(0)
      const [entry] = pending.splice(index, 1)
      entry.resolve(payload(entry.logins))
    },
    /** Resolve every open request, whatever it asked for. */
    drain() {
      while (pending.length > 0) {
        const entry = pending.shift()
        entry?.resolve(payload(entry.logins))
      }
    },
    failNext() {
      const entry = pending.shift()
      expect(entry).toBeDefined()
      entry?.reject(new Error('twitch said no'))
    },
    pendingCount: () => pending.length,
    /** Everything the metadata cache currently holds. */
    enriched: () => Object.keys(metadata.snapshot()).sort(),
  }
}

const settle = () => vi.advanceTimersByTimeAsync(1_500)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

// ------------------------------------------------- the reported scenario

describe('a destination set that grows from one to three', () => {
  async function growToThree() {
    const worker = createWorker({ destinations: ONE })
    worker.destinations.refresh()
    await settle()
    worker.respond('lirik')
    await settle()
    expect(worker.enriched()).toEqual(['lirik'])

    // The friend opens two more streams. A presence event schedules the read.
    worker.serve(THREE)
    worker.destinations.schedule()
    await settle()
    return worker
  }

  it('requests the two channels it does not have', async () => {
    const worker = await growToThree()
    const asked = worker.requested.flat()
    expect(asked).toContain('teamliquid')
    expect(asked).toContain('timthetatman')
  })

  /** lirik is fresh; asking again would be a wasted request. */
  it('does not re-request the channel it already has fresh', async () => {
    const worker = await growToThree()
    // The first batch was for lirik at bootstrap; nothing after it repeats it.
    expect(worker.requested.slice(1).flat()).not.toContain('lirik')
  })

  it('converges on all three without any further destination change', async () => {
    const worker = await growToThree()
    worker.drain()
    await settle()

    expect(worker.enriched()).toEqual(['lirik', 'teamliquid', 'timthetatman'])
  })

  it('broadcasts once the metadata lands', async () => {
    const worker = await growToThree()
    const before = worker.broadcasts.length
    worker.respond('teamliquid')
    await settle()
    expect(worker.broadcasts.length).toBeGreaterThan(before)
    expect(worker.broadcasts).toContain('metadata')
  })
})

// --------------------------------------------- the wiring this replaced

/**
 * The defect, reproduced.
 *
 * Before the fix, a changed destination set broadcast to the panel and told
 * nobody to fetch anything. The panel drew three cards from a metadata cache
 * that held one, and the two new channels stayed bare until some unrelated
 * event happened to call `wantMetadata` again - a friend's next heartbeat, the
 * viewer changing tab, or a reload. Delayed, partial, cured by refreshing:
 * exactly what was reported.
 */
describe('the wiring this replaced', () => {
  async function growWith(wiring: 'enrich' | 'broadcast-only') {
    const worker = createWorker({ destinations: ONE, wiring })
    worker.destinations.refresh()
    await settle()
    /*
     * Bootstrap enriches either way - sign-in loads friends, which calls
     * refreshAttention -> wantMetadata on its own. That is exactly why a
     * reload appeared to fix the bug and an incremental change did not.
     */
    worker.wantMetadata()
    await settle()
    worker.respond('lirik')
    await settle()

    worker.serve(THREE)
    worker.destinations.schedule()
    await settle()
    return worker
  }

  it('never asks about the new channels', async () => {
    const worker = await growWith('broadcast-only')
    expect(worker.requested.flat()).not.toContain('teamliquid')
    expect(worker.requested.flat()).not.toContain('timthetatman')
    expect(worker.enriched()).toEqual(['lirik'])
  })

  it('leaves the panel drawing bare cards it can never enrich', async () => {
    const worker = await growWith('broadcast-only')
    // Nothing is in flight, so no amount of waiting helps.
    expect(worker.pendingCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(worker.enriched()).toEqual(['lirik'])
  })

  it('recovers only when something unrelated triggers a fetch', async () => {
    const worker = await growWith('broadcast-only')
    // A friend's next heartbeat, forty-five seconds later.
    worker.wantMetadata()
    await settle()
    worker.drain()
    await settle()
    expect(worker.enriched()).toEqual(['lirik', 'teamliquid', 'timthetatman'])
  })

  /** And the same scenario with the shipped wiring needs no such rescue. */
  it('converges immediately with the wiring that ships', async () => {
    const worker = await growWith('enrich')
    worker.drain()
    await settle()
    expect(worker.enriched()).toEqual(['lirik', 'teamliquid', 'timthetatman'])
  })
})

// ------------------------------------------------------- ordering and failure

describe('however the responses arrive', () => {
  async function threeOpen() {
    const worker = createWorker({ destinations: THREE })
    worker.destinations.refresh()
    await settle()
    return worker
  }

  /**
   * Two streams opened one after the other, so the two requests are genuinely
   * separate and can land in either order - which is what actually happens
   * when somebody opens a tab, then another a few seconds later.
   */
  async function openedOneAtATime() {
    const worker = createWorker({ destinations: ONE })
    worker.destinations.refresh()
    await settle()
    worker.respond('lirik')
    await settle()

    worker.serve({ a: ['lirik', 'teamliquid'] })
    worker.destinations.schedule()
    await settle()

    worker.serve(THREE)
    worker.destinations.schedule()
    await settle()

    // One request open per newly-added channel.
    expect(worker.pendingCount()).toBe(2)
    return worker
  }

  it('converges when the second answers before the third', async () => {
    const worker = await openedOneAtATime()
    worker.respond('teamliquid')
    await settle()
    worker.respond('timthetatman')
    await settle()
    expect(worker.enriched()).toEqual(['lirik', 'teamliquid', 'timthetatman'])
  })

  it('converges when the third answers before the second', async () => {
    const worker = await openedOneAtATime()
    worker.respond('timthetatman')
    await settle()
    worker.respond('teamliquid')
    await settle()
    expect(worker.enriched()).toEqual(['lirik', 'teamliquid', 'timthetatman'])
  })

  /** A channel already being fetched must not be requested a second time. */
  it('does not duplicate a request that is already in flight', async () => {
    const worker = await openedOneAtATime()
    const before = worker.requested.length
    worker.wantMetadata()
    await settle()
    expect(worker.requested).toHaveLength(before)
  })

  it('converges when they answer together', async () => {
    const worker = await threeOpen()
    worker.drain()
    await settle()
    expect(worker.enriched()).toEqual(['lirik', 'teamliquid', 'timthetatman'])
  })

  /**
   * A failure writes nothing and clears nothing, so the next trigger tries
   * again. There is no retry timer, and deliberately so - a failing backend
   * must not become a request storm.
   */
  it('retries a failed request on the next trigger', async () => {
    const worker = await threeOpen()
    worker.failNext()
    await settle()
    expect(worker.enriched()).toEqual([])

    // Any later trigger - a presence event, a tab change, the alarm.
    worker.wantMetadata()
    await settle()
    expect(worker.pendingCount()).toBeGreaterThan(0)

    worker.drain()
    await settle()
    expect(worker.enriched()).toEqual(['lirik', 'teamliquid', 'timthetatman'])
  })

  /** A late answer for a destination nobody is on any more is simply cached. */
  it('does not break when a destination is removed mid-flight', async () => {
    const worker = await threeOpen()
    worker.serve(ONE)
    worker.destinations.schedule()
    await settle()

    // The request that was already open still lands.
    worker.drain()
    await settle()

    expect(worker.destinations.snapshot()).toEqual(ONE)
    // Nothing threw, and the cache is a cache - it may hold more than the map
    // shows, and the map is derived from destinations rather than from it.
    expect(worker.enriched()).toContain('lirik')
  })
})

// ------------------------------------------------- the store's own lifecycle

describe('the destinations store', () => {
  it('fires onChange only on a real change', async () => {
    const changes: number[] = []
    const store = createFriendDestinations({
      fetch: async () => ({ value: { a: ['lirik'] } }),
      onChange: () => changes.push(1),
      coalesceMs: 1_000,
    })

    store.refresh()
    await settle()
    store.refresh()
    await settle()

    expect(changes).toHaveLength(1)
  })

  it('coalesces a burst of triggers into one read', async () => {
    let reads = 0
    const store = createFriendDestinations({
      fetch: async () => {
        reads += 1
        return { value: {} }
      },
      onChange: () => {},
      coalesceMs: 1_000,
    })

    for (let index = 0; index < 10; index += 1) store.schedule()
    await settle()

    expect(reads).toBe(1)
  })

  /**
   * The staleness hole, and the reason it is worth a test of its own.
   *
   * A read used to be DROPPED when one was already in flight, so a change that
   * landed during a slow request was lost until some later unrelated event
   * asked again. That is half of "sometimes it just does not update".
   */
  it('does not drop a change that arrives during a read', async () => {
    let served: Record<string, string[]> = { a: ['lirik'] }
    // A holder rather than a bare let: TypeScript narrows a variable only
    // assigned inside a promise executor to never.
    const gate: { release: (() => void) | null } = { release: null }
    const seen: Array<Record<string, readonly string[]>> = []

    const store = createFriendDestinations({
      fetch: () =>
        new Promise((resolve) => {
          const value = served
          gate.release = () => resolve({ value })
        }),
      onChange: (destinations) => seen.push({ ...destinations }),
      coalesceMs: 1_000,
    })

    store.refresh()
    await settle()
    expect(store.pending()).toBe(true)

    // The set changes while the first read is still open.
    served = { a: ['lirik', 'teamliquid'] }
    store.refresh()

    gate.release?.()
    await settle()
    // The queued read runs, and its answer is the new one.
    gate.release?.()
    await settle()

    expect(seen.at(-1)).toEqual({ a: ['lirik', 'teamliquid'] })
  })

  it('reports an error without changing the set', async () => {
    const errors: string[] = []
    const store = createFriendDestinations({
      fetch: async () => ({ value: null, error: 'network down' }),
      onChange: () => {
        throw new Error('must not fire')
      },
      onError: (context) => errors.push(context),
      coalesceMs: 1_000,
    })

    store.refresh()
    await settle()

    expect(errors).toEqual(['presence.destinations'])
    expect(store.snapshot()).toEqual({})
  })

  it('forgets everything on clear', async () => {
    const store = createFriendDestinations({
      fetch: async () => ({ value: { a: ['lirik'] } }),
      onChange: () => {},
      coalesceMs: 1_000,
    })
    store.refresh()
    await settle()
    expect(store.snapshot()).toEqual({ a: ['lirik'] })

    store.clear()
    expect(store.snapshot()).toEqual({})
  })
})

// ------------------------------------------------- and it reaches the screen

describe('the panel draws the enriched cards once metadata lands', () => {
  function installWindow() {
    const storage: Record<string, string> = {}
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        innerWidth: 1600,
        innerHeight: 900,
        location: { pathname: '/somewhere_else', href: 'https://www.twitch.tv/somewhere_else' },
        localStorage: {
          getItem: (key: string) => storage[key] ?? null,
          setItem: (key: string, value: string) => {
            storage[key] = value
          },
          removeItem: (key: string) => {
            delete storage[key]
          },
        },
        addEventListener: () => {},
        removeEventListener: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        matchMedia: () => ({
          matches: false,
          addEventListener: () => {},
          removeEventListener: () => {},
        }),
      },
    })
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        querySelector: () => null,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    })
  }

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window')
    Reflect.deleteProperty(globalThis, 'document')
  })

  function render(state: Partial<KickbackState>) {
    installWindow()
    const merged: KickbackState = {
      ...INITIAL_STATE,
      status: 'signed_in',
      identity: {
        userId: 'observer',
        displayName: 'Observer',
        avatarUrl: null,
        twitchLogin: 'observer',
        friendCode: 'KB-TEST',
        presenceVisibility: 'visible',
      },
      ...state,
    }
    const client = {
      getState: () => merged,
      subscribe: (listener: (s: KickbackState) => void) => {
        listener(merged)
        return () => {}
      },
      reportActivity: () => {},
      markSeen: () => {},
      markKindSeen: () => {},
      markGroupRead: () => {},
      selectSession: () => {},
      track: () => {},
      recordJoin: () => {},
      reportExposure: () => {},
      searchEmotes: async () => [],
    } as unknown as KickbackClient
    return renderToStaticMarkup(<KickbackPanel client={client} />)
  }

  it('goes from two bare cards to three enriched ones', async () => {
    const worker = createWorker({ destinations: ONE })
    worker.destinations.refresh()
    await settle()
    worker.respond('lirik')
    await settle()

    worker.serve(THREE)
    worker.destinations.schedule()
    await settle()

    // Before the answers land: three cards, two of them plain.
    const during = render({
      friends: [FRIEND_A],
      friendDestinations: worker.destinations.snapshot(),
      channelMetadata: worker.metadata.snapshot(),
    })
    expect(during).toContain('LIRIK')
    expect(during).toContain('>teamliquid<')

    worker.drain()
    await settle()

    const after = render({
      friends: [FRIEND_A],
      friendDestinations: worker.destinations.snapshot(),
      channelMetadata: worker.metadata.snapshot(),
    })
    expect(after).toContain('LIRIK')
    expect(after).toContain('TeamLiquid')
    expect(after).toContain('TimTheTatman')
    expect(after).not.toContain('>teamliquid<')
  })
})

// ------------------------------------------------------------ harness pin

describe('the harness matches the worker', () => {
  const WORKER = readFileSync('src/background/index.ts', 'utf8')

  /**
   * THE FIX, pinned. A changed destination set must ask for enrichment before
   * it broadcasts, or the panel draws channels nobody has asked Twitch about -
   * which is the whole defect.
   */
  it('asks for metadata when the destination set changes', () => {
    const wiring = WORKER.slice(
      WORKER.indexOf('const friendDestinationsStore = createFriendDestinations('),
      WORKER.indexOf('function friendDestinationsSnapshot('),
    )
    expect(wiring).toContain('onChange: () => {')
    expect(wiring).toContain('wantMetadata()')
    expect(wiring).toContain('broadcast()')
  })

  it('derives the enrichment set from the destinations store', () => {
    expect(WORKER).toContain('friendDestinationsSnapshot()')
    expect(WORKER).toContain('gravityChannels(')
  })

  it('keeps the store as the only owner of the set', () => {
    // No stray module-level copy that could drift from the store.
    expect(WORKER).not.toContain('let friendDestinations: Record<string, string[]> = {}')
    expect(WORKER).not.toContain('let destinationsPending = false')
  })
})
