import { describe, expect, it } from 'vitest'
import {
  EXPOSURE_ABSENCE_MS,
  EXPOSURE_WINDOW_MS,
  createExposureTracker,
  friendPresenceKey,
  gatheringKey,
} from '../../src/background/exposure'
import {
  TOGETHER_END_GRACE_MS,
  createTogetherWatch,
} from '../../src/background/togetherWatch'

/**
 * Two measurements the Social Gravity comparison will stand on: how often
 * social information was actually shown, and how long people actually watched
 * together. Both are easy to inflate, so both are tested for over-counting as
 * hard as for under-counting.
 */

function clock(startAt = 1_700_000_000_000) {
  let value = startAt
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms
    },
  }
}

// ------------------------------------------------------------------ exposure

describe('impressions are not counted per render', () => {
  it('emits once when something becomes visible', () => {
    const time = clock()
    const tracker = createExposureTracker({ now: time.now })
    const key = friendPresenceKey('nina', 'lirik')

    expect(tracker.observe([key])).toEqual([key])
  })

  it('stays silent while it goes on being visible', () => {
    const time = clock()
    const tracker = createExposureTracker({ now: time.now })
    const key = friendPresenceKey('nina', 'lirik')

    tracker.observe([key])
    // A realtime presence update re-renders the list fifty times. That is one
    // glance, not fifty exposures.
    for (let index = 0; index < 50; index += 1) {
      time.advance(200)
      expect(tracker.observe([key])).toEqual([])
    }
  })

  it('emits again after the window, for a panel left open all evening', () => {
    const time = clock()
    const tracker = createExposureTracker({ now: time.now })
    const key = gatheringKey('lirik')

    tracker.observe([key])
    time.advance(EXPOSURE_WINDOW_MS - 1)
    expect(tracker.observe([key])).toEqual([])

    time.advance(2)
    expect(tracker.observe([key])).toEqual([key])
  })
})

describe('disappearing and coming back', () => {
  it('is a new exposure when it was properly gone', () => {
    const time = clock()
    const tracker = createExposureTracker({ now: time.now })
    const key = friendPresenceKey('nina', 'lirik')

    tracker.observe([key])
    tracker.observe([])
    time.advance(EXPOSURE_ABSENCE_MS + 1)

    // Nina left and came back. Being shown that again is a real second chance.
    expect(tracker.observe([key])).toEqual([key])
  })

  it('is not a new exposure for a blink', () => {
    const time = clock()
    const tracker = createExposureTracker({ now: time.now })
    const key = friendPresenceKey('nina', 'lirik')

    tracker.observe([key])
    tracker.observe([]) // a re-render, a tab switch, a presence flap
    time.advance(1_000)
    expect(tracker.observe([key])).toEqual([])
  })

  it('treats the panel closing as everything going away', () => {
    const time = clock()
    const tracker = createExposureTracker({ now: time.now })
    const key = friendPresenceKey('nina', 'lirik')

    tracker.observe([key])
    tracker.hideAll()
    time.advance(EXPOSURE_ABSENCE_MS + 1)
    expect(tracker.observe([key])).toEqual([key])
  })
})

describe('what counts as the same opportunity', () => {
  it('a friend moving channel is a different one', () => {
    const time = clock()
    const tracker = createExposureTracker({ now: time.now })

    expect(tracker.observe([friendPresenceKey('nina', 'lirik')])).toHaveLength(1)
    expect(tracker.observe([friendPresenceKey('nina', 'xqc')])).toEqual([
      friendPresenceKey('nina', 'xqc'),
    ])
  })

  it('a gathering growing is the same one', () => {
    const time = clock()
    const tracker = createExposureTracker({ now: time.now })

    // Two friends, then six. One gathering, one impression - the count is
    // recorded as a property, not baked into the identity.
    expect(tracker.observe([gatheringKey('lirik')])).toHaveLength(1)
    time.advance(30_000)
    expect(tracker.observe([gatheringKey('lirik')])).toEqual([])
  })

  it('does not grow without bound', () => {
    const time = clock()
    const tracker = createExposureTracker({ now: time.now, maxKeys: 10 })

    for (let index = 0; index < 200; index += 1) {
      tracker.observe([friendPresenceKey(`person-${index}`, 'lirik')])
      time.advance(1_000)
    }
    expect(tracker.size()).toBeLessThanOrEqual(10)
  })
})

