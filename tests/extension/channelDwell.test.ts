import { describe, expect, it } from 'vitest'
import {
  createChannelDwell,
  isDwellState,
  isPersistedDwell,
  reconcileDwell,
} from '../../src/background/channelDwell'
import type { DwellState, DwellStream } from '../../src/background/channelDwell'

/**
 * Observed stream dwell, and the ways it could lie.
 *
 * WHAT THIS PROTECTS
 *
 * M3C.1 replaced focused-tab-only dwell with per-stream dwell, which moves the
 * risk. The old design could only under-count; this one can over-count if
 * intervals leak into each other, or mis-report if the focus partition drifts.
 *
 * So these tests are about three things: that legitimate concurrent viewing is
 * MEASURED rather than discarded, that concurrent intervals stay strictly
 * isolated from one another (attribution and social especially), and that the
 * conservative boundaries which stop an abandoned tab accruing forever are
 * still exactly where they were.
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

/** A stream as the worker observes it. `social` defaults to false. */
const s = (channel: string, focused = false, social = false): DwellStream => ({
  channel,
  focused,
  social,
})

describe('background streams accrue', () => {
  /** The whole point of the M3C.1 correction. */
  it('accrues dwell for a live stream that is not focused', () => {
    const { dwell, advance } = harness()

    dwell.update({ streams: [s('lirik', false)] })
    advance(600_000)
    const events = dwell.update({ streams: [] })

    expect(events).toHaveLength(1)
    expect(events[0].channel).toBe('lirik')
    expect(events[0].durationMs).toBe(600_000)
    // All of it background, none focused.
    expect(events[0].focusedMs).toBe(0)
    expect(events[0].backgroundMs).toBe(600_000)
  })

  it('accrues dwell for a focused stream', () => {
    const { dwell, advance } = harness()

    dwell.update({ streams: [s('lirik', true)] })
    advance(600_000)
    const [event] = dwell.update({ streams: [] })

    expect(event.durationMs).toBe(600_000)
    expect(event.focusedMs).toBe(600_000)
    expect(event.backgroundMs).toBe(0)
  })

  /**
   * Focus is a dimension, not a gate.
   *
   * Losing focus must not end the interval - the viewer may have moved the
   * stream to a second monitor, or be reading something else with it running.
   */
  it('does not end an interval when focus is lost', () => {
    const { dwell, advance } = harness()

    dwell.update({ streams: [s('lirik', true)] })
    advance(60_000)
    const events = dwell.update({ streams: [s('lirik', false)] })

    expect(events).toEqual([])
    expect(dwell.currentFor('lirik')).not.toBeNull()
  })

  /** Nor may regaining focus start a second interval for the same stream. */
  it('does not duplicate an interval when focus returns', () => {
    const { dwell, advance } = harness()

    dwell.update({ streams: [s('lirik', true)] })
    const startedAt = dwell.currentFor('lirik')!.startedAt

    advance(60_000)
    dwell.update({ streams: [s('lirik', false)] })
    advance(60_000)
    const events = dwell.update({ streams: [s('lirik', true)] })

    expect(events).toEqual([])
    expect(dwell.current()).toHaveLength(1)
    expect(dwell.currentFor('lirik')!.startedAt).toBe(startedAt)
  })
})

