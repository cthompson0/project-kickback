import { describe, expect, it } from 'vitest'
import { createChannelDwell, isDwellState } from '../../src/background/channelDwell'
import type { DwellState } from '../../src/background/channelDwell'
import { reconcileLifecycle, isPersistedLifecycleOf } from '../../src/background/togetherStore'

/**
 * Observed viewing time, and the ways it could lie.
 *
 * WHAT THIS PROTECTS
 *
 * Every other number in Watchside's analytics can only be too SMALL - a lost
 * interval, a shared watch that never opened. Dwell is the first measurement
 * that could be too LARGE, and an inflated watch-time figure is the one kind
 * of error nobody can detect afterwards and the one most likely to end up in
 * front of a platform partner.
 *
 * So these tests are mostly about the ways it could over-count: two channels
 * at once, a background tab, a switch counted twice, a restart replaying an
 * interval, a laptop lid closed for three hours.
 */

function harness(start = 1_000_000) {
  let clock = start
  const dwell = createChannelDwell({ now: () => clock })
  return {
    dwell,
    at: () => clock,
    advance(ms: number) {
      clock += ms
      return clock
    },
  }
}

describe('one interval at a time', () => {
  /**
   * The focused-tab rule is structural, not checked.
   *
   * The machine is fed ONE channel - the primary destination from the activity
   * registry, which always prefers a visible tab - so there is nowhere to put
   * a second interval. This test states that as a property rather than
   * trusting the prose.
   */
  it('never holds more than one open interval', () => {
    const { dwell, advance } = harness()

    dwell.update({ channel: 'lirik', social: false })
    expect(dwell.current()?.channel).toBe('lirik')

    advance(60_000)
    dwell.update({ channel: 'shroud', social: false })

    // Not "both": the previous one closed to make room.
    expect(dwell.current()?.channel).toBe('shroud')
  })

  it('closes the old channel exactly once when focus moves, with no overlap', () => {
    const { dwell, advance } = harness()

    dwell.update({ channel: 'lirik', social: false })
    advance(60_000)
    const events = dwell.update({ channel: 'shroud', social: false })

    expect(events).toHaveLength(1)
    expect(events[0].channel).toBe('lirik')
    expect(events[0].durationMs).toBe(60_000)
    expect(events[0].reason).toBe('switched_channel')

    // The new interval starts where the old one ended - not before it.
    expect(dwell.current()?.startedAt).toBe(events[0].effectiveAt)
  })

  /**
   * The multiplication test.
   *
   * Three tabs open for ten minutes must be ten minutes of viewing, not
   * thirty. Because only the focused channel is ever fed in, the two
   * background channels contribute nothing at all - they never appear.
   */
  it('does not multiply watch time by the number of open tabs', () => {
    const { dwell, advance } = harness()

    // Ten minutes with lirik focused. shroud and xqc are open in the
    // background, so the registry never reports them as effective.
    dwell.update({ channel: 'lirik', social: false })
    for (let tick = 0; tick < 10; tick += 1) {
      advance(60_000)
      dwell.update({ channel: 'lirik', social: false })
    }

    const events = dwell.stop()
    expect(events).toHaveLength(1)
    expect(events[0].durationMs).toBe(600_000)
  })

  it('accrues nothing for a channel that is never focused', () => {
    const { dwell, advance } = harness()

    dwell.update({ channel: 'lirik', social: false })
    advance(300_000)
    const events = dwell.stop()

    // Only lirik is ever mentioned. A background channel produces no event at
    // all, which is the only correct amount.
    expect(events.map((event) => event.channel)).toEqual(['lirik'])
  })

  /** A→B→A returns two separate intervals, never one overlapping pair. */
  it('keeps switched intervals disjoint end to end', () => {
    const { dwell, advance } = harness()
    const emitted: Array<{ channel: string; start: number; end: number }> = []

    dwell.update({ channel: 'lirik', social: false })
    const firstStart = dwell.current()!.startedAt

    advance(30_000)
    for (const event of dwell.update({ channel: 'shroud', social: false })) {
      emitted.push({ channel: event.channel, start: firstStart, end: event.effectiveAt })
    }
    const secondStart = dwell.current()!.startedAt

    advance(30_000)
    for (const event of dwell.update({ channel: 'lirik', social: false })) {
      emitted.push({ channel: event.channel, start: secondStart, end: event.effectiveAt })
    }

    expect(emitted).toHaveLength(2)
    // The second begins exactly where the first ended. No overlap, no gap that
    // could be double-counted by a query summing durations.
    expect(emitted[1].start).toBe(emitted[0].end)
    const total = emitted.reduce((sum, span) => sum + (span.end - span.start), 0)
    expect(total).toBe(60_000)
  })
})

