import { describe, expect, it } from 'vitest'
import { createTogetherWatch, TOGETHER_END_GRACE_MS } from '../../src/background/togetherWatch'
import type { TogetherEvent } from '../../src/background/togetherWatch'

/**
 * The observed case, and every neighbour of it.
 *
 * THE BUG THIS EXISTS FOR
 *
 * A was watching summit1g. B joined. Both were Watching Together. A left; B
 * kept watching alone for forty minutes, then left. B's shared watch was
 * recorded with the right DURATION but the wrong TIME - stamped forty minutes
 * late, and labelled `left_channel` when what ended it was running out of
 * people. The forty minutes B stayed on alone were recorded nowhere at all.
 *
 * Nothing about that was visible in a duration assertion, which is why these
 * tests assert the effective end time and the reason as hard as the length.
 *
 * The delayed path is the important one and is easy to under-test: the grace
 * period only elapses when something calls `update`, and if no presence
 * traffic arrives, nothing does until the user themselves moves. Both paths -
 * noticing on time, and only finding out at the end - must produce the same
 * numbers, and several tests below run the same scenario down each.
 */

const MINUTE = 60 * 1000

function clock(startAt = 1_700_000_000_000) {
  let value = startAt
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms
    },
    at: () => value,
  }
}

const ended = (events: TogetherEvent[]) => events.find((e) => e.type === 'ended')
const postSocial = (events: TogetherEvent[]) => events.find((e) => e.type === 'post_social_ended')
const started = (events: TogetherEvent[]) => events.find((e) => e.type === 'started')

describe('the observed case: A leaves, B stays, B leaves much later', () => {
  /**
   * @param noticed whether any presence traffic arrives while B watches alone,
   *   which is the only thing that lets the grace period elapse before B moves.
   */
  function run(noticed: boolean) {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })

    // B arrives on summit1g through a JOIN, with A already there.
    watch.attribute('attr-1')
    const T0 = time.at()
    watch.update({ channel: 'summit1g', otherCount: 1 })

    // A leaves ten minutes later.
    time.advance(10 * MINUTE)
    const T1 = time.at()
    const atDeparture = watch.update({ channel: 'summit1g', otherCount: 0 })

    let duringSolo: TogetherEvent[] = []
    if (noticed) {
      // Some other friend's presence arrives, so the grace period is evaluated.
      time.advance(TOGETHER_END_GRACE_MS + MINUTE)
      duringSolo = watch.update({ channel: 'summit1g', otherCount: 0 })
    }

    // B watches alone until forty minutes after A went, then leaves.
    time.advance(T1 + 40 * MINUTE - time.at())
    const T2 = time.at()
    const atExit = watch.update({ channel: null, otherCount: 0 })

    return { T0, T1, T2, atDeparture, duringSolo, atExit }
  }

  for (const noticed of [false, true]) {
    const path = noticed ? 'when the grace period is evaluated' : 'when nothing is noticed until B moves'

    describe(path, () => {
      const r = run(noticed)
      const all = [...r.atDeparture, ...r.duringSolo, ...r.atExit]

      it('ends the shared watch when A actually left, not when B did', () => {
        const end = ended(all)
        expect(end).toBeDefined()
        // The heart of it. T1, never T2.
        expect(end && end.type === 'ended' && end.effectiveAt).toBe(r.T1)
      })

      it('records the shared watch as ten minutes, not fifty', () => {
        const end = ended(all)
        expect(end && end.type === 'ended' && end.durationMs).toBe(10 * MINUTE)
      })

      it('says it ended because everyone left, not because B did', () => {
        const end = ended(all)
        expect(end && end.type === 'ended' && end.reason).toBe('alone_again')
      })

      it('keeps the detection lag as its own fact', () => {
        const end = ended(all)
        if (!end || end.type !== 'ended') throw new Error('no end')
        expect(end.detectedAt).toBeGreaterThanOrEqual(end.effectiveAt)
        expect(end.detectedAt - end.effectiveAt).toBe(noticed ? 3 * MINUTE : 40 * MINUTE)
      })

      it('records the forty minutes B stayed on alone', () => {
        const post = postSocial(all)
        expect(post).toBeDefined()
        expect(post && post.type === 'post_social_ended' && post.durationMs).toBe(40 * MINUTE)
        expect(post && post.type === 'post_social_ended' && post.reason).toBe('left_channel')
      })

      it('attributes the whole lifecycle to the JOIN that started it', () => {
        for (const event of all) {
          if (event.type === 'started' || event.type === 'ended') {
            expect(event.attributionId).toBe('attr-1')
          }
          if (event.type === 'post_social_ended') expect(event.attributionId).toBe('attr-1')
        }
      })

      it('leaves no gap or overlap between the two intervals', () => {
        // Post-social begins exactly where co-viewing effectively ended.
        const end = ended(all)
        const post = postSocial(all)
        if (!end || end.type !== 'ended' || !post || post.type !== 'post_social_ended') {
          throw new Error('missing events')
        }
        expect(post.at - post.durationMs).toBe(end.effectiveAt)
      })
    })
  }

  it('produces identical numbers down both paths', () => {
    // The point of the whole design: being slow to notice must not change any
    // recorded quantity, only the detection lag.
    const late = run(false)
    const prompt = run(true)

    const pick = (events: TogetherEvent[]) => {
      const end = ended(events)
      const post = postSocial(events)
      return {
        effectiveAt: end?.type === 'ended' ? end.effectiveAt : null,
        durationMs: end?.type === 'ended' ? end.durationMs : null,
        reason: end?.type === 'ended' ? end.reason : null,
        post: post?.type === 'post_social_ended' ? post.durationMs : null,
      }
    }

    expect(pick([...late.atDeparture, ...late.duringSolo, ...late.atExit])).toEqual(
      pick([...prompt.atDeparture, ...prompt.duringSolo, ...prompt.atExit]),
    )
  })
})