describe('the focus partition', () => {
  /**
   * The invariant the contract promises:
   *
   *   focused_duration_ms + background_duration_ms === duration_ms
   *
   * exactly, not approximately.
   */
  it('splits the duration exactly across several focus changes', () => {
    const { dwell, advance } = harness()

    dwell.update({ streams: [s('lirik', true)] }) // focused
    advance(30_000)
    dwell.update({ streams: [s('lirik', false)] }) // background
    advance(45_000)
    dwell.update({ streams: [s('lirik', true)] }) // focused again
    advance(25_000)
    const [event] = dwell.update({ streams: [] })

    expect(event.durationMs).toBe(100_000)
    expect(event.focusedMs).toBe(55_000)
    expect(event.backgroundMs).toBe(45_000)
    expect(event.focusedMs + event.backgroundMs).toBe(event.durationMs)
  })

  it('holds the invariant when the interval opens unfocused and stays so', () => {
    const { dwell, advance } = harness()

    dwell.update({ streams: [s('lirik', false)] })
    advance(120_000)
    const [event] = dwell.update({ streams: [] })

    expect(event.focusedMs + event.backgroundMs).toBe(event.durationMs)
    expect(event.focusedMs).toBe(0)
  })

  /**
   * A retroactive close cannot report more focused time than the interval had.
   *
   * The case that makes this real: an interval carries focus time banked
   * before a worker died, and is then closed at the last moment we could vouch
   * for - which may be EARLIER than the banked total. Without a clamp the
   * event would claim more focused milliseconds than duration, and
   * `background_duration_ms` would go negative and silently poison every sum
   * built on it.
   */
  it('never reports more focused time than duration when closed retroactively', () => {
    const { dwell } = harness(2_000_000)

    dwell.restore([
      {
        channel: 'lirik',
        startedAt: 1_000_000,
        // Ten minutes of focus banked before the worker died...
        focusedMs: 600_000,
        focusedSince: null,
        hadSocial: false,
        attributionId: null,
      },
    ])

    // ...but we can only vouch for 100 seconds of the interval.
    const [event] = dwell.closeAt(['lirik'], 'observation_lost', 1_100_000, 2_000_000)

    expect(event.durationMs).toBe(100_000)
    expect(event.focusedMs).toBe(100_000)
    expect(event.backgroundMs).toBe(0)
    expect(event.backgroundMs).toBeGreaterThanOrEqual(0)
    expect(event.focusedMs + event.backgroundMs).toBe(event.durationMs)
  })

  /** And the same clamp when the focus run is still open past the effective end. */
  it('does not bank focus time from after the effective end', () => {
    const { dwell, advance } = harness(1_000_000)

    dwell.update({ streams: [s('lirik', true)] })
    advance(600_000)

    const [event] = dwell.closeAt(['lirik'], 'observation_lost', 1_120_000, 1_600_000)

    expect(event.durationMs).toBe(120_000)
    expect(event.focusedMs).toBeLessThanOrEqual(event.durationMs)
    expect(event.focusedMs + event.backgroundMs).toBe(event.durationMs)
  })
})

describe('concurrent streams', () => {
  /** Two legitimately open streams are two stream-hours and one wall-clock hour. */
  it('lets two streams accrue at the same time', () => {
    const { dwell, advance } = harness()

    dwell.update({ streams: [s('lirik', true), s('shroud', false)] })
    advance(3_600_000)
    const events = dwell.update({ streams: [] })

    expect(events).toHaveLength(2)
    const byChannel = Object.fromEntries(events.map((event) => [event.channel, event]))
    expect(byChannel.lirik.durationMs).toBe(3_600_000)
    expect(byChannel.shroud.durationMs).toBe(3_600_000)

    // 120 stream-minutes. NOT 120 wall-clock minutes - see ANALYTICS.md §14.
    const streamMinutes = events.reduce((sum, event) => sum + event.durationMs, 0)
    expect(streamMinutes).toBe(7_200_000)

    // And the focus partition still describes one viewer's attention.
    expect(byChannel.lirik.focusedMs).toBe(3_600_000)
    expect(byChannel.shroud.focusedMs).toBe(0)
  })

  it('keeps concurrent intervals separate per destination', () => {
    const { dwell, advance } = harness()

    dwell.update({ streams: [s('lirik')] })
    advance(60_000)
    dwell.update({ streams: [s('lirik'), s('shroud')] })
    advance(60_000)
    const events = dwell.update({ streams: [] })

    const byChannel = Object.fromEntries(events.map((event) => [event.channel, event]))
    // Each measures its own life, not a shared one.
    expect(byChannel.lirik.durationMs).toBe(120_000)
    expect(byChannel.shroud.durationMs).toBe(60_000)
  })

  it('closing one stream does not close another', () => {
    const { dwell, advance } = harness()

    dwell.update({ streams: [s('lirik'), s('shroud')] })
    advance(60_000)
    const events = dwell.update({ streams: [s('shroud')] })

    expect(events).toHaveLength(1)
    expect(events[0].channel).toBe('lirik')
    expect(dwell.currentFor('shroud')).not.toBeNull()
    expect(dwell.currentFor('lirik')).toBeNull()
  })

  it('navigating one tab closes only the affected interval', () => {
    const { dwell, advance } = harness()

    dwell.update({ streams: [s('lirik', true), s('shroud')] })
    advance(60_000)
    // The focused tab navigated from lirik to xqc; shroud is untouched.
    const events = dwell.update({ streams: [s('xqc', true), s('shroud')] })

    expect(events).toHaveLength(1)
    expect(events[0].channel).toBe('lirik')
    expect(events[0].reason).toBe('left_channel')
    expect(dwell.current().map((state) => state.channel).sort()).toEqual(['shroud', 'xqc'])
  })
})

