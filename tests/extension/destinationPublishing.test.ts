import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createActivityRegistry, MAX_DESTINATIONS } from '../../src/background/activity'
import { createPresenceReporter } from '../../src/background/presence'
import type { PresenceBackend } from '../../src/background/presence'

/**
 * What the extension actually puts on the wire, with the real runtime topology.
 *
 * tests/extension/multiDestination.test.ts asks the tab registry what it holds.
 * That was not enough: the manual smoke failed anyway, because the registry was
 * right and the WRITE was wrong. So this file wires the two production pieces
 * together the way the service worker wires them - a port per tab into
 * createActivityRegistry, its two answers into createPresenceReporter - and
 * asserts on the calls that reach the backend.
 *
 * The one thing that cannot be reproduced here is Chrome itself, so the harness
 * is pinned against the worker source at the bottom of the file: if
 * `pushActivity` ever stops doing what `push()` does, that test fails rather
 * than this whole file quietly going out of date.
 */

/** Every backend call, in order, as a comparable string. */
class RecordingBackend implements PresenceBackend {
  calls: string[] = []
  failWith: string | null = null

  private result<T>(value: T): { value: T | null; error?: string } {
    if (this.failWith) return { value: null, error: this.failWith }
    return { value }
  }

  async reportPresence(platform: string | null, channel: string | null) {
    this.calls.push(`presence:${platform ?? 'null'}:${channel ?? 'null'}`)
    return this.result(true as const)
  }

  async reportDestinations(channels: readonly string[]) {
    this.calls.push(`destinations:${channels.join(',')}`)
    // The server caps at three, and says how many it kept.
    return this.result(Math.min(channels.length, MAX_DESTINATIONS))
  }

  async heartbeat() {
    this.calls.push('heartbeat')
    return this.result(true as const)
  }

  async reportOffline() {
    this.calls.push('offline')
    return this.result(true as const)
  }
}

/**
 * A worker with tabs, as close to the real one as a test can get.
 *
 * Ports are plain objects because that is exactly what the worker uses as a tab
 * key - the port itself, so no `tabs` permission is needed.
 */
function createWorker(options: { destinationRefreshMs?: number } = {}) {
  const backend = new RecordingBackend()
  const registry = createActivityRegistry()
  const reporter = createPresenceReporter({
    backend,
    debounceMs: 100,
    heartbeatMs: 1_000,
    offlineGraceMs: 500,
    destinationRefreshMs: options.destinationRefreshMs ?? 60_000,
  })

  /** The presence half of the worker's pushActivity, verbatim. */
  const push = () => {
    reporter.setActivity(registry.effective())
    reporter.setDestinations(registry.destinations())
  }

  const tabs = new Map<object, string | null>()

  /**
   * Report every open tab, with exactly one of them visible.
   *
   * This is what the browser does: opening or focusing a tab fires
   * visibilitychange in the tab being hidden as well as the one being shown,
   * and the content script reports on both.
   */
  const reportAll = (visiblePort: object | null) => {
    for (const [port, channel] of tabs) {
      registry.update(port, {
        channel,
        visible: port === visiblePort,
        updatedAt: Date.now(),
      })
    }
    push()
  }

  return {
    backend,
    registry,
    reporter,
    /** Open a new Twitch tab on a channel. It becomes the visible one. */
    open(channel: string | null): object {
      const port = {}
      tabs.set(port, channel)
      reportAll(port)
      return port
    },
    /** Switch to an already-open tab. Nothing about what is open changes. */
    focus(port: object): void {
      reportAll(port)
    },
    /** Navigate one tab to another channel, as SPA navigation does. */
    navigate(port: object, channel: string | null): void {
      tabs.set(port, channel)
      reportAll(port)
    },
    close(port: object): void {
      tabs.delete(port)
      registry.remove(port)
      // The tab that gets focus next reports; model the simple case where the
      // remaining tabs are left as they were.
      push()
    },
    /** Let the debounce fire and the write land. */
    async settle(): Promise<void> {
      await vi.advanceTimersByTimeAsync(300)
    },
    /** Only the calls that publish something. */
    writes(): string[] {
      return backend.calls.filter((call) => call !== 'heartbeat')
    },
    lastWrite(): string | undefined {
      return this.writes().at(-1)
    },
  }
}

