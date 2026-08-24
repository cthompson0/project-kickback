import { describe, expect, it } from 'vitest'
import {
  SESSION_IDLE_MS,
  createAnalyticsSession,
  hasExpired,
  sessionDuration,
} from '../../src/background/analyticsSession'
import type { SessionRecord } from '../../src/background/analyticsSession'
import {
  createStoredValue,
  isJoinAttribution,
  isSessionRecord,
} from '../../src/background/storedValue'

/**
 * A session has to survive the service worker being killed, which is the whole
 * reason it is stored rather than remembered. These tests kill it repeatedly.
 */

function harness(startAt = 1_700_000_000_000) {
  let clock = startAt
  let ids = 0
  const cell: { value: SessionRecord | null } = { value: null }

  const make = () =>
    createAnalyticsSession({
      store: {
        read: async () => cell.value,
        write: async (record) => {
          cell.value = record
        },
      },
      now: () => clock,
      newId: () => `session-${++ids}`,
    })

  return {
    make,
    /** A new instance reading the same storage: what a worker restart is. */
    restart: make,
    advance: (ms: number) => {
      clock += ms
    },
    stored: () => cell.value,
  }
}

describe('opening a session', () => {
  it('starts one on the first sign of life', async () => {
    const h = harness()
    const outcome = await h.make().touch()

    expect(outcome.resumed).toBe(false)
    expect(outcome.expired).toBeNull()
    expect(h.stored()?.id).toBe('session-1')
  })

  it('keeps the same one while the user is still around', async () => {
    const h = harness()
    const session = h.make()
    await session.touch()

    h.advance(10 * 60 * 1000)
    const outcome = await session.touch()

    expect(outcome.resumed).toBe(true)
    expect(outcome.current.id).toBe('session-1')
  })
})

describe('surviving the worker being killed', () => {
  it('resumes the stored session rather than starting a new one', async () => {
    const h = harness()
    await h.make().touch()

    // The worker is torn down after ~30s idle; a new one wakes with no memory.
    h.advance(60 * 1000)
    const outcome = await h.restart().touch()

    expect(outcome.resumed).toBe(true)
    expect(outcome.current.id).toBe('session-1')
    expect(outcome.expired).toBeNull()
  })

  it('starts a new one once the idle window has passed', async () => {
    const h = harness()
    await h.make().touch()

    h.advance(SESSION_IDLE_MS + 1)
    const outcome = await h.restart().touch()

    expect(outcome.resumed).toBe(false)
    expect(outcome.current.id).toBe('session-2')
  })

  it('hands back the expired session so its end can be recorded', async () => {
    const h = harness()
    await h.make().touch()
    const startedAt = h.stored()!.startedAt

    h.advance(20 * 60 * 1000)
    await h.restart().touch() // still inside the window; extends it
    const lastActive = h.stored()!.lastActiveAt

    h.advance(SESSION_IDLE_MS + 1)
    const outcome = await h.restart().touch()

    expect(outcome.expired?.id).toBe('session-1')
    // Ends when it was last active, NOT when it was noticed - otherwise every
    // overnight gap becomes a session lasting until morning.
    expect(outcome.expired?.lastActiveAt).toBe(lastActive)
    expect(sessionDuration(outcome.expired!)).toBe(lastActive - startedAt)
  })
})

describe('closing a session deliberately', () => {
  it('returns what was closed and leaves nothing behind', async () => {
    const h = harness()
    const session = h.make()
    await session.touch()

    const closed = await session.close()
    expect(closed?.id).toBe('session-1')
    expect(h.stored()).toBeNull()
    expect(session.currentId()).toBeNull()
  })

  it('makes the next touch a new session', async () => {
    const h = harness()
    const session = h.make()
    await session.touch()
    await session.close()

    const outcome = await session.touch()
    expect(outcome.resumed).toBe(false)
    expect(outcome.current.id).toBe('session-2')
  })
})

describe('expiry', () => {
  const record: SessionRecord = { id: 's', startedAt: 0, lastActiveAt: 1_000 }

  it('is measured from the last sign of life', () => {
    expect(hasExpired(record, 1_000 + SESSION_IDLE_MS - 1)).toBe(false)
    expect(hasExpired(record, 1_000 + SESSION_IDLE_MS)).toBe(true)
  })
})

describe('what comes back out of storage', () => {
  const area = (value: unknown) => ({
    get: async () => ({ 'k': value }),
    set: async () => {},
    remove: async () => {},
  })

  it('reads a valid record', async () => {
    const stored = { id: 's', startedAt: 1, lastActiveAt: 2 }
    const value = createStoredValue(area(stored), 'k', isSessionRecord)
    expect(await value.read()).toEqual(stored)
  })

  it('treats a malformed record as absent', async () => {
    // Storage outlives upgrades and is shared with everything else, so what
    // comes back is not guaranteed to be what this version wrote.
    for (const bad of [null, 'nope', 42, {}, { id: 's' }, { id: 1, startedAt: 1, lastActiveAt: 2 }]) {
      const value = createStoredValue(area(bad), 'k', isSessionRecord)
      expect(await value.read()).toBeNull()
    }
  })

  it('treats storage being unavailable as absent rather than an error', async () => {
    const value = createStoredValue(
      {
        get: async () => {
          throw new Error('storage gone')
        },
        set: async () => {},
        remove: async () => {},
      },
      'k',
      isSessionRecord,
    )
    await expect(value.read()).resolves.toBeNull()
  })

  it('validates a stored attribution the same way', async () => {
    const good = {
      id: 'a',
      channel: 'lirik',
      source: 'friend_row',
      sessionId: null,
      clickedAt: 1,
      state: 'pending',
      arrivedAt: null,
    }
    expect(await createStoredValue(area(good), 'k', isJoinAttribution).read()).toEqual(good)
    expect(
      await createStoredValue(area({ ...good, state: 'weird' }), 'k', isJoinAttribution).read(),
    ).toBeNull()
  })
})