describe('B leaves first', () => {
  it('ends the shared watch there and then, with no retention', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.attribute('attr-1')
    watch.update({ channel: 'summit1g', otherCount: 1 })

    time.advance(15 * MINUTE)
    const events = watch.update({ channel: null, otherCount: 0 })

    const end = ended(events)
    expect(end && end.type === 'ended' && end.reason).toBe('left_channel')
    expect(end && end.type === 'ended' && end.durationMs).toBe(15 * MINUTE)
    expect(end && end.type === 'ended' && end.effectiveAt).toBe(time.at())
    // Nothing came after the social context, because B ended it by leaving.
    expect(postSocial(events)).toBeUndefined()
  })
})

describe('both leave at nearly the same moment', () => {
  it('reports the sliver of retention honestly rather than rounding it away', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.update({ channel: 'summit1g', otherCount: 1 })

    time.advance(20 * MINUTE)
    watch.update({ channel: 'summit1g', otherCount: 0 }) // A's departure lands first
    time.advance(3_000)
    const events = watch.update({ channel: null, otherCount: 0 })

    const end = ended(events)
    const post = postSocial(events)
    expect(end && end.type === 'ended' && end.durationMs).toBe(20 * MINUTE)
    expect(end && end.type === 'ended' && end.reason).toBe('alone_again')
    // Three seconds is retention of three seconds. A report that wants
    // "meaningfully retained" thresholds on the duration; the fact stays true.
    expect(post && post.type === 'post_social_ended' && post.durationMs).toBe(3_000)
  })

  it('reports none at all when the user moves first', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.update({ channel: 'summit1g', otherCount: 1 })

    time.advance(20 * MINUTE)
    // B's navigation is what we hear about first; A's departure never arrives.
    const events = watch.update({ channel: null, otherCount: 0 })
    expect(postSocial(events)).toBeUndefined()
  })
})