describe('attribution isolation', () => {
  it('attributes only the stream the JOIN led to', () => {
    const { dwell, advance } = harness()

    dwell.attribute('lirik', 'attr-1')
    dwell.update({ streams: [s('lirik', true), s('shroud')] })
    advance(60_000)
    const events = dwell.update({ streams: [] })

    const byChannel = Object.fromEntries(events.map((event) => [event.channel, event]))
    expect(byChannel.lirik.attributionId).toBe('attr-1')
    // The concurrently open stream must not inherit it.
    expect(byChannel.shroud.attributionId).toBeNull()
  })

  it('does not let a later stream pick up an earlier attribution', () => {
    const { dwell, advance } = harness()

    dwell.attribute('lirik', 'attr-1')
    dwell.update({ streams: [s('lirik')] })
    advance(60_000)
    dwell.update({ streams: [s('lirik'), s('shroud')] })
    advance(60_000)
    const events = dwell.update({ streams: [] })

    const byChannel = Object.fromEntries(events.map((event) => [event.channel, event]))
    expect(byChannel.lirik.attributionId).toBe('attr-1')
    expect(byChannel.shroud.attributionId).toBeNull()
  })

  it('reports which channels still want an attribution', () => {
    const { dwell } = harness()

    expect(dwell.wantsAttribution('lirik')).toBe(true)
    dwell.update({ streams: [s('lirik')] })
    expect(dwell.wantsAttribution('lirik')).toBe(false)
    expect(dwell.wantsAttribution('shroud')).toBe(true)
  })
})

describe('had_social isolation', () => {
  it('marks only the stream the shared watch was open on', () => {
    const { dwell, advance } = harness()

    dwell.update({ streams: [s('lirik', true, true), s('shroud', false, false)] })
    advance(60_000)
    const events = dwell.update({ streams: [] })

    const byChannel = Object.fromEntries(events.map((event) => [event.channel, event]))
    expect(byChannel.lirik.hadSocial).toBe(true)
    expect(byChannel.shroud.hadSocial).toBe(false)
  })

  /**
   * Sticky per interval, and the case that makes it matter: a friend watches
   * for two minutes and leaves; the viewer stays another hour. Reading the flag
   * at close time would lose the fact that the visit began socially.
   */
  it('stays true for that stream after the shared watch ends', () => {
    const { dwell, advance } = harness()

    dwell.update({ streams: [s('lirik', true, true)] })
    advance(120_000)
    dwell.update({ streams: [s('lirik', true, false)] })
    advance(3_600_000)
    const [event] = dwell.update({ streams: [] })

    expect(event.hadSocial).toBe(true)
  })

  it('does not spread to a stream that never had one', () => {
    const { dwell, advance } = harness()

    dwell.update({ streams: [s('lirik', true, true), s('shroud')] })
    advance(60_000)
    // The shared watch moves; shroud still never had one.
    dwell.update({ streams: [s('lirik', false, false), s('shroud', true, false)] })
    advance(60_000)
    const events = dwell.update({ streams: [] })

    const byChannel = Object.fromEntries(events.map((event) => [event.channel, event]))
    expect(byChannel.lirik.hadSocial).toBe(true)
    expect(byChannel.shroud.hadSocial).toBe(false)
  })
})