// ---------------------------------------------------------- watching together

describe('a shared watch starts when somebody else is there', () => {
  it('does not start when watching alone', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    expect(watch.update({ channel: 'lirik', otherCount: 0 })).toEqual([])
    expect(watch.current()).toBeNull()
  })

  it('starts when somebody arrives', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.update({ channel: 'lirik', otherCount: 0 })

    const events = watch.update({ channel: 'lirik', otherCount: 2 })
    expect(events).toEqual([
      { type: 'started', channel: 'lirik', otherCount: 2, attributionId: null, at: time.now() },
    ])
  })

  it('does not start again while it is running', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.update({ channel: 'lirik', otherCount: 1 })
    time.advance(60_000)
    expect(watch.update({ channel: 'lirik', otherCount: 3 })).toEqual([])
  })

  it('carries the JOIN that led there', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.attribute('attr-1')

    const [started] = watch.update({ channel: 'lirik', otherCount: 1 })
    expect(started).toMatchObject({ type: 'started', attributionId: 'attr-1' })
  })
})

describe('a shared watch ends honestly', () => {
  it('ends at once when the user navigates away', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.update({ channel: 'lirik', otherCount: 2 })

    time.advance(10 * 60 * 1000)
    const [ended] = watch.update({ channel: 'xqc', otherCount: 0 })

    expect(ended).toMatchObject({
      type: 'ended',
      channel: 'lirik',
      reason: 'left_channel',
      durationMs: 10 * 60 * 1000,
    })
  })

  it('does not end on a presence flap', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.update({ channel: 'lirik', otherCount: 1 })

    // A missed heartbeat looks exactly like leaving, for a moment.
    time.advance(30_000)
    expect(watch.update({ channel: 'lirik', otherCount: 0 })).toEqual([])
    time.advance(30_000)
    expect(watch.update({ channel: 'lirik', otherCount: 1 })).toEqual([])
    expect(watch.current()).not.toBeNull()
  })

  it('ends once they are really gone', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.update({ channel: 'lirik', otherCount: 1 })

    time.advance(60_000)
    watch.update({ channel: 'lirik', otherCount: 0 })
    time.advance(TOGETHER_END_GRACE_MS)
    const [ended] = watch.update({ channel: 'lirik', otherCount: 0 })

    expect(ended).toMatchObject({ type: 'ended', reason: 'alone_again' })
    // Measured to when they were last there, not through the grace period -
    // otherwise every shared watch is reported two minutes longer than it was.
    expect((ended as { durationMs: number }).durationMs).toBe(60_000)
  })

  it('reports the most people it ever had, not the last', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.update({ channel: 'lirik', otherCount: 1 })
    time.advance(1_000)
    watch.update({ channel: 'lirik', otherCount: 6 })
    time.advance(1_000)
    watch.update({ channel: 'lirik', otherCount: 2 })

    time.advance(1_000)
    const [ended] = watch.update({ channel: null, otherCount: 0 })
    expect(ended).toMatchObject({ otherCountPeak: 6 })
  })

  it('closes when the session does', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.update({ channel: 'lirik', otherCount: 1 })

    const [ended] = watch.stop()
    expect(ended).toMatchObject({ type: 'ended', reason: 'session_ended' })
    expect(watch.stop()).toEqual([])
  })

  it('moves cleanly from one shared channel to another', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.update({ channel: 'lirik', otherCount: 2 })

    time.advance(5_000)
    const events = watch.update({ channel: 'xqc', otherCount: 3 })

    expect(events.map((event) => event.type)).toEqual(['ended', 'started'])
    expect(events[0]).toMatchObject({ channel: 'lirik' })
    expect(events[1]).toMatchObject({ channel: 'xqc', otherCount: 3 })
  })
})
