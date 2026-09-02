import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createAnalyticsRecorder } from '../../src/background/analytics'

/**
 * Measurement must never break the thing it measures.
 *
 * WHY THIS DESERVES ITS OWN SUITE
 *
 * Watchside now carries a lot of measurement - dwell, JOIN attribution, creator
 * discovery, acquisition attribution - and every one of those was added because
 * it answers a question we need. None of them is worth a user being unable to
 * press JOIN.
 *
 * The property is structural rather than defensive: `track()` returns void,
 * pushes to a queue, and schedules a flush. Nothing in a product path awaits it,
 * so a failing backend cannot propagate into a click handler. That is a good
 * design and it was completely untested, which means it was one refactor away
 * from being untrue - the obvious "improvement" is to make track() async and
 * await it, and nothing would have objected.
 *
 * These tests exist to object.
 */

/** An analytics instance whose backend is as broken as the caller chooses. */
function analyticsWith(send: (events: unknown[]) => Promise<number>) {
  return createAnalyticsRecorder({
    backend: { send: send as never },
    enabled: true,
    environment: 'production',
    appVersion: '0.0.0-test',
    sessionId: () => '00000000-0000-0000-0000-000000000001',
    canSend: () => true,
    now: () => 1_700_000_000_000,
    /*
     * The timer never fires. Every test here calls flush() explicitly, so a
     * working timer buys nothing - and an immediate one is actively dangerous:
     * a backend that always fails reschedules, and a microtask-based timer
     * turns that into a loop that starves the event loop. Learned by hanging
     * this suite once.
     */
    setTimer: () => 0,
    clearTimer: () => {},
  } as never)
}

describe('track() cannot throw into a product path', () => {
  it('returns void, synchronously, even when the backend rejects', () => {
    const analytics = analyticsWith(() => Promise.reject(new Error('backend is down')))
    // The assertion is that this line does not throw and does not return a
    // promise a caller could accidentally await into a failure.
    const result = analytics.track({ name: 'join_clicked', source: 'gravity' } as never)
    expect(result).toBeUndefined()
  })

  it('does not throw when the backend throws synchronously', () => {
    const analytics = analyticsWith(() => {
      throw new Error('exploded before any promise existed')
    })
    expect(() => analytics.track({ name: 'join_clicked', source: 'gravity' } as never)).not.toThrow()
  })

  it('does not throw for an event name it has never heard of', () => {
    const analytics = analyticsWith(async () => 0)
    expect(() => analytics.track({ name: 'not_a_real_event' } as never)).not.toThrow()
  })

  it('does not throw when handed properties of the wrong shape', () => {
    const analytics = analyticsWith(async () => 0)
    expect(() =>
      analytics.track({ name: 'join_clicked', source: null, properties: { nonsense: { deep: [1, 2] } } } as never),
    ).not.toThrow()
  })
})

describe('a failing backend stays contained', () => {
  it('leaves flush() resolving rather than rejecting', async () => {
    /*
     * The M3D JOIN trigger awaits flush() before deciding whether to measure. If
     * flush() rejected on a backend failure, an analytics outage would become a
     * JOIN that throws - measurement breaking the thing it measures, exactly
     * once per user, at the least forgivable moment.
     */
    const analytics = analyticsWith(() => Promise.reject(new Error('backend is down')))
    analytics.track({ name: 'join_clicked', source: 'gravity' } as never)
    await expect(analytics.flush()).resolves.toBeUndefined()
  })

  it('survives a backend that fails every time, repeatedly', async () => {
    const analytics = analyticsWith(() => Promise.reject(new Error('still down')))
    for (let i = 0; i < 50; i += 1) {
      analytics.track({ name: 'join_clicked', source: 'gravity' } as never)
    }
    await expect(analytics.flush()).resolves.toBeUndefined()
  })

  it('does not grow without bound while the backend is unreachable', async () => {
    /*
     * An outage must not turn into a memory problem. The queue is capped and
     * drops oldest-first, because during an outage what just happened matters
     * more than what happened twenty minutes ago.
     */
    const sent: unknown[] = []
    const analytics = analyticsWith(async (batch: unknown[]) => {
      sent.push(batch)
      return batch.length
    })
    for (let i = 0; i < 5_000; i += 1) {
      analytics.track({ name: 'join_clicked', source: 'gravity' } as never)
    }
    await analytics.flush()
    // Whatever the cap is, it is a cap: nothing like five thousand survived.
    const flat = JSON.stringify(sent)
    expect(flat.length).toBeLessThan(2_000_000)
  })
})

describe('the shape of the guarantee, asserted against the source', () => {
  it('keeps track() synchronous and void-returning', () => {
    /*
     * Read from source as well as behaviour, because the tempting refactor -
     * `async track()` so a caller can await delivery - would still pass every
     * behavioural test above while making every call site awaitable, and one
     * `await analytics.track(...)` in a click handler is all it takes.
     */
    const source = readFileSync('src/background/analytics.ts', 'utf8')
    expect(source).toMatch(/\btrack\(request\): void\b/)
    expect(source, 'track() became async, so callers can await a failure').not.toMatch(
      /async track\(/,
    )
  })

  it('never awaits analytics inside a product path', () => {
    // The other half: even a void-returning track cannot be awaited usefully,
    // but `void analytics.track(...)` vs `await` is a one-character difference.
    for (const file of ['src/background/index.ts', 'src/ui/KickbackPanel.tsx']) {
      const source = readFileSync(file, 'utf8')
      expect(source, `${file} awaits an analytics call`).not.toMatch(
        /await\s+analytics\.track\(|await\s+client\.track\(/,
      )
    }
  })
})

describe('a disabled analytics stack is silent, not broken', () => {
  it('accepts calls and sends nothing', async () => {
    const send = vi.fn(async () => 0)
    const analytics = createAnalyticsRecorder({
      backend: { send },
      enabled: false,
      environment: 'production',
      appVersion: '0.0.0-test',
      sessionId: () => '00000000-0000-0000-0000-000000000001',
      canSend: () => true,
      now: () => 1_700_000_000_000,
    } as never)

    expect(() => analytics.track({ name: 'join_clicked', source: 'gravity' } as never)).not.toThrow()
    await analytics.flush()
    expect(send).not.toHaveBeenCalled()
  })
})