let worker: ReturnType<typeof createWorker>

beforeEach(() => {
  vi.useFakeTimers()
  worker = createWorker()
})
afterEach(() => {
  vi.useRealTimers()
})

// ------------------------------------------------- the reported scenario

describe('two tabs on two streams', () => {
  it('aggregates both destinations in the worker', async () => {
    worker.open('shroud')
    await worker.settle()
    worker.open('lirik')
    await worker.settle()

    expect(worker.registry.destinations().sort()).toEqual(['lirik', 'shroud'])
  })

  /** The assertion the manual smoke failure was really about. */
  it('sends BOTH in the outbound payload', async () => {
    worker.open('shroud')
    await worker.settle()
    worker.open('lirik')
    await worker.settle()

    expect(worker.lastWrite()).toBe('destinations:lirik,shroud')
  })

  it('publishes them as what the friend can see', async () => {
    worker.open('shroud')
    await worker.settle()
    worker.open('lirik')
    await worker.settle()

    expect([...worker.reporter.lastDestinations()].sort()).toEqual(['lirik', 'shroud'])
  })

  /**
   * The defect itself, stated as a rule.
   *
   * report_presence with one channel deletes every other destination row -
   * that is what it means, and it must keep meaning it for old clients. So a
   * client with a stream open must never send it. Not "must send it first":
   * the two calls went out concurrently with no ordering between them, and
   * whichever landed last won.
   */
  it('never sends a singleton presence write while a stream is open', async () => {
    worker.open('shroud')
    await worker.settle()
    worker.open('lirik')
    await worker.settle()
    worker.open('summit1g')
    await worker.settle()

    expect(worker.writes().filter((call) => call.startsWith('presence:'))).toEqual([])
  })

  /** One state, one write. Two writes is the bug however they are ordered. */
  it('issues exactly one write per change', async () => {
    worker.open('shroud')
    await worker.settle()
    expect(worker.writes()).toEqual(['destinations:shroud'])

    worker.open('lirik')
    await worker.settle()
    expect(worker.writes()).toEqual(['destinations:shroud', 'destinations:lirik,shroud'])
  })

  it('still has both after the heartbeat and ordinary activity', async () => {
    worker.open('shroud')
    await worker.settle()
    const second = worker.open('lirik')
    await worker.settle()

    // Several heartbeats, a focus switch, and a title-settling re-report.
    await vi.advanceTimersByTimeAsync(3_000)
    worker.focus(second)
    await worker.settle()

    expect([...worker.reporter.lastDestinations()].sort()).toEqual(['lirik', 'shroud'])
    expect(worker.writes().filter((call) => call.startsWith('presence:'))).toEqual([])
  })
})

// ------------------------------------------------------------ three, then four

describe('growing the set', () => {
  it('publishes all three', async () => {
    worker.open('stream_a')
    await worker.settle()
    worker.open('stream_b')
    await worker.settle()
    worker.open('stream_c')
    await worker.settle()

    expect(worker.lastWrite()).toBe('destinations:stream_c,stream_b,stream_a')
  })

  /** The cap, and which one falls out of it. */
  it('keeps exactly three when a fourth opens, with the newest included', async () => {
    worker.open('stream_a')
    await worker.settle()
    worker.open('stream_b')
    await worker.settle()
    worker.open('stream_c')
    await worker.settle()
    worker.open('stream_d')
    await worker.settle()

    const published = worker.reporter.lastDestinations()
    expect(published).toHaveLength(MAX_DESTINATIONS)
    expect(published).toContain('stream_d')
    // stream_a was opened longest ago, so it is the one that goes.
    expect(published).not.toContain('stream_a')
    expect(worker.lastWrite()).toBe('destinations:stream_d,stream_c,stream_b')
  })
})

