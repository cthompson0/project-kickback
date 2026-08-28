import { describe, expect, it, vi } from 'vitest'
import {
  RESUME_WINDOW_MS,
  isObservationLost,
  isPersistedLifecycle,
  reconcileLifecycle,
} from '../../src/background/togetherStore'
import type { PersistedLifecycle } from '../../src/background/togetherStore'
import { createPresenceReporter } from '../../src/background/presence'
import type { TogetherState } from '../../src/background/togetherWatch'

/**
 * The recovery policy, on its own.
 *
 * Everything here is a pure decision about a stored interval and the world we
 * woke up to, which is what makes it testable without a browser, a worker or a
 * clock. The hub only applies what this returns.
 *
 * The rule being defended throughout: we do not know what happened while
 * nothing was running, so we never credit that time as viewing. A restored
 * interval is resumed only when the world still looks the way we left it AND
 * the gap was short; otherwise it is closed at the last moment we could vouch
 * for.
 */

const NOW = 1_700_000_000_000

const state = (overrides: Partial<TogetherState> = {}): TogetherState => ({
  channel: 'summit1g',
  startedAt: NOW - 10 * 60 * 1000,
  otherCountPeak: 2,
  attributionId: 'attr-1',
  aloneSince: null,
  socialEndedAt: null,
  ...overrides,
})

const stored = (overrides: Partial<PersistedLifecycle> = {}): PersistedLifecycle => ({
  userId: 'user-a',
  sessionId: 'session-1',
  state: state(),
  lastSeenAt: NOW - 30_000,
  ...overrides,
})

describe('the staleness rule itself', () => {
  /*
   * One rule, two callers. Coming back from storage after a restart asks it,
   * and so does the tick that runs while a worker is still alive - because an
   * OS suspend freezes a worker without killing it, and a worker that woke up
   * with its state intact would otherwise have no reason to doubt any of it.
   *
   * Tested directly so the two callers cannot drift into asking slightly
   * different questions of the same constant.
   */
  it('accepts a gap up to and including the window', () => {
    expect(isObservationLost(NOW - RESUME_WINDOW_MS, NOW)).toBe(false)
    expect(isObservationLost(NOW - 1_000, NOW)).toBe(false)
    expect(isObservationLost(NOW, NOW)).toBe(false)
  })

  it('rejects anything past it', () => {
    expect(isObservationLost(NOW - RESUME_WINDOW_MS - 1, NOW)).toBe(true)
    expect(isObservationLost(NOW - 3 * 60 * 60 * 1000, NOW)).toBe(true)
  })

  it('takes a window, so callers can be tested without waiting minutes', () => {
    expect(isObservationLost(NOW - 2_000, NOW, 1_000)).toBe(true)
    expect(isObservationLost(NOW - 500, NOW, 1_000)).toBe(false)
  })

  it('is the same rule reconcileLifecycle applies', () => {
    // The boundary reconcile draws must be this function's boundary, not a
    // second copy of the comparison that happens to agree today.
    const atEdge = reconcileLifecycle(stored({ lastSeenAt: NOW - RESUME_WINDOW_MS }), {
      userId: 'user-a',
      channel: 'summit1g',
      now: NOW,
    })
    const pastEdge = reconcileLifecycle(stored({ lastSeenAt: NOW - RESUME_WINDOW_MS - 1 }), {
      userId: 'user-a',
      channel: 'summit1g',
      now: NOW,
    })
    expect(atEdge.action).toBe('resume')
    expect(pastEdge).toMatchObject({ action: 'close', reason: 'observation_lost' })
  })
})

describe('resuming an interval', () => {
  it('continues when the world is as we left it', () => {
    const decision = reconcileLifecycle(stored(), {
      userId: 'user-a',
      channel: 'summit1g',
      now: NOW,
    })
    expect(decision.action).toBe('resume')
  })

  it('continues right up to the edge of the window', () => {
    const decision = reconcileLifecycle(stored({ lastSeenAt: NOW - RESUME_WINDOW_MS }), {
      userId: 'user-a',
      channel: 'summit1g',
      now: NOW,
    })
    expect(decision.action).toBe('resume')
  })

  it('continues a post-social interval, not only a shared watch', () => {
    const decision = reconcileLifecycle(
      stored({ state: state({ aloneSince: NOW - 5 * 60_000, socialEndedAt: NOW - 5 * 60_000 }) }),
      { userId: 'user-a', channel: 'summit1g', now: NOW },
    )
    expect(decision.action).toBe('resume')
  })
})

describe('closing an interval we can no longer vouch for', () => {
  it('closes one that went quiet for longer than the window', () => {
    const lastSeenAt = NOW - 3 * 60 * 60 * 1000
    const decision = reconcileLifecycle(stored({ lastSeenAt }), {
      userId: 'user-a',
      channel: 'summit1g',
      now: NOW,
    })

    expect(decision).toMatchObject({
      action: 'close',
      // At the last moment we could vouch for - never at the moment we
      // noticed, which would credit the whole outage as viewing time.
      effectiveAt: lastSeenAt,
      reason: 'observation_lost',
    })
  })

  it('closes one whose channel changed while nothing was running', () => {
    const decision = reconcileLifecycle(stored(), {
      userId: 'user-a',
      channel: 'lirik',
      now: NOW,
    })
    expect(decision).toMatchObject({
      action: 'close',
      effectiveAt: NOW - 30_000,
      // They did leave; we just did not see when. The gap becomes detection lag.
      reason: 'left_channel',
    })
  })

  it('closes one where the user is now on no channel at all', () => {
    const decision = reconcileLifecycle(stored(), { userId: 'user-a', channel: null, now: NOW })
    expect(decision).toMatchObject({ action: 'close', reason: 'left_channel' })
  })

  it('prefers the honest reason when both are true', () => {
    /*
     * A laptop shut overnight and reopened on a different channel is both
     * stale AND moved. "observation_lost" is the truthful one: saying
     * `left_channel` would claim we knew they left, when all we know is that
     * we were not looking.
     */
    const decision = reconcileLifecycle(stored({ lastSeenAt: NOW - 5 * 60 * 60 * 1000 }), {
      userId: 'user-a',
      channel: 'lirik',
      now: NOW,
    })
    expect(decision).toMatchObject({ action: 'close', reason: 'observation_lost' })
  })
})

