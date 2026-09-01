import { describe, expect, it } from 'vitest'
import { createAnalyticsRecorder } from '../../src/background/analytics'
import type { AnalyticsBackend } from '../../src/background/analytics'
import type { AnalyticsEvent } from '../../src/core/analytics'

/**
 * The recorder's job is to be unable to hurt anything.
 *
 * Everything here is about that: disabled means nothing is queued at all, a
 * failing backend costs events rather than throwing, a backend that stays down
 * is not hammered, and the queue cannot grow without bound in a service worker.
 */

/** A controllable clock and timer, so nothing here waits on real time. */
function harness(options: { enabled?: boolean; canSend?: () => boolean } = {}) {
  let clock = 1_700_000_000_000
  const timers: Array<{ id: number; at: number; fn: () => void }> = []
  let nextTimer = 1

  const sent: AnalyticsEvent[][] = []
  let fail = false
  let calls = 0

  const backend: AnalyticsBackend = {
    async send(events) {
      calls += 1
      if (fail) throw new Error('backend down')
      sent.push(events)
      return events.length
    },
  }

  const errors: string[] = []

  const recorder = createAnalyticsRecorder({
    backend,
    environment: 'private_beta',
    appVersion: '0.5.0',
    enabled: options.enabled ?? true,
    sessionId: () => 'session-1',
    canSend: options.canSend ?? (() => true),
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextTimer++
      timers.push({ id, at: clock + ms, fn })
      return id
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((timer) => timer.id === handle)
      if (index >= 0) timers.splice(index, 1)
    },
    onError: (context) => errors.push(context),
  })

  return {
    recorder,
    sent,
    errors,
    calls: () => calls,
    setFail: (value: boolean) => {
      fail = value
    },
    advance: async (ms: number) => {
      clock += ms
      const due = timers.filter((timer) => timer.at <= clock)
      for (const timer of due) timers.splice(timers.indexOf(timer), 1)
      for (const timer of due) timer.fn()
      // Let the flush's promise chain settle.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    },
    pendingTimers: () => timers.length,
  }
}

describe('a disabled recorder', () => {
  it('queues nothing and sends nothing', async () => {
    const h = harness({ enabled: false })
    h.recorder.track({ name: 'extension_session_started' })
    h.recorder.track({ name: 'join_clicked', channel: 'lirik' })

    expect(h.recorder.pending()).toBe(0)
    await h.recorder.flush()
    expect(h.calls()).toBe(0)
  })

  it('schedules no timer either, so a disabled build has nothing running', () => {
    const h = harness({ enabled: false })
    h.recorder.track({ name: 'extension_session_started' })
    expect(h.pendingTimers()).toBe(0)
  })
})

describe('batching', () => {
  it('collects a burst into one call', async () => {
    const h = harness()
    for (let index = 0; index < 8; index += 1) {
      h.recorder.track({ name: 'friend_presence_impression', channel: 'lirik' })
    }
    expect(h.calls()).toBe(0)

    await h.advance(5_000)

    expect(h.calls()).toBe(1)
    expect(h.sent[0]).toHaveLength(8)
  })

  it('never exceeds the batch the server accepts', async () => {
    const h = harness()
    for (let index = 0; index < 120; index += 1) {
      h.recorder.track({ name: 'friend_presence_impression', channel: 'lirik' })
    }
    await h.advance(5_000)
    expect(h.sent[0]).toHaveLength(50)
  })
})

describe('a failing backend', () => {
  it('does not throw at the call site', () => {
    const h = harness()
    h.setFail(true)
    // The whole contract: recording something can never be what breaks a JOIN.
    expect(() => h.recorder.track({ name: 'join_clicked', channel: 'lirik' })).not.toThrow()
  })

  it('does not reject when flushed', async () => {
    const h = harness()
    h.setFail(true)
    h.recorder.track({ name: 'join_clicked', channel: 'lirik' })
    await expect(h.recorder.flush()).resolves.toBeUndefined()
    expect(h.errors).toContain('analytics.flush')
  })

  it('keeps the events for a later attempt, in order', async () => {
    const h = harness()
    h.setFail(true)
    h.recorder.track({ name: 'extension_session_started' })
    h.recorder.track({ name: 'join_clicked', channel: 'lirik' })
    await h.recorder.flush()
    expect(h.recorder.pending()).toBe(2)

    h.setFail(false)
    await h.recorder.flush()
    expect(h.sent[0].map((event) => event.event_name)).toEqual([
      'extension_session_started',
      'join_clicked',
    ])
  })

  it('backs off rather than retrying in a storm', async () => {
    const h = harness()
    h.setFail(true)
    h.recorder.track({ name: 'join_clicked', channel: 'lirik' })

    await h.advance(5_000)
    expect(h.calls()).toBe(1)

    // The next attempt is not due yet: the delay has doubled.
    await h.advance(5_000)
    expect(h.calls()).toBe(1)

    await h.advance(5_000)
    expect(h.calls()).toBe(2)
  })
})

