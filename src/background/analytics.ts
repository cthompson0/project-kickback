/**
 * The analytics recorder: the one thing that actually sends.
 *
 * BEST-EFFORT IS A CONTRACT, NOT AN ASPIRATION
 *
 * Nothing here may be able to break Kickback. `track` returns void, never
 * throws, never awaits anything a caller is waiting on, and never blocks a
 * product action. If the backend is down, JOIN still joins and chat still
 * sends; the events queue, and if the queue fills, the OLDEST are dropped -
 * losing the start of an outage is better than losing what happened during it,
 * and unbounded growth in a service worker is not an option at all.
 *
 * WHY A QUEUE AND A TIMER
 *
 * Impressions arrive in bursts - opening the panel with fifteen friends is
 * fifteen events in one tick - so sending one request each would be absurd.
 * Events collect for FLUSH_DELAY_MS and go as one batch. A batch is also the
 * unit the server's rate budget is measured in events over, so batching cannot
 * be used to cheat it.
 *
 * RETRY WITHOUT A STORM
 *
 * A failed flush backs off, doubling to a ceiling, and the failed batch goes
 * back on the FRONT of the queue so ordering survives. There is no immediate
 * retry: a backend that is refusing writes must not be hit harder for it.
 *
 * DISABLED MEANS DISABLED
 *
 * The demo build passes `enabled: false` and nothing is queued, nothing is
 * sent, and no session is opened. Tests do the same. This is checked once at
 * the top of `track`, so there is no path where a disabled recorder still
 * reaches the network.
 */

import { buildEvent } from '../core/analytics'
import type {
  AnalyticsEnvironment,
  AnalyticsEvent,
  AnalyticsEventName,
  TrackRequest,
} from '../core/analytics'

export interface AnalyticsBackend {
  /** Resolves to the number accepted, or rejects. Never called when disabled. */
  send(events: AnalyticsEvent[]): Promise<number>
}

export interface AnalyticsRecorderDeps {
  backend: AnalyticsBackend
  environment: AnalyticsEnvironment
  appVersion: string | null
  /** False in the demo build and in tests. Nothing is queued or sent. */
  enabled: boolean
  /** The session an event belongs to, read at track time. */
  sessionId: () => string | null
  /** False until there is a signed-in user; events before that are dropped. */
  canSend: () => boolean
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  flushDelayMs?: number
  maxQueue?: number
  maxBatch?: number
  onError?: (context: string, error: unknown) => void
}

export interface AnalyticsRecorder {
  track<N extends AnalyticsEventName>(request: TrackRequest<N>): void
  /** Send whatever is queued now. Resolves when the attempt finishes. */
  flush(): Promise<void>
  /** Drop everything unsent - sign-out, or a different account. */
  clear(): void
  /** For tests and diagnostics. */
  pending(): number
}

/** Long enough to collect a burst of impressions, short enough to lose little. */
export const FLUSH_DELAY_MS = 5_000
/** The server caps a batch at 50; matching it means a batch is never half-refused. */
export const MAX_BATCH = 50
/** A few minutes of the heaviest imaginable use. Beyond this the oldest go. */
export const MAX_QUEUE = 400
const MAX_BACKOFF_MS = 5 * 60 * 1000

export function createAnalyticsRecorder(deps: AnalyticsRecorderDeps): AnalyticsRecorder {
  const now = deps.now ?? (() => Date.now())
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const flushDelayMs = deps.flushDelayMs ?? FLUSH_DELAY_MS
  const maxQueue = deps.maxQueue ?? MAX_QUEUE
  const maxBatch = deps.maxBatch ?? MAX_BATCH

  const queue: AnalyticsEvent[] = []
  let timer: unknown = null
  let sending = false
  let backoffMs = 0

  function scheduleFlush(delayMs: number): void {
    if (timer !== null) return
    timer = setTimer(() => {
      timer = null
      void run()
    }, delayMs)
  }

  async function run(): Promise<void> {
    if (sending || queue.length === 0) return
    if (!deps.enabled || !deps.canSend()) return

    sending = true
    const batch = queue.splice(0, maxBatch)

    try {
      await deps.backend.send(batch)
      backoffMs = 0
    } catch (error) {
      deps.onError?.('analytics.flush', error)
      /*
       * Back on the front, so a retry preserves order, and only if there is
       * room. A queue already at its limit means this outage has outlasted
       * what we are willing to hold; the batch is dropped rather than pushing
       * newer events out to make room for older ones.
       */
      if (queue.length + batch.length <= maxQueue) queue.unshift(...batch)
      /*
       * The FIRST retry already waits longer than an ordinary flush.
       *
       * Backing off only from the second failure onwards means the first retry
       * lands at the normal interval - which, for a backend that is refusing
       * writes, is just the storm arriving on schedule.
       */
      backoffMs = Math.min(backoffMs === 0 ? flushDelayMs * 2 : backoffMs * 2, MAX_BACKOFF_MS)
    } finally {
      sending = false
    }

    if (queue.length > 0) scheduleFlush(backoffMs || flushDelayMs)
  }

  return {
    track(request): void {
      // One check, at the top. There is no path past here when disabled.
      if (!deps.enabled) return

      const event = buildEvent(request, {
        environment: deps.environment,
        sessionId: deps.sessionId(),
        appVersion: deps.appVersion,
        now: now(),
      })
      // An unknown event name. Dropped at the boundary rather than sent for
      // the server to discard.
      if (!event) return

      queue.push(event)
      // Oldest first: during an outage, what just happened matters more than
      // what happened twenty minutes ago.
      while (queue.length > maxQueue) queue.shift()

      scheduleFlush(backoffMs || flushDelayMs)
    },

    async flush(): Promise<void> {
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
      await run()
    },

    clear(): void {
      queue.length = 0
      backoffMs = 0
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
    },

    pending: () => queue.length,
  }
}