describe('presence flaps inside the grace window', () => {
  it('does not end anything', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.update({ channel: 'summit1g', otherCount: 1 })

    time.advance(5 * MINUTE)
    expect(watch.update({ channel: 'summit1g', otherCount: 0 })).toEqual([])
    time.advance(30_000)
    expect(watch.update({ channel: 'summit1g', otherCount: 1 })).toEqual([])
    expect(watch.current()?.socialEndedAt).toBeNull()
  })

  it('counts the whole stretch, including the flap, as together', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.update({ channel: 'summit1g', otherCount: 1 })

    time.advance(5 * MINUTE)
    watch.update({ channel: 'summit1g', otherCount: 0 })
    time.advance(30_000)
    watch.update({ channel: 'summit1g', otherCount: 1 })
    time.advance(5 * MINUTE)

    const end = ended(watch.update({ channel: null, otherCount: 0 }))
    // A missed heartbeat is not somebody leaving, so the 30s is not a gap.
    expect(end && end.type === 'ended' && end.durationMs).toBe(10 * MINUTE + 30_000)
    expect(end && end.type === 'ended' && end.reason).toBe('left_channel')
  })
})

describe('several friends', () => {
  it('keeps the shared watch going while any of them remain', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.update({ channel: 'summit1g', otherCount: 3 })

    time.advance(10 * MINUTE)
    // One leaves. Two are still here; nothing has dissolved.
    expect(watch.update({ channel: 'summit1g', otherCount: 2 })).toEqual([])
    time.advance(10 * MINUTE)
    expect(watch.update({ channel: 'summit1g', otherCount: 1 })).toEqual([])
    expect(watch.current()?.aloneSince).toBeNull()
  })

  it('starts retention only when the LAST of them goes', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.attribute('attr-1')
    watch.update({ channel: 'summit1g', otherCount: 3 })

    time.advance(10 * MINUTE)
    watch.update({ channel: 'summit1g', otherCount: 1 })
    time.advance(10 * MINUTE)
    const lastLeftAt = time.at()
    watch.update({ channel: 'summit1g', otherCount: 0 })

    time.advance(15 * MINUTE)
    const events = watch.update({ channel: null, otherCount: 0 })

    const end = ended(events)
    // Together ran the full twenty minutes, ending when the last one left.
    expect(end && end.type === 'ended' && end.durationMs).toBe(20 * MINUTE)
    expect(end && end.type === 'ended' && end.effectiveAt).toBe(lastLeftAt)
    expect(end && end.type === 'ended' && end.otherCountPeak).toBe(3)
    expect(postSocial(events)).toMatchObject({ durationMs: 15 * MINUTE })
  })
})

describe('somebody comes back after the social context dissolved', () => {
  it('closes the retention and opens a new shared watch', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.attribute('attr-1')
    watch.update({ channel: 'summit1g', otherCount: 1 })

    time.advance(10 * MINUTE)
    watch.update({ channel: 'summit1g', otherCount: 0 })
    // Long enough for the grace to expire and retention to begin.
    time.advance(TOGETHER_END_GRACE_MS + MINUTE)
    watch.update({ channel: 'summit1g', otherCount: 0 })
    expect(watch.current()?.socialEndedAt).not.toBeNull()

    time.advance(10 * MINUTE)
    const events = watch.update({ channel: 'summit1g', otherCount: 2 })

    const post = postSocial(events)
    expect(post && post.type === 'post_social_ended' && post.reason).toBe('rejoined')
    // Measured from when they left, not from when we noticed they had.
    expect(post && post.type === 'post_social_ended' && post.durationMs).toBe(13 * MINUTE)

    const start = started(events)
    expect(start).toBeDefined()
    // The JOIN still owns the visit: it is why they are on this channel at all.
    expect(start && start.type === 'started' && start.attributionId).toBe('attr-1')
  })
})

describe('changing destination', () => {
  it('closes everything on the old channel and starts fresh on the new one', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.attribute('attr-1')
    watch.update({ channel: 'summit1g', otherCount: 1 })

    time.advance(10 * MINUTE)
    const events = watch.update({ channel: 'lirik', otherCount: 2 })

    expect(events.map((e) => e.type)).toEqual(['ended', 'started'])
    expect(events[0]).toMatchObject({ channel: 'summit1g', reason: 'left_channel' })
    expect(events[1]).toMatchObject({ channel: 'lirik', otherCount: 2 })
    // A new channel is a new opportunity: the old JOIN does not follow it.
    expect(events[1].type === 'started' && events[1].attributionId).toBeNull()
  })

  it('closes a retention interval too', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.update({ channel: 'summit1g', otherCount: 1 })

    time.advance(5 * MINUTE)
    watch.update({ channel: 'summit1g', otherCount: 0 })
    time.advance(TOGETHER_END_GRACE_MS + MINUTE)
    watch.update({ channel: 'summit1g', otherCount: 0 })

    time.advance(5 * MINUTE)
    const events = watch.update({ channel: 'lirik', otherCount: 0 })
    expect(postSocial(events)).toMatchObject({ reason: 'left_channel', durationMs: 8 * MINUTE })
  })
})

