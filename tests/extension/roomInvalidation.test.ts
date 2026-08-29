import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStreamRoom } from '../../src/background/streamRoom'
import type { RoomMember } from '../../src/core/streamRoom'

/**
 * WS-F5-01: the room roster must follow an arrival, not wait out its cache.
 *
 * THE DEFECT THIS EXISTS FOR
 *
 * The two-actor Firefox E2E measured a friend JOINing the channel the viewer
 * was already watching. The viewer's HERE card lit up in 2.3 seconds and room
 * messages flowed both ways - while the ROSTER stayed empty for 122s, 132s and
 * over 150s across runs. Asking the server directly at the same moment returned
 * the arriving friend, so the SQL was right and the client was sitting on a
 * pre-arrival answer it had cached as fresh.
 *
 * The instrumented worker gave the reason in one line: co-presence invalidation
 * lived inside `indexPresence`, the REALTIME path, and that path had not run
 * (`calls: 2, sameObject: 2, completed: 0`). Three other places assigned
 * `presenceIndex` directly - the friends subscription, the groups subscription
 * and `watchPresence` - and none of them re-asked the room. The arrival reached
 * the client through the friends service, so every presence-derived surface
 * updated and the room was never told.
 *
 * WHY THE EXISTING PROTECTION DID NOT COVER IT
 *
 * `ask()` already guards an invalidation that races a request in the air, and
 * its comment describes this exact symptom. But that guard presumes an
 * invalidation HAPPENS. Here none did, so no downstream guard could have
 * helped - the trigger had three writers and only one of them fired it.
 *
 * TWO LAYERS, ON PURPOSE
 *
 * The structural test is the one that would actually have caught this: it fails
 * the moment anything assigns `presenceIndex` outside the single function that
 * also re-asks the room. The wiring is what broke, so the wiring is what is
 * pinned.
 *
 * The behavioural tests cover the service itself - that an invalidation
 * converges without waiting for the refresh interval, and that a retry cannot
 * have its in-flight flag cleared out from under it.
 */

// -------------------------------------------------------------- structural

const SOURCE = 'src/background/index.ts'