describe('conservative boundaries are unchanged', () => {
  it('accrues nothing while no stream is eligible', () => {
    const { dwell, advance } = harness()

    dwell.update({ streams: [] })
    advance(600_000)
    const events = dwell.update({ streams: [] })

    expect(events).toEqual([])
    expect(dwell.current()).toEqual([])
  })

  /**
   * An offline stream is not eligible, so it never reaches this machine - the
   * caller applies the same socialViewing.ts rule the shared watch uses. What
   * this asserts is the consequence: the interval ends, and it ends with the
   * reason that says the stream stopped rather than the viewer leaving.
   */
  it('closes as stream_ended when a still-open stream stops being live', () => {
    const { dwell, advance } = harness()

    dwell.update({ streams: [s('lirik', true)] })
    advance(120_000)
    const events = dwell.update({
      streams: [],
      reasonFor: () => 'stream_ended',
    })

    expect(events).toHaveLength(1)
    expect(events[0].reason).toBe('stream_ended')
    expect(events[0].durationMs).toBe(120_000)
  })

  it('closes everything when the session ends', () => {
    const { dwell, advance } = harness()

    dwell.update({ streams: [s('lirik'), s('shroud')] })
    advance(60_000)
    const events = dwell.stop()

    expect(events).toHaveLength(2)
    for (const event of events) expect(event.reason).toBe('session_ended')
    expect(dwell.current()).toEqual([])
  })

  /**
   * The closed laptop. An unobserved gap is detection lag, never viewing.
   */
  it('closes a lost observation at the last vouched moment, not now', () => {
    const { dwell } = harness(1_000_000)

    dwell.restore([
      {
        channel: 'lirik',
        startedAt: 400_000,
        focusedMs: 0,
        focusedSince: null,
        hadSocial: false,
        attributionId: null,
      },
    ])
    const [event] = dwell.closeAllAt('observation_lost', 700_000, 1_000_000)

    expect(event.reason).toBe('observation_lost')
    expect(event.effectiveAt).toBe(700_000)
    expect(event.detectedAt).toBe(1_000_000)
    // 300s vouched. The 300s nobody was watching is not in it.
    expect(event.durationMs).toBe(300_000)
    expect(event.durationMs).toBeLessThan(1_000_000 - 400_000)
  })
})

describe('surviving a worker restart', () => {
  const open = (channel: string, startedAt: number): DwellState => ({
    channel,
    startedAt,
    focusedMs: 0,
    focusedSince: null,
    hadSocial: false,
    attributionId: null,
  })

  it('restores without emitting anything', () => {
    const { dwell } = harness()

    dwell.restore([open('lirik', 500_000), open('shroud', 600_000)])
    expect(dwell.current()).toHaveLength(2)

    // Continuing on the same streams produces no event at all.
    expect(dwell.update({ streams: [s('lirik'), s('shroud')] })).toEqual([])
  })

  it('measures a restored interval from its original start', () => {
    const { dwell, advance } = harness(1_000_000)

    dwell.restore([open('lirik', 940_000)])
    advance(60_000)
    const [event] = dwell.stop()

    expect(event.durationMs).toBe(120_000)
  })

  it('cannot duplicate an interval across a restart', () => {
    const { dwell, advance } = harness(1_000_000)

    dwell.restore([open('lirik', 940_000)])
    dwell.update({ streams: [s('lirik')] })
    advance(60_000)
    dwell.update({ streams: [s('lirik')] })
    const events = dwell.stop()

    expect(events).toHaveLength(1)
    expect(dwell.current()).toEqual([])
  })

  it('rejects a stored shape it does not understand, rather than guessing', () => {
    expect(isDwellState(null)).toBe(false)
    expect(isDwellState({})).toBe(false)
    expect(isDwellState({ ...open('lirik', 1), channel: '' })).toBe(false)
    // The focus fields must be real, or a missing partition would read as zero.
    expect(isDwellState({ channel: 'lirik', startedAt: 1, hadSocial: false, attributionId: null }))
      .toBe(false)
    expect(isDwellState(open('lirik', 1))).toBe(true)

    const stored = { userId: 'user-a', sessionId: 's1', states: [open('lirik', 1)], lastSeenAt: 2 }
    expect(isPersistedDwell(stored)).toBe(true)
    expect(isPersistedDwell({ ...stored, userId: '' })).toBe(false)
    expect(isPersistedDwell({ ...stored, states: [{ channel: 'lirik' }] })).toBe(false)
    // The single-interval shape the previous version stored must not pass.
    expect(isPersistedDwell({ userId: 'a', sessionId: null, state: open('lirik', 1), lastSeenAt: 2 }))
      .toBe(false)
  })
})

