/**
 * Keeps the social graph fresh while Watchside is running.
 *
 * This is an *invalidation* channel, not a data channel: it never applies an
 * event payload to state. When the database says something about our
 * friendships or friend requests changed, we re-read through the same
 * authorized RPCs the panel already uses. That keeps RLS as the only thing
 * deciding what we can see, and means a malformed or unexpected payload can
 * never corrupt the friends list.
 *
 * Deliberately not presence. This subscribes to friendships and friend_requests
 * only.
 */

export type SyncStatus = 'idle' | 'connecting' | 'connected' | 'error'

export interface SocialChannelHandlers {
  /** Something changed; the owner should re-read. */
  onEvent: () => void
  onStatus: (status: SyncStatus) => void
}

export interface SocialChannel {
  /** Opens a subscription for one user. Resolves to a close function. */
  open(userId: string, handlers: SocialChannelHandlers): Promise<() => void>
}

export interface SocialSyncDeps {
  channel: SocialChannel
  /** Called (debounced) whenever the social graph may have changed. */
  onInvalidate: () => void
  /** Collapses a burst of related row changes into one re-read. */
  debounceMs?: number
  /** Backoff schedule for reconnecting; the last entry repeats. */
  retryDelaysMs?: number[]
  /** Connection state changes, for diagnostics. Carries no user data. */
  onStatusChange?: (status: SyncStatus) => void
  onError?: (context: string, error: unknown) => void
}

export interface SocialSync {
  /** Idempotent: starting an already-running sync for the same user does nothing. */
  start(userId: string): void
  stop(): void
  isRunning(): boolean
  getStatus(): SyncStatus
  /** Which user the current subscription belongs to, if any. */
  getUserId(): string | null
}

const DEFAULT_DEBOUNCE_MS = 250
const DEFAULT_RETRIES_MS = [1_000, 2_000, 5_000, 15_000, 30_000]

export function createSocialSync(deps: SocialSyncDeps): SocialSync {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const retries = deps.retryDelaysMs ?? DEFAULT_RETRIES_MS

  let userId: string | null = null
  let status: SyncStatus = 'idle'
  let close: (() => void) | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryIndex = 0

  /**
   * Guards against a slow open() resolving after we have moved on - stopped,
   * or restarted for a different user. Without it a stale subscription could
   * be adopted, which is exactly how duplicate subscriptions happen.
   */
  let generation = 0

  function clearTimers(): void {
    clearTimeout(debounceTimer)
    clearTimeout(retryTimer)
    debounceTimer = undefined
    retryTimer = undefined
  }

  function invalidateSoon(): void {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      deps.onInvalidate()
    }, debounceMs)
  }

  function scheduleRetry(forUserId: string, forGeneration: number): void {
    const delay = retries[Math.min(retryIndex, retries.length - 1)]
    retryIndex += 1
    clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      if (generation !== forGeneration) return
      openFor(forUserId, forGeneration)
    }, delay)
  }

  function openFor(forUserId: string, forGeneration: number): void {
    status = 'connecting'

    deps.channel
      .open(forUserId, {
        onEvent: () => {
          if (generation !== forGeneration) return
          invalidateSoon()
        },
        onStatus: (next) => {
          if (generation !== forGeneration) return
          if (next !== status) deps.onStatusChange?.(next)
          status = next
          if (next === 'connected') {
            retryIndex = 0
            // A reconnect may have missed events while the socket was down,
            // so treat coming back as a reason to re-read.
            invalidateSoon()
          }
          if (next === 'error') {
            closeCurrent()
            scheduleRetry(forUserId, forGeneration)
          }
        },
      })
      .then((closeFn) => {
        if (generation !== forGeneration) {
          // We were stopped or restarted while opening; drop this one.
          closeFn()
          return
        }
        close = closeFn
      })
      .catch((error: unknown) => {
        if (generation !== forGeneration) return
        deps.onError?.('socialSync.open', error)
        status = 'error'
        scheduleRetry(forUserId, forGeneration)
      })
  }

  function closeCurrent(): void {
    if (!close) return
    try {
      close()
    } catch (error) {
      deps.onError?.('socialSync.close', error)
    }
    close = null
  }

  return {
    start(nextUserId: string): void {
      if (userId === nextUserId && status !== 'idle') return

      // Switching users must never leave the previous subscription open.
      generation += 1
      clearTimers()
      closeCurrent()
      retryIndex = 0

      userId = nextUserId
      openFor(nextUserId, generation)
    },

    stop(): void {
      generation += 1
      clearTimers()
      closeCurrent()
      userId = null
      status = 'idle'
      retryIndex = 0
    },

    isRunning: () => status !== 'idle',
    getStatus: () => status,
    getUserId: () => userId,
  }
}
