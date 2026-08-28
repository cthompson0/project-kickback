import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPortClient } from '../../src/client/port'
import { createActivityRegistry } from '../../src/background/activity'
import { createPresenceReporter } from '../../src/background/presence'
import type { PresenceBackend } from '../../src/background/presence'

/**
 * Three Twitch tabs, three real port clients, one worker - and what reaches
 * the RPC.
 *
 * WHY THIS EXISTS WHEN TWO OTHER FILES ALREADY COVER THIS
 *
 * tests/extension/destinationPublishing.test.ts drives the registry directly.
 * It passed while hosted Supabase held exactly one destination row with three
 * streams open, so it was measuring something the browser does not do.
 *
 * What it skipped is the MV3 service-worker lifecycle. The worker is evicted
 * roughly thirty seconds after it goes quiet, and eviction destroys its module
 * scope - which is where the tab registry lives. Every port disconnects, every
 * tab reconnects, and the revived worker starts with an EMPTY registry. It
 * learns what a tab is showing from one `activity` message, and the content
 * script only sends that on mount, on navigation, on visibilitychange, on
 * pageshow and when the title settles. A tab sitting in the background sends
 * none of those, so the worker never finds out it exists.
 *
 * So this file uses the real `createPortClient` - including its reconnect path
 * - and rebuilds the worker the way eviction does. Nothing between the tab and
 * the RPC is mocked away except chrome itself and the network.
 */

// --------------------------------------------------------- the fake chrome

interface FakePort {
  name: string
  live: boolean
  messageListeners: Array<(message: unknown) => void>
  disconnectListeners: Array<() => void>
  onMessage: { addListener(fn: (message: unknown) => void): void }
  onDisconnect: { addListener(fn: () => void): void }
  postMessage(message: unknown): void
  disconnect(): void
  drop(): void
}

/** Every port the worker currently holds, in connection order. */
let connected: FakePort[] = []

/** What the worker does with a message from a port. Set up per test. */
let deliver: (port: FakePort, message: unknown) => void = () => {}

function makePort(name: string): FakePort {
  const port: FakePort = {
    name,
    live: true,
    messageListeners: [],
    disconnectListeners: [],
    onMessage: { addListener: (fn) => port.messageListeners.push(fn) },
    onDisconnect: { addListener: (fn) => port.disconnectListeners.push(fn) },
    postMessage: (message) => {
      // A dead port throws, exactly as chrome's does.
      if (!port.live) throw new Error('Attempting to use a disconnected port object')
      deliver(port, message)
    },
    disconnect: () => port.drop(),
    drop: () => {
      if (!port.live) return
      port.live = false
      connected = connected.filter((other) => other !== port)
      port.disconnectListeners.forEach((fn) => fn())
    },
  }
  return port
}

// -------------------------------------------------------------- the worker

/** Every backend call, in order. */
class RecordingBackend implements PresenceBackend {
  calls: string[] = []
  async reportPresence(platform: string | null, channel: string | null) {
    this.calls.push(`presence:${platform ?? 'null'}:${channel ?? 'null'}`)
    return { value: true as const }
  }
  async reportDestinations(channels: readonly string[]) {
    this.calls.push(`destinations:${channels.join(',')}`)
    return { value: Math.min(channels.length, 3) }
  }
  async heartbeat() {
    return { value: true as const }
  }
  async reportOffline() {
    this.calls.push('offline')
    return { value: true as const }
  }
}

/**
 * A service-worker instance.
 *
 * Deliberately a factory rather than a singleton, because the whole point is
 * that MV3 throws one away and builds another - and the second one starts with
 * no memory of any tab.
 */
function bootWorker(backend: RecordingBackend) {
  const registry = createActivityRegistry()
  const reporter = createPresenceReporter({
    backend,
    debounceMs: 100,
    heartbeatMs: 1_000,
    offlineGraceMs: 500,
    destinationRefreshMs: 5_000,
  })

  /** The presence half of the worker's pushActivity, verbatim. */
  const pushActivity = () => {
    reporter.setActivity(registry.effective())
    reporter.setDestinations(registry.destinations())
  }

  /** The worker's onConnect + onMessage, for the messages that matter here. */
  deliver = (port, message) => {
    const raw = message as { type?: string; channel?: unknown; visible?: unknown }
    if (raw.type !== 'activity') return
    registry.update(port, {
      channel: typeof raw.channel === 'string' ? raw.channel : null,
      visible: raw.visible === true,
      updatedAt: Date.now(),
    })
    pushActivity()
  }

  return {
    registry,
    reporter,
    /** The worker's onDisconnect. */
    forget(port: FakePort) {
      registry.remove(port)
      pushActivity()
    },
    /** MV3 eviction: every port dies and the module scope goes with it. */
    evict() {
      deliver = () => {}
      for (const port of [...connected]) port.drop()
    },
  }
}