// -------------------------------------------------------------- duplicates

describe('duplicate tabs on one stream', () => {
  it('publishes the stream once', async () => {
    worker.open('shroud')
    await worker.settle()
    worker.open('lirik')
    await worker.settle()
    worker.open('lirik')
    await worker.settle()

    const published = worker.reporter.lastDestinations()
    expect(published.filter((channel) => channel === 'lirik')).toHaveLength(1)
    expect([...published].sort()).toEqual(['lirik', 'shroud'])
  })

  /** A stream that is already open is not news, so nothing goes on the wire. */
  it('costs no write at all', async () => {
    worker.open('shroud')
    await worker.settle()
    worker.open('lirik')
    await worker.settle()
    const before = worker.writes().length

    worker.open('lirik')
    await worker.settle()

    expect(worker.writes()).toHaveLength(before)
  })

  it('keeps the stream when one of the duplicates closes', async () => {
    worker.open('shroud')
    await worker.settle()
    const first = worker.open('lirik')
    await worker.settle()
    worker.open('lirik')
    await worker.settle()

    worker.close(first)
    await worker.settle()

    expect([...worker.reporter.lastDestinations()].sort()).toEqual(['lirik', 'shroud'])
  })

  it('drops the stream when the last duplicate closes', async () => {
    worker.open('shroud')
    await worker.settle()
    const first = worker.open('lirik')
    await worker.settle()
    const second = worker.open('lirik')
    await worker.settle()

    worker.close(first)
    worker.close(second)
    await worker.settle()

    expect(worker.reporter.lastDestinations()).toEqual(['shroud'])
    expect(worker.lastWrite()).toBe('destinations:shroud')
  })

  /** A duplicate must not eat one of the three slots. */
  it('does not let a duplicate cost a third stream', async () => {
    worker.open('stream_a')
    await worker.settle()
    worker.open('stream_a')
    await worker.settle()
    worker.open('stream_b')
    await worker.settle()
    worker.open('stream_c')
    await worker.settle()

    expect([...worker.reporter.lastDestinations()].sort()).toEqual([
      'stream_a',
      'stream_b',
      'stream_c',
    ])
  })
})

// ------------------------------------------------------------------- focus

describe('focus is not a network event', () => {
  it('does not reorder the published set', async () => {
    worker.open('stream_a')
    await worker.settle()
    const b = worker.open('stream_b')
    await worker.settle()
    worker.open('stream_c')
    await worker.settle()
    const before = [...worker.reporter.lastDestinations()]

    worker.focus(b)
    await worker.settle()

    expect([...worker.reporter.lastDestinations()]).toEqual(before)
  })

  /**
   * The strong form, and the one the architecture actually promises: switching
   * between tabs produces no traffic whatsoever. Not a smaller write, not a
   * reordered one - none.
   */
  it('produces no write at all', async () => {
    const a = worker.open('stream_a')
    await worker.settle()
    const b = worker.open('stream_b')
    await worker.settle()
    const before = worker.writes().length

    worker.focus(a)
    await worker.settle()
    worker.focus(b)
    await worker.settle()
    worker.focus(a)
    await worker.settle()

    expect(worker.writes()).toHaveLength(before)
  })

  /** Including when the tab being focused is not on a channel at all. */
  it('does not clear the set when the focused tab is not on a stream', async () => {
    worker.open('shroud')
    await worker.settle()
    worker.open('lirik')
    await worker.settle()
    const before = worker.writes().length

    // twitch.tv itself, in a third tab.
    worker.open(null)
    await worker.settle()

    expect([...worker.reporter.lastDestinations()].sort()).toEqual(['lirik', 'shroud'])
    expect(worker.writes()).toHaveLength(before)
  })

  /** Navigation is a real change, and does reorder - that is the difference. */
  it('but navigating a tab does republish', async () => {
    worker.open('stream_a')
    await worker.settle()
    const b = worker.open('stream_b')
    await worker.settle()

    worker.navigate(b, 'stream_c')
    await worker.settle()

    expect([...worker.reporter.lastDestinations()].sort()).toEqual(['stream_a', 'stream_c'])
  })
})