describe('presenceIndex has exactly one writer', () => {
  const source = readFileSync(SOURCE, 'utf8')

  /*
   * Assignments, not reads. `presenceIndex = ...` at the start of a statement
   * is the whole vocabulary for changing it, so counting those counts writers.
   */
  const assignments = source.match(/^\s*presenceIndex = /gm) ?? []

  it('is assigned in exactly one place', () => {
    /*
     * Before the fix there were four: indexPresence, friends.subscribe,
     * groups.subscribe and watchPresence - and three of them skipped the room.
     */
    expect(assignments).toHaveLength(1)
  })

  it('and that place is setPresenceIndex, which re-asks the room', () => {
    const start = source.indexOf('function setPresenceIndex(')
    expect(start).toBeGreaterThan(-1)

    const body = source.slice(start, source.indexOf('\n}\n', start))
    expect(body).toContain('presenceIndex = next')
    // The consequence, in the same statement sequence as the assignment.
    expect(body).toContain('room.invalidate()')
    expect(body).toContain('room.want(')
  })

  it('and every other presence writer goes through it', () => {
    /*
     * The three paths that used to assign directly. Naming them means deleting
     * one of these calls fails here rather than silently reopening WS-F5-01 for
     * that path only.
     */
    const calls = source.match(/setPresenceIndex\(/g) ?? []
    // The declaration, indexPresence, friends, groups, watchPresence.
    expect(calls.length).toBeGreaterThanOrEqual(5)

    for (const region of ['friends.subscribe(', 'groups.subscribe(', 'function watchPresence(']) {
      const at = source.indexOf(region)
      expect(at, `${region} should still exist`).toBeGreaterThan(-1)
      const block = source.slice(at, at + 900)
      expect(block, `${region} must not assign presenceIndex directly`).not.toMatch(
        /^\s*presenceIndex = /m,
      )
      expect(block, `${region} must adopt presence through setPresenceIndex`).toContain(
        'setPresenceIndex(',
      )
    }
  })
})

// ------------------------------------------------------------- behavioural

const CHANNEL = 'lirik'
const NOW = 1_700_000_000_000
const REFRESH = 90_000

const member = (userId: string): RoomMember => ({ userId, hops: 1, viaUserId: null })

/** A room service over a server whose answer, and its timing, we control. */
function harness() {
  let answer: RoomMember[] = []
  let waiting: Array<() => void> = []
  let calls = 0

  const room = createStreamRoom({
    backend: {
      async members() {
        calls += 1
        const at = answer
        await new Promise<void>((resolve) => waiting.push(resolve))
        return at.map((m) => ({ user_id: m.userId, hops: m.hops, via_user_id: m.viaUserId }))
      },
    },
    now: () => Date.now(),
  })

  return {
    room,
    calls: () => calls,
    setAnswer(next: RoomMember[]) {
      answer = next
    },
    async settle() {
      const release = waiting
      waiting = []
      for (const resolve of release) resolve()
      await vi.advanceTimersByTimeAsync(0)
    },
  }
}

describe('a room that was answered before the arrival', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('converges on invalidation rather than waiting out the cache', async () => {
    const h = harness()

    // The viewer is watching alone; the server agrees.
    h.room.want([CHANNEL])
    await h.settle()
    expect(h.room.snapshot(CHANNEL)).toEqual([])
    expect(h.calls()).toBe(1)

    // Without an invalidation the fresh answer stands, which is the cache
    // doing its job - a friend arriving must not cost a query per heartbeat.
    vi.setSystemTime(NOW + 30_000)
    h.room.want([CHANNEL])
    expect(h.calls()).toBe(1)

    // The friend arrives. This is what setPresenceIndex now does.
    h.setAnswer([member('friend')])
    h.room.invalidate()
    h.room.want([CHANNEL])
    await h.settle()

    expect(h.calls()).toBe(2)
    expect(h.room.snapshot(CHANNEL).map((m) => m.userId)).toEqual(['friend'])

    /*
     * And it happened WELL inside the refresh interval. Asserting the clock
     * rather than just the roster is what stops a future "fix" that merely
     * shortens the cache from passing: the point is that convergence is driven
     * by the event, not by the timer.
     */
    expect(Date.now() - NOW).toBeLessThan(REFRESH)
  })

  it('does not let a retry lose its in-flight flag to the request it replaced', async () => {
    const h = harness()

    h.room.want([CHANNEL])
    expect(h.room.pending(CHANNEL)).toBe(true)

    // The arrival lands while the first request is still in the air.
    h.setAnswer([member('friend')])
    h.room.invalidate()
    // Correctly skipped: something is already asking.
    h.room.want([CHANNEL])
    expect(h.calls()).toBe(1)

    // The stale answer returns, sees it was invalidated, and asks again.
    await h.settle()
    expect(h.calls()).toBe(2)

    /*
     * THE RACE THIS PINS.
     *
     * The retry used to be launched from inside the `try`, so the outer call's
     * `finally` ran afterwards and cleared the flag the retry had just set. A
     * `want()` at this moment then started a THIRD request, and whichever
     * answer landed last won - including the older, pre-arrival one, which
     * would stamp itself fresh and be cached for the full interval.
     */
    expect(h.room.pending(CHANNEL)).toBe(true)
    h.room.want([CHANNEL])
    expect(h.calls()).toBe(2)

    await h.settle()
    expect(h.room.snapshot(CHANNEL).map((m) => m.userId)).toEqual(['friend'])
    expect(h.room.pending(CHANNEL)).toBe(false)
  })

  it('reports its own clocks, so a stale answer is distinguishable from an empty room', async () => {
    /*
     * `inspect()` is what turned WS-F5-01 from "the room is slow" into a
     * one-line diagnosis: members beside the age of the answer that produced
     * them. A roster alone cannot tell "the server said nobody" from "nobody
     * has asked since before they arrived".
     */
    const h = harness()
    h.room.want([CHANNEL])
    await h.settle()

    vi.setSystemTime(NOW + 5_000)
    expect(h.room.inspect()[CHANNEL]).toEqual({
      members: 0,
      ageMs: 5_000,
      inFlight: false,
      invalidations: 0,
    })

    h.room.invalidate()
    expect(h.room.inspect()[CHANNEL]).toMatchObject({ ageMs: null, invalidations: 1 })
  })
})
