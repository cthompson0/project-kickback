import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSocialSync } from '../../src/background/socialSync'
import type { SocialChannel, SocialChannelHandlers } from '../../src/background/socialSync'

/**
 * Social-graph synchronisation, driven through a fake channel.
 *
 * What matters here is not that events arrive - it is that they arrive exactly
 * once per burst, that a dropped connection comes back, and that we never end
 * up with two live subscriptions feeding the same state.
 */

interface Opened {
  userId: string
  handlers: SocialChannelHandlers
  closed: boolean
}

class FakeChannel implements SocialChannel {
  opened: Opened[] = []
  failNextOpen = false
  openDelayMs = 0

  async open(userId: string, handlers: SocialChannelHandlers): Promise<() => void> {
    if (this.openDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.openDelayMs))
    }
    if (this.failNextOpen) {
      this.failNextOpen = false
      throw new Error('could not subscribe')
    }
    const entry: Opened = { userId, handlers, closed: false }
    this.opened.push(entry)
    return () => {
      entry.closed = true
    }
  }

  get live(): Opened[] {
    return this.opened.filter((entry) => !entry.closed)
  }

  latest(): Opened {
    return this.opened[this.opened.length - 1]
  }
}

let channel: FakeChannel
let invalidated: number

function makeSync() {
  return createSocialSync({
    channel,
    onInvalidate: () => {
      invalidated += 1
    },
    debounceMs: 100,
    retryDelaysMs: [1000, 5000],
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  channel = new FakeChannel()
  invalidated = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('subscribing', () => {
  it('opens exactly one subscription', async () => {
    const sync = makeSync()
    sync.start('user-a')
    await vi.advanceTimersByTimeAsync(0)

    expect(channel.opened).toHaveLength(1)
    expect(channel.opened[0].userId).toBe('user-a')
    expect(sync.isRunning()).toBe(true)
  })

  it('does not open a second subscription for the same user', async () => {
    const sync = makeSync()
    sync.start('user-a')
    await vi.advanceTimersByTimeAsync(0)
    channel.latest().handlers.onStatus('connected')

    sync.start('user-a')
    sync.start('user-a')
    await vi.advanceTimersByTimeAsync(0)

    expect(channel.opened).toHaveLength(1)
    expect(channel.live).toHaveLength(1)
  })

  it('closes the old subscription when the signed-in user changes', async () => {
    const sync = makeSync()
    sync.start('user-a')
    await vi.advanceTimersByTimeAsync(0)

    sync.start('user-b')
    await vi.advanceTimersByTimeAsync(0)

    expect(channel.opened).toHaveLength(2)
    expect(channel.opened[0].closed).toBe(true)
    expect(channel.live).toHaveLength(1)
    expect(sync.getUserId()).toBe('user-b')
  })

  it('discards a subscription that finished opening after we moved on', async () => {
    channel.openDelayMs = 50
    const sync = makeSync()
    sync.start('user-a')

    sync.stop() // stopped while the open was still in flight
    await vi.advanceTimersByTimeAsync(100)

    expect(channel.live).toHaveLength(0)
    expect(sync.isRunning()).toBe(false)
  })
})

describe('invalidation', () => {
  it('collapses a burst of row changes into a single re-read', async () => {
    const sync = makeSync()
    sync.start('user-a')
    await vi.advanceTimersByTimeAsync(0)

    // Accepting a request touches friend_requests and both friendship rows.
    const { handlers } = channel.latest()
    handlers.onEvent()
    handlers.onEvent()
    handlers.onEvent()

    await vi.advanceTimersByTimeAsync(200)
    expect(invalidated).toBe(1)
  })

  it('re-reads again for a later, separate change', async () => {
    const sync = makeSync()
    sync.start('user-a')
    await vi.advanceTimersByTimeAsync(0)

    channel.latest().handlers.onEvent()
    await vi.advanceTimersByTimeAsync(200)
    channel.latest().handlers.onEvent()
    await vi.advanceTimersByTimeAsync(200)

    expect(invalidated).toBe(2)
  })

  it('re-reads on connect, to catch anything missed while disconnected', async () => {
    const sync = makeSync()
    sync.start('user-a')
    await vi.advanceTimersByTimeAsync(0)

    channel.latest().handlers.onStatus('connected')
    await vi.advanceTimersByTimeAsync(200)

    expect(invalidated).toBe(1)
    expect(sync.getStatus()).toBe('connected')
  })

  it('ignores events once stopped', async () => {
    const sync = makeSync()
    sync.start('user-a')
    await vi.advanceTimersByTimeAsync(0)
    const { handlers } = channel.latest()

    sync.stop()
    handlers.onEvent()
    await vi.advanceTimersByTimeAsync(200)

    expect(invalidated).toBe(0)
  })

  it('ignores events from a subscription that has been superseded', async () => {
    const sync = makeSync()
    sync.start('user-a')
    await vi.advanceTimersByTimeAsync(0)
    const stale = channel.latest().handlers

    sync.start('user-b')
    await vi.advanceTimersByTimeAsync(0)

    stale.onEvent()
    await vi.advanceTimersByTimeAsync(200)

    expect(invalidated).toBe(0)
  })
})

describe('recovery', () => {
  it('reopens after a channel error', async () => {
    const sync = makeSync()
    sync.start('user-a')
    await vi.advanceTimersByTimeAsync(0)

    channel.latest().handlers.onStatus('error')
    expect(channel.live).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1000)
    expect(channel.opened).toHaveLength(2)
    expect(channel.live).toHaveLength(1)
  })

  it('backs off further on a repeated failure', async () => {
    const sync = makeSync()
    sync.start('user-a')
    await vi.advanceTimersByTimeAsync(0)

    channel.latest().handlers.onStatus('error')
    await vi.advanceTimersByTimeAsync(1000)
    expect(channel.opened).toHaveLength(2)

    channel.latest().handlers.onStatus('error')
    await vi.advanceTimersByTimeAsync(1000)
    // Second retry waits longer than the first, so it has not fired yet.
    expect(channel.opened).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(4000)
    expect(channel.opened).toHaveLength(3)
  })

  it('resets the backoff once the connection is healthy again', async () => {
    const sync = makeSync()
    sync.start('user-a')
    await vi.advanceTimersByTimeAsync(0)

    channel.latest().handlers.onStatus('error')
    await vi.advanceTimersByTimeAsync(1000)
    channel.latest().handlers.onStatus('connected')

    channel.latest().handlers.onStatus('error')
    await vi.advanceTimersByTimeAsync(1000)

    // Back to the short delay, not the long one.
    expect(channel.opened).toHaveLength(3)
  })

  it('retries when opening the subscription throws outright', async () => {
    channel.failNextOpen = true
    const sync = makeSync()
    sync.start('user-a')
    await vi.advanceTimersByTimeAsync(0)

    expect(channel.opened).toHaveLength(0)
    expect(sync.getStatus()).toBe('error')

    await vi.advanceTimersByTimeAsync(1000)
    expect(channel.opened).toHaveLength(1)
  })

  it('stops retrying after stop()', async () => {
    const sync = makeSync()
    sync.start('user-a')
    await vi.advanceTimersByTimeAsync(0)

    channel.latest().handlers.onStatus('error')
    sync.stop()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(channel.opened).toHaveLength(1)
    expect(channel.live).toHaveLength(0)
  })

  it('starts cleanly again after a service-worker restart', async () => {
    // A restarted worker is a brand new sync object over the same channel.
    const first = makeSync()
    first.start('user-a')
    await vi.advanceTimersByTimeAsync(0)
    first.stop()

    const revived = makeSync()
    revived.start('user-a')
    await vi.advanceTimersByTimeAsync(0)

    expect(channel.live).toHaveLength(1)
    expect(revived.isRunning()).toBe(true)
  })
})