// ------------------------------------------------------- browsing and offline

describe('the states that are not a stream', () => {
  /** The one remaining caller of the singleton, and it is correct there. */
  it('reports browsing through report_presence when nothing is open', async () => {
    worker.open(null)
    await worker.settle()
    expect(worker.writes()).toEqual(['presence:twitch:null'])
  })

  it('switches to the set the moment a stream opens', async () => {
    worker.open(null)
    await worker.settle()
    worker.open('shroud')
    await worker.settle()

    expect(worker.writes()).toEqual(['presence:twitch:null', 'destinations:shroud'])
  })

  it('goes offline when the last tab closes', async () => {
    const only = worker.open('shroud')
    await worker.settle()
    worker.close(only)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(worker.lastWrite()).toBe('offline')
  })
})

// ------------------------------------------------------------ staying alive

describe('keeping a published set from ageing out', () => {
  it('re-states the set well inside the thirty-minute window', async () => {
    worker = createWorker({ destinationRefreshMs: 2_000 })
    worker.open('shroud')
    await worker.settle()
    worker.open('lirik')
    await worker.settle()
    const before = worker.writes().length

    // Nothing happens. The user just watches.
    await vi.advanceTimersByTimeAsync(6_000)

    const after = worker.writes()
    expect(after.length).toBeGreaterThan(before)
    // And what it says is still the whole set.
    expect(after.at(-1)).toBe('destinations:lirik,shroud')
  })

  it('does not re-state anything when there is nothing published', async () => {
    worker = createWorker({ destinationRefreshMs: 2_000 })
    await vi.advanceTimersByTimeAsync(6_000)
    expect(worker.writes()).toEqual([])
  })
})

// --------------------------------------------------------- worker restart

describe('after the service worker is evicted', () => {
  /**
   * Eviction loses every bit of worker state; the tabs are still there and
   * reconnect their ports. Reconstruction has to publish the whole set again,
   * not just the tab that happened to reconnect first.
   */
  it('rebuilds and republishes every live destination', async () => {
    worker.open('shroud')
    await worker.settle()
    worker.open('lirik')
    await worker.settle()

    // A new worker, with the same tabs reconnecting one at a time.
    const revived = createWorker()
    revived.open('shroud')
    await revived.settle()
    revived.open('lirik')
    await revived.settle()

    expect([...revived.reporter.lastDestinations()].sort()).toEqual(['lirik', 'shroud'])
    expect(revived.writes().filter((call) => call.startsWith('presence:'))).toEqual([])
  })
})

// ------------------------------------------------------------ harness pin

describe('the harness matches the worker', () => {
  const WORKER = readFileSync('src/background/index.ts', 'utf8')

  /**
   * `push()` above claims to be the presence half of pushActivity. If the
   * worker ever changes what it feeds the reporter, this fails - rather than
   * every test in this file continuing to pass against a fiction.
   */
  it('feeds the reporter exactly what pushActivity feeds it', () => {
    expect(WORKER).toContain('presenceReporter.setActivity(tabActivity.effective())')
    expect(WORKER).toContain('presenceReporter.setDestinations(tabActivity.destinations())')
  })

  it('keys tabs by the port object, so no tabs permission is needed', () => {
    expect(WORKER).toContain('tabActivity.update(port, {')
    expect(WORKER).toContain('tabActivity.remove(port)')
  })

  /** Nothing outside the reporter may reach the presence RPCs. */
  it('leaves both presence entry points to the reporter alone', () => {
    const outside = WORKER.replace(/createPresenceReporter\(\{[\s\S]*?\n\}\)/, '')
    expect(outside).not.toContain('reportPresence(')
    expect(outside).not.toContain('reportDestinations(')
  })
})