// ---------------------------------------------------------------- a tab

/**
 * A Twitch tab: the real port client, plus the content script's own reporting.
 *
 * `report()` is what `reportActivity` in src/content/index.tsx does on mount,
 * on navigation and on visibilitychange - and, importantly, the ONLY thing it
 * does. There is no reconnect handler there, which is exactly the point.
 */
function openTab(channel: string | null, visible = true) {
  const client = createPortClient()
  const tab = {
    client,
    channel,
    visible,
    report() {
      client.reportActivity(tab.channel, tab.visible, null)
    },
    navigate(next: string) {
      tab.channel = next
      tab.report()
    },
    /** visibilitychange, which fires in both the tab shown and the one hidden. */
    setVisible(next: boolean) {
      tab.visible = next
      tab.report()
    },
  }
  tab.report()
  return tab
}

let backend: RecordingBackend
let worker: ReturnType<typeof bootWorker>

const writes = () => backend.calls
const lastWrite = () => backend.calls.at(-1)
const settle = () => vi.advanceTimersByTimeAsync(300)
/** Long enough for the client's 500ms reconnect backoff, plus the debounce. */
const reconnect = () => vi.advanceTimersByTimeAsync(1_500)

beforeEach(() => {
  vi.useFakeTimers()
  connected = []
  backend = new RecordingBackend()
  ;(globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      connect: ({ name }: { name: string }) => {
        const port = makePort(name)
        connected.push(port)
        return port
      },
    },
  }
  worker = bootWorker(backend)
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as { chrome?: unknown }).chrome
})

// ------------------------------------------------------- the baseline path

describe('three tabs through three real ports', () => {
  it('opens three ports', async () => {
    openTab('stream_a')
    openTab('stream_b')
    openTab('stream_c')
    await settle()

    expect(connected).toHaveLength(3)
  })

  it('aggregates all three destinations', async () => {
    openTab('stream_a')
    await settle()
    openTab('stream_b')
    await settle()
    openTab('stream_c')
    await settle()

    expect(worker.registry.destinations().sort()).toEqual([
      'stream_a',
      'stream_b',
      'stream_c',
    ])
  })

  /** The payload the owner's hosted rows are supposed to come from. */
  it('sends all three in the RPC payload', async () => {
    openTab('stream_a')
    await settle()
    openTab('stream_b')
    await settle()
    openTab('stream_c')
    await settle()

    expect(lastWrite()).toBe('destinations:stream_c,stream_b,stream_a')
    expect([...worker.reporter.lastDestinations()].sort()).toEqual([
      'stream_a',
      'stream_b',
      'stream_c',
    ])
  })

  it('never sends a singleton presence write while streams are open', async () => {
    openTab('stream_a')
    await settle()
    openTab('stream_b')
    await settle()
    openTab('stream_c')
    await settle()

    expect(writes().filter((call) => call.startsWith('presence:'))).toEqual([])
  })
})

// ------------------------------------------------- the actual browser defect