describe('the live-stream rule', () => {
  /**
   * A channel that is not live arrives as null, because liveWatchChannel()
   * already applied the same socialViewing.ts rule the shared watch uses.
   * There is deliberately no second definition of "watching" here to test.
   */
  it('accrues nothing while there is no eligible live channel', () => {
    const { dwell, advance } = harness()

    dwell.update({ channel: null, social: false })
    advance(600_000)
    const events = dwell.update({ channel: null, social: false })

    expect(events).toEqual([])
    expect(dwell.current()).toBeNull()
  })

  it('closes as left_channel when the stream stops being eligible', () => {
    const { dwell, advance } = harness()

    dwell.update({ channel: 'lirik', social: false })
    advance(120_000)
    // The stream ended, or metadata went cold, or every tab was backgrounded.
    // From here those are the same observation.
    const events = dwell.update({ channel: null, social: false })

    expect(events).toHaveLength(1)
    expect(events[0].reason).toBe('left_channel')
    expect(events[0].durationMs).toBe(120_000)
  })
})

describe('attribution', () => {
  it('marks from_join when a JOIN attribution covered the interval', () => {
    const { dwell, advance } = harness()

    dwell.attribute('attr-1')
    dwell.update({ channel: 'lirik', social: false })
    advance(60_000)
    const [event] = dwell.stop()

    expect(event.attributionId).toBe('attr-1')
  })

  it('leaves organic viewing unattributed', () => {
    const { dwell, advance } = harness()

    dwell.update({ channel: 'lirik', social: false })
    advance(60_000)
    const [event] = dwell.stop()

    expect(event.attributionId).toBeNull()
  })

  /**
   * The leak this rules out.
   *
   * An attribution belongs to the visit it caused. A later, unrelated visit to
   * a DIFFERENT channel must not inherit it - that would credit Watchside with
   * viewing it had nothing to do with.
   */
  it('does not leak an attribution into later unrelated viewing', () => {
    const { dwell, advance } = harness()

    dwell.attribute('attr-1')
    dwell.update({ channel: 'lirik', social: false })
    advance(60_000)

    // Straight on to another channel. Nothing re-attributed it.
    const [switched] = dwell.update({ channel: 'shroud', social: false })
    expect(switched.attributionId).toBe('attr-1')

    advance(60_000)
    const [second] = dwell.stop()
    expect(second.channel).toBe('shroud')
    expect(second.attributionId).toBeNull()
  })

  it('stops wanting an attribution once an interval is open', () => {
    const { dwell } = harness()

    expect(dwell.wantsAttribution()).toBe(true)
    dwell.update({ channel: 'lirik', social: false })
    expect(dwell.wantsAttribution()).toBe(false)
  })
})

describe('had_social', () => {
  it('is false for viewing nobody else was part of', () => {
    const { dwell, advance } = harness()

    dwell.update({ channel: 'lirik', social: false })
    advance(60_000)
    const [event] = dwell.stop()

    expect(event.hadSocial).toBe(false)
  })

  it('is true when a shared watch was open during the interval', () => {
    const { dwell, advance } = harness()

    dwell.update({ channel: 'lirik', social: false })
    advance(30_000)
    dwell.update({ channel: 'lirik', social: true })
    advance(30_000)
    const [event] = dwell.stop()

    expect(event.hadSocial).toBe(true)
  })

  /**
   * Sticky, and this is the case that makes it matter.
   *
   * A friend watches for two minutes and leaves; the viewer stays another
   * hour. Reading the flag at close time would report that hour as solo
   * viewing and lose the fact that it began socially - which is precisely the
   * post-social behaviour Watchside exists to demonstrate.
   */
  it('stays true after the shared watch ends', () => {
    const { dwell, advance } = harness()

    dwell.update({ channel: 'lirik', social: true })
    advance(120_000)
    dwell.update({ channel: 'lirik', social: false })
    advance(3_600_000)
    const [event] = dwell.stop()

    expect(event.hadSocial).toBe(true)
    expect(event.durationMs).toBe(3_720_000)
  })

  it('does not carry across to the next channel', () => {
    const { dwell, advance } = harness()

    dwell.update({ channel: 'lirik', social: true })
    advance(60_000)
    dwell.update({ channel: 'shroud', social: false })
    advance(60_000)
    const [event] = dwell.stop()

    expect(event.channel).toBe('shroud')
    expect(event.hadSocial).toBe(false)
  })
})

describe('end reasons', () => {
  it('reports session_ended when the session closes', () => {
    const { dwell, advance } = harness()

    dwell.update({ channel: 'lirik', social: false })
    advance(60_000)
    const [event] = dwell.stop()

    expect(event.reason).toBe('session_ended')
  })

  it('emits nothing when there was no open interval', () => {
    const { dwell } = harness()
    expect(dwell.stop()).toEqual([])
  })
})