describe('the queue is bounded', () => {
  it('drops the oldest rather than growing without limit', async () => {
    const h = harness()
    h.setFail(true)
    for (let index = 0; index < 500; index += 1) {
      h.recorder.track({ name: 'combo_formed', properties: { count: index } })
    }
    expect(h.recorder.pending()).toBeLessThanOrEqual(400)

    h.setFail(false)
    await h.recorder.flush()
    // What survived is the END of the run: during an outage, what just
    // happened matters more than what happened twenty minutes ago.
    expect(h.sent[0][0].properties.count).toBeGreaterThan(0)
  })
})

describe('waiting for an actor', () => {
  it('holds events until there is somebody to attribute them to', async () => {
    let signedIn = false
    const h = harness({ canSend: () => signedIn })

    h.recorder.track({ name: 'extension_session_started' })
    await h.recorder.flush()
    expect(h.calls()).toBe(0)
    // Held, not thrown away: the session that started before auth resolved is
    // still that session.
    expect(h.recorder.pending()).toBe(1)

    signedIn = true
    await h.recorder.flush()
    expect(h.calls()).toBe(1)
  })
})

describe('what goes on the wire', () => {
  it('carries the environment and the build on every event', async () => {
    const h = harness()
    h.recorder.track({ name: 'group_created' })
    await h.recorder.flush()

    expect(h.sent[0][0]).toMatchObject({
      environment: 'private_beta',
      app_version: '0.5.0',
      session_id: 'session-1',
    })
  })

  it('drops an event the contract does not know, before sending', async () => {
    const h = harness()
    h.recorder.track({ name: 'made_up_event' as never })
    expect(h.recorder.pending()).toBe(0)
  })

  it('clears everything when told to', async () => {
    const h = harness()
    h.setFail(true)
    h.recorder.track({ name: 'group_created' })
    await h.recorder.flush()
    expect(h.recorder.pending()).toBe(1)

    h.recorder.clear()
    expect(h.recorder.pending()).toBe(0)
  })
})

/**
 * The "busy" bug, kept dead.
 *
 * `flush()` used to return early whenever a send was already under way, leaving
 * the caller's event queued and `pending()` non-zero. Anything that read the
 * queue afterwards to decide whether a write had landed - which is exactly what
 * the M3D JOIN trigger does - drew the wrong conclusion on almost every real
 * JOIN, silently.
 */
describe('flush waits for a send already in progress', () => {
  it('drains an event queued while an earlier batch is still sending', async () => {
    let release: () => void = () => {}
    const batches: number[] = []
    const recorder = createAnalyticsRecorder({
      backend: {
        async send(events) {
          batches.push(events.length)
          if (batches.length === 1) {
            await new Promise<void>((resolve) => {
              release = resolve
            })
          }
          return events.length
        },
      },
      environment: 'private_beta',
      appVersion: '0.7.0',
      enabled: true,
      sessionId: () => 'session-1',
      canSend: () => true,
      now: () => 1_700_000_000_000,
      flushDelayMs: 1,
    })

    recorder.track({ name: 'extension_session_started', properties: {}, channel: null })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(batches).toHaveLength(1)

    // Queued while the first send is still open, then flushed.
    recorder.track({ name: 'join_clicked', properties: { social_count: 1 }, source: 'social_gravity', channel: 'lirik' })
    const flushed = recorder.flush()
    release()
    await flushed

    // The queue actually drained, which is what "acknowledged" is read from.
    expect(recorder.pending()).toBe(0)
    expect(batches).toHaveLength(2)
  })
})