describe('after the service worker is evicted', () => {
  /**
   * The regression, stated exactly as the hosted evidence found it: three
   * streams open, one destination row.
   *
   * Nothing here touches a tab. The worker simply dies, as MV3 workers do,
   * and the tabs are left to say who they are.
   */
  it('still publishes all three once the tabs reconnect', async () => {
    openTab('stream_a')
    await settle()
    openTab('stream_b')
    await settle()
    openTab('stream_c')
    await settle()
    expect(lastWrite()).toBe('destinations:stream_c,stream_b,stream_a')

    // MV3 evicts the worker. Every port dies; the registry dies with it.
    worker.evict()
    expect(connected).toHaveLength(0)

    // A fresh worker, with no memory of any tab.
    backend = new RecordingBackend()
    worker = bootWorker(backend)

    // The tabs reconnect on their own. Nobody navigates, nobody switches tab.
    await reconnect()

    expect(connected).toHaveLength(3)
    expect(worker.registry.destinations().sort()).toEqual([
      'stream_a',
      'stream_b',
      'stream_c',
    ])
    expect([...worker.reporter.lastDestinations()].sort()).toEqual([
      'stream_a',
      'stream_b',
      'stream_c',
    ])
  })

  /** And the payload, which is what the hosted table is written from. */
  it('sends three in the RPC payload after reconnecting', async () => {
    openTab('stream_a')
    await settle()
    openTab('stream_b')
    await settle()
    openTab('stream_c')
    await settle()

    worker.evict()
    backend = new RecordingBackend()
    worker = bootWorker(backend)
    await reconnect()

    const payload = lastWrite()
    expect(payload).toMatch(/^destinations:/)
    expect(payload?.replace('destinations:', '').split(',').sort()).toEqual([
      'stream_a',
      'stream_b',
      'stream_c',
    ])
  })

  /**
   * The precise shape of the bug: only the tab the user touches next was ever
   * known to the revived worker. Here nobody touches anything, so under the
   * defect the answer was nothing at all - and one touched tab made it one.
   */
  it('does not publish only the tab that happens to move next', async () => {
    openTab('stream_a')
    await settle()
    const b = openTab('stream_b')
    await settle()
    openTab('stream_c')
    await settle()

    worker.evict()
    backend = new RecordingBackend()
    worker = bootWorker(backend)
    await reconnect()

    // The user switches to the middle tab, which is the one event a background
    // tab never produces for itself.
    b.setVisible(true)
    await settle()

    expect(worker.registry.destinations()).toHaveLength(3)
    expect(writes().filter((call) => call === 'destinations:stream_b')).toEqual([])
  })

  it('survives being evicted twice', async () => {
    openTab('stream_a')
    await settle()
    openTab('stream_b')
    await settle()

    for (let round = 0; round < 2; round += 1) {
      worker.evict()
      backend = new RecordingBackend()
      worker = bootWorker(backend)
      await reconnect()
    }

    expect(worker.registry.destinations().sort()).toEqual(['stream_a', 'stream_b'])
  })

  /** A tab that navigated before the eviction replays where it ended up. */
  it('replays the current channel, not the one the tab opened on', async () => {
    const tab = openTab('stream_a')
    await settle()
    openTab('stream_b')
    await settle()

    tab.navigate('stream_c')
    await settle()

    worker.evict()
    backend = new RecordingBackend()
    worker = bootWorker(backend)
    await reconnect()

    expect(worker.registry.destinations().sort()).toEqual(['stream_b', 'stream_c'])
  })

  /** A tab on twitch.tv itself still says so, rather than saying nothing. */
  it('replays a tab that is on no channel', async () => {
    openTab('stream_a')
    await settle()
    openTab(null)
    await settle()

    worker.evict()
    backend = new RecordingBackend()
    worker = bootWorker(backend)
    await reconnect()

    expect(worker.registry.tabCount()).toBe(2)
    expect(worker.registry.destinations()).toEqual(['stream_a'])
  })
})

// ------------------------------------------------- the set stays three

describe('the published set holds still', () => {
  const openThree = async () => {
    const a = openTab('stream_a')
    await settle()
    const b = openTab('stream_b')
    await settle()
    const c = openTab('stream_c')
    await settle()
    return { a, b, c }
  }

  it('survives heartbeats and the periodic refresh', async () => {
    await openThree()

    // Well past the heartbeat and the destination refresh.
    await vi.advanceTimersByTimeAsync(12_000)

    expect([...worker.reporter.lastDestinations()].sort()).toEqual([
      'stream_a',
      'stream_b',
      'stream_c',
    ])
    expect(lastWrite()).toMatch(/^destinations:/)
    expect(writes().filter((call) => call.startsWith('presence:'))).toEqual([])
  })

  it('survives visibility changes across all three tabs', async () => {
    const { a, b, c } = await openThree()
    const before = writes().length

    for (const [shown, hidden] of [
      [a, [b, c]],
      [b, [a, c]],
      [c, [a, b]],
    ] as const) {
      for (const tab of hidden) tab.setVisible(false)
      shown.setVisible(true)
      await settle()
    }

    expect([...worker.reporter.lastDestinations()].sort()).toEqual([
      'stream_a',
      'stream_b',
      'stream_c',
    ])
    // Focus is not a network event.
    expect(writes()).toHaveLength(before)
  })

  it('survives unrelated port messages', async () => {
    await openThree()
    const before = writes().length

    for (const port of connected) port.postMessage({ type: 'hello' })
    for (const port of connected) port.postMessage({ type: 'seen', kind: 'friends' })
    await settle()

    expect(worker.registry.destinations()).toHaveLength(3)
    expect(writes()).toHaveLength(before)
  })

  it('drops exactly the destination whose tab closed', async () => {
    const { b } = await openThree()

    const port = connected[1]
    port.drop()
    worker.forget(port)
    await settle()
    // The client will try to come back; it must not resurrect a closed tab.
    void b

    expect(worker.registry.destinations().sort()).toEqual(['stream_a', 'stream_c'])
    expect(lastWrite()?.replace('destinations:', '').split(',').sort()).toEqual([
      'stream_a',
      'stream_c',
    ])
  })
})