describe('the set recovery policy', () => {
  const open = (channel: string): DwellState => ({
    channel,
    startedAt: 400_000,
    focusedMs: 0,
    focusedSince: null,
    hadSocial: false,
    attributionId: null,
  })
  const stored = {
    userId: 'user-a',
    sessionId: 's1',
    states: [open('lirik'), open('shroud')],
    lastSeenAt: 700_000,
  }

  /** A restart usually finds part of the world intact and part of it gone. */
  it('resumes what is still observed and closes what is not', () => {
    const decision = reconcileDwell(stored, {
      userId: 'user-a',
      channels: ['lirik'],
      now: 720_000,
    })

    expect(decision.action).toBe('apply')
    if (decision.action !== 'apply') throw new Error('unreachable')
    expect(decision.resume.map((state) => state.channel)).toEqual(['lirik'])
    expect(decision.close.map((state) => state.channel)).toEqual(['shroud'])
    expect(decision.reason).toBe('left_channel')
    expect(decision.effectiveAt).toBe(700_000)
  })

  it('closes everything after a long gap, as observation_lost', () => {
    const decision = reconcileDwell(stored, {
      userId: 'user-a',
      channels: ['lirik', 'shroud'],
      now: 700_000 + 6 * 60 * 1000,
    })

    expect(decision.action).toBe('apply')
    if (decision.action !== 'apply') throw new Error('unreachable')
    expect(decision.resume).toEqual([])
    expect(decision.close).toHaveLength(2)
    expect(decision.reason).toBe('observation_lost')
    expect(decision.effectiveAt).toBe(700_000)
  })

  /** One person's viewing must never be filed under another's name. */
  it('discards another account’s intervals without emitting them', () => {
    const decision = reconcileDwell(stored, {
      userId: 'user-b',
      channels: ['lirik'],
      now: 720_000,
    })
    expect(decision.action).toBe('discard')
  })

  it('discards when nobody is signed in, and when nothing is stored', () => {
    expect(
      reconcileDwell(stored, { userId: null, channels: [], now: 720_000 }).action,
    ).toBe('discard')
    expect(reconcileDwell(null, { userId: 'user-a', channels: [], now: 720_000 }).action).toBe(
      'discard',
    )
  })
})

describe('intervals can be reconstructed for concurrency analysis', () => {
  /**
   * The event is dated to the effective end and carries the duration, so
   *
   *   started_at = occurred_at - duration_ms
   *
   * exactly. That is what lets SQL compute wall-clock union and concurrent
   * stream-minutes without any additional telemetry - see
   * supabase/migrations/0031_m3c_stream_dwell.sql.
   */
  it('emits enough to recover start and end for overlapping streams', () => {
    const { dwell, advance } = harness(1_000_000)

    dwell.update({ streams: [s('lirik', true)] })
    advance(60_000)
    dwell.update({ streams: [s('lirik', true), s('shroud')] })
    advance(60_000)
    const events = dwell.update({ streams: [] })

    const spans = events.map((event) => ({
      channel: event.channel,
      start: event.effectiveAt - event.durationMs,
      end: event.effectiveAt,
    }))
    const byChannel = Object.fromEntries(spans.map((span) => [span.channel, span]))

    expect(byChannel.lirik).toEqual({ channel: 'lirik', start: 1_000_000, end: 1_120_000 })
    expect(byChannel.shroud).toEqual({ channel: 'shroud', start: 1_060_000, end: 1_120_000 })

    // Stream-minutes sum; wall-clock is the union and is strictly smaller.
    const streamMs = spans.reduce((sum, span) => sum + (span.end - span.start), 0)
    const unionMs =
      Math.max(...spans.map((span) => span.end)) - Math.min(...spans.map((span) => span.start))
    expect(streamMs).toBe(180_000)
    expect(unionMs).toBe(120_000)
    expect(unionMs).toBeLessThan(streamMs)
  })
})