describe('surviving a worker restart', () => {
  /**
   * The double-count this rules out.
   *
   * An MV3 worker is evicted at will. If a restored interval emitted anything,
   * or if the machine simply started a second one, a single evening would be
   * reported twice. Restoring emits nothing, and there is no start event to
   * replay.
   */
  it('restores without emitting anything', () => {
    const { dwell } = harness()
    const state: DwellState = {
      channel: 'lirik',
      startedAt: 500_000,
      hadSocial: true,
      attributionId: 'attr-1',
    }

    dwell.restore(state)
    expect(dwell.current()).toEqual(state)

    // Continuing on the same channel produces no event at all.
    expect(dwell.update({ channel: 'lirik', social: false })).toEqual([])
  })

  it('measures a restored interval from its original start, not the restart', () => {
    const { dwell, advance } = harness(1_000_000)

    dwell.restore({
      channel: 'lirik',
      startedAt: 940_000,
      hadSocial: false,
      attributionId: null,
    })
    advance(60_000)
    const [event] = dwell.stop()

    expect(event.durationMs).toBe(120_000)
  })

  /**
   * The three-hour lid.
   *
   * closeAt is how an observation gap is closed: at the last moment we could
   * vouch for, NOT at the moment we noticed. The gap becomes detection lag,
   * which is recorded, rather than watch time, which would be fiction.
   */
  it('closes a lost observation at the last vouched moment, not now', () => {
    const { dwell } = harness(1_000_000)
    const lastSeen = 700_000

    dwell.restore({
      channel: 'lirik',
      startedAt: 400_000,
      hadSocial: false,
      attributionId: null,
    })
    const [event] = dwell.closeAt('observation_lost', lastSeen, 1_000_000)

    expect(event.reason).toBe('observation_lost')
    expect(event.effectiveAt).toBe(lastSeen)
    expect(event.detectedAt).toBe(1_000_000)
    // 300s of vouched viewing. The 300s nobody was watching is not in it.
    expect(event.durationMs).toBe(300_000)
    expect(event.durationMs).toBeLessThan(1_000_000 - 400_000)
  })

  it('rejects a stored shape it does not understand, rather than guessing', () => {
    expect(isDwellState(null)).toBe(false)
    expect(isDwellState({})).toBe(false)
    expect(isDwellState({ channel: '', startedAt: 1, hadSocial: false, attributionId: null })).toBe(
      false,
    )
    expect(
      isDwellState({ channel: 'lirik', startedAt: 'soon', hadSocial: false, attributionId: null }),
    ).toBe(false)
    // hadSocial must be a real boolean - a missing flag must not read as false.
    expect(isDwellState({ channel: 'lirik', startedAt: 1, attributionId: null })).toBe(false)
    expect(
      isDwellState({ channel: 'lirik', startedAt: 1, hadSocial: true, attributionId: 'a' }),
    ).toBe(true)
  })
})

describe('the recovery policy is the shared one', () => {
  const state: DwellState = {
    channel: 'lirik',
    startedAt: 400_000,
    hadSocial: false,
    attributionId: null,
  }
  const stored = { userId: 'user-a', sessionId: 's1', state, lastSeenAt: 700_000 }

  /**
   * Dwell reuses reconcileLifecycle rather than restating it.
   *
   * The question after a restart - is this the world we left, and when did we
   * last honestly know anything - is identical for both intervals, and two
   * copies of that policy would be two chances to answer it differently.
   */
  it('resumes when the world is as we left it', () => {
    const decision = reconcileLifecycle(stored, {
      userId: 'user-a',
      channel: 'lirik',
      now: 720_000,
    })
    expect(decision.action).toBe('resume')
  })

  it('closes as observation_lost after a long gap', () => {
    const decision = reconcileLifecycle(stored, {
      userId: 'user-a',
      channel: 'lirik',
      now: 700_000 + 6 * 60 * 1000,
    })
    expect(decision.action).toBe('close')
    if (decision.action !== 'close') throw new Error('unreachable')
    expect(decision.reason).toBe('observation_lost')
    expect(decision.effectiveAt).toBe(700_000)
  })

  it('closes as left_channel when the user is somewhere else', () => {
    const decision = reconcileLifecycle(stored, {
      userId: 'user-a',
      channel: 'shroud',
      now: 720_000,
    })
    expect(decision.action).toBe('close')
    if (decision.action !== 'close') throw new Error('unreachable')
    expect(decision.reason).toBe('left_channel')
  })

  /** One person's viewing must never be filed under another's name. */
  it('discards another account’s interval without emitting it', () => {
    const decision = reconcileLifecycle(stored, {
      userId: 'user-b',
      channel: 'lirik',
      now: 720_000,
    })
    expect(decision.action).toBe('discard')
  })

  it('validates the stored envelope through the shared guard', () => {
    expect(isPersistedLifecycleOf(stored, isDwellState)).toBe(true)
    expect(isPersistedLifecycleOf({ ...stored, userId: '' }, isDwellState)).toBe(false)
    // A shared-watch interval must not pass as a dwell one.
    expect(
      isPersistedLifecycleOf(
        { ...stored, state: { channel: 'lirik', startedAt: 1, otherCountPeak: 2 } },
        isDwellState,
      ),
    ).toBe(false)
  })
})