describe('intervals that must never be emitted', () => {
  it('discards one belonging to another account', () => {
    /*
     * The actor on every event is auth.uid() server-side, so emitting this
     * end now would file one person's viewing under another's name. Losing
     * the interval is the correct trade.
     */
    const decision = reconcileLifecycle(stored({ userId: 'user-a' }), {
      userId: 'user-b',
      channel: 'summit1g',
      now: NOW,
    })
    expect(decision).toEqual({ action: 'discard', why: 'other_account' })
  })

  it('discards when nobody is signed in', () => {
    const decision = reconcileLifecycle(stored(), { userId: null, channel: 'summit1g', now: NOW })
    expect(decision).toEqual({ action: 'discard', why: 'signed_out' })
  })

  it('has nothing to do when nothing is stored', () => {
    const decision = reconcileLifecycle(null, { userId: 'user-a', channel: 'summit1g', now: NOW })
    expect(decision).toEqual({ action: 'discard', why: 'nothing_stored' })
  })

  it('checks the account before anything else', () => {
    // A stale interval belonging to somebody else is discarded, not closed:
    // otherwise the staleness branch would emit it under the wrong actor.
    const decision = reconcileLifecycle(stored({ lastSeenAt: NOW - 5 * 60 * 60 * 1000 }), {
      userId: 'user-b',
      channel: 'summit1g',
      now: NOW,
    })
    expect(decision.action).toBe('discard')
  })
})

describe('what comes back out of storage', () => {
  it('accepts a well-formed interval', () => {
    expect(isPersistedLifecycle(stored())).toBe(true)
  })

  it('accepts one with the optional timestamps set', () => {
    expect(
      isPersistedLifecycle(
        stored({ state: state({ aloneSince: NOW, socialEndedAt: NOW }), sessionId: null }),
      ),
    ).toBe(true)
  })

  it('rejects anything it does not fully understand', () => {
    /*
     * Storage survives extension upgrades and is shared with everything else,
     * so what comes back is not guaranteed to be what this version wrote.
     * Anything that does not pass reads as absent, which fails closed: no
     * interval resumed, no end invented from a shape we cannot read.
     */
    const bad: unknown[] = [
      null,
      undefined,
      'nope',
      42,
      {},
      { userId: 'user-a' },
      stored({ userId: '' }),
      { ...stored(), userId: 7 },
      { ...stored(), lastSeenAt: 'soon' },
      { ...stored(), lastSeenAt: Number.NaN },
      { ...stored(), sessionId: 7 },
      { ...stored(), state: null },
      { ...stored(), state: { channel: 'summit1g' } },
      { ...stored(), state: { ...state(), channel: '' } },
      { ...stored(), state: { ...state(), startedAt: 'ages ago' } },
      { ...stored(), state: { ...state(), otherCountPeak: Number.POSITIVE_INFINITY } },
      { ...stored(), state: { ...state(), attributionId: 7 } },
      { ...stored(), state: { ...state(), aloneSince: 'later' } },
      { ...stored(), state: { ...state(), socialEndedAt: 'later' } },
    ]
    for (const value of bad) expect(isPersistedLifecycle(value)).toBe(false)
  })
})

describe('the liveness signal analytics depends on', () => {
  it('ticks on every presence heartbeat, before the write', async () => {
    /*
     * Without this, the stored interval's last-seen timestamp only moved when
     * somebody's presence CHANGED - so a quiet ten minutes of watching looked
     * exactly like ten minutes of the worker being dead, and a legitimate
     * resume was thrown away as stale.
     *
     * It is called before the backend write, and regardless of whether that
     * write succeeds: what it asserts is that the worker is running and the
     * user is online, which is true either way.
     */
    vi.useFakeTimers()
    try {
      const beats: number[] = []
      const reporter = createPresenceReporter({
        backend: {
          reportPresence: async () => ({ value: true as const }),
          reportDestinations: async () => ({ value: 1 }),
          heartbeat: async () => ({ value: null, error: 'backend down' }),
          reportOffline: async () => ({ value: true as const }),
        },
        debounceMs: 0,
        heartbeatMs: 45_000,
        onHeartbeat: () => beats.push(beats.length),
      })

      reporter.setActivity({ type: 'watching', platform: 'twitch', channel: 'summit1g' })
      // Let the debounced write resolve, so the heartbeat interval is running.
      await vi.advanceTimersByTimeAsync(1)

      await vi.advanceTimersByTimeAsync(45_000 * 3)
      expect(beats.length).toBe(3)
      reporter.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