describe('signing out', () => {
  it('closes an open shared watch', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.update({ channel: 'summit1g', otherCount: 1 })
    time.advance(5 * MINUTE)

    const events = watch.stop()
    expect(ended(events)).toMatchObject({ reason: 'session_ended', durationMs: 5 * MINUTE })
    expect(watch.stop()).toEqual([])
  })

  it('closes an open retention interval', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.update({ channel: 'summit1g', otherCount: 1 })
    time.advance(5 * MINUTE)
    watch.update({ channel: 'summit1g', otherCount: 0 })
    time.advance(TOGETHER_END_GRACE_MS + MINUTE)
    watch.update({ channel: 'summit1g', otherCount: 0 })

    time.advance(4 * MINUTE)
    const events = watch.stop()
    expect(postSocial(events)).toMatchObject({ reason: 'session_ended', durationMs: 7 * MINUTE })
  })
})

describe('organic co-viewing that no JOIN brought about', () => {
  it('records the shared watch and the retention with no attribution', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    // No attribute() call: they were both simply there.
    watch.update({ channel: 'summit1g', otherCount: 1 })

    time.advance(10 * MINUTE)
    watch.update({ channel: 'summit1g', otherCount: 0 })
    time.advance(10 * MINUTE)
    const events = watch.update({ channel: null, otherCount: 0 })

    const end = ended(events)
    const post = postSocial(events)
    expect(end && end.type === 'ended' && end.durationMs).toBe(10 * MINUTE)
    // The measurement is a fact; the CREDIT is not. Nothing here was caused by
    // a JOIN, so nothing here may be counted as one.
    expect(end && end.type === 'ended' && end.attributionId).toBeNull()
    expect(post && post.type === 'post_social_ended' && post.attributionId).toBeNull()
  })
})

describe('a JOIN that never becomes a shared watch', () => {
  it('produces no together interval and no retention', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.attribute('attr-1')

    // Arrived, but nobody was actually there - they had already moved on.
    expect(watch.update({ channel: 'summit1g', otherCount: 0 })).toEqual([])
    time.advance(20 * MINUTE)
    expect(watch.update({ channel: null, otherCount: 0 })).toEqual([])
    expect(watch.current()).toBeNull()
  })
})

describe('a cluster of friends, as Social Gravity will produce', () => {
  it('is one shared watch, not one per friend', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.attribute('attr-cluster')

    // Three friends on the destination: one opportunity, one arrival, one
    // interval. Nothing here picks a friend to credit.
    const events = watch.update({ channel: 'xqc', otherCount: 3 })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'started',
      otherCount: 3,
      attributionId: 'attr-cluster',
    })

    time.advance(30 * MINUTE)
    const end = ended(watch.update({ channel: null, otherCount: 0 }))
    expect(end && end.type === 'ended' && end.otherCountPeak).toBe(3)
    expect(end && end.type === 'ended' && end.attributionId).toBe('attr-cluster')
  })

  it('holds the peak when the cluster thins out before dissolving', () => {
    const time = clock()
    const watch = createTogetherWatch({ now: time.now })
    watch.update({ channel: 'xqc', otherCount: 1 })
    time.advance(MINUTE)
    watch.update({ channel: 'xqc', otherCount: 5 })
    time.advance(MINUTE)
    watch.update({ channel: 'xqc', otherCount: 2 })
    time.advance(MINUTE)
    const lastLeft = time.at()
    watch.update({ channel: 'xqc', otherCount: 0 })

    time.advance(10 * MINUTE)
    const events = watch.update({ channel: null, otherCount: 0 })
    const end = ended(events)
    expect(end && end.type === 'ended' && end.otherCountPeak).toBe(5)
    expect(end && end.type === 'ended' && end.effectiveAt).toBe(lastLeft)
  })
})
