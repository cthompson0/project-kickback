import type { Presence } from '../core/types'
import type { SyncStatus } from './socialSync'

/**
 * Friends' presence, live.
 *
 * Unlike the social-graph channel this one applies payloads directly. Presence
 * is high-frequency, and re-reading every friend on every channel change would
 * turn one person navigating into a query per friend per hop.
 *
 * That is safe here because the subscription is pinned per friend: one binding
 * per friend id, so the server only ever sends rows this user is entitled to.
 * That also closes the DELETE hole found in Checkpoint 4.1 - Supabase does not
 * apply RLS to delete events, and a `presence` delete carries the user_id -
 * without the filters we would receive deletions for people we do not know.
 */

export interface PresenceChannelHandlers {
  /** A friend's presence row changed. */
  onPresence: (presence: Presence) => void
  /** A friend's presence row went away; treat as offline. */
  onPresenceGone: (userId: string) => void
  onStatus: (status: SyncStatus) => void
}

export interface PresenceChannel {
  /** Subscribes to exactly these friends. Resolves to a close function. */
  open(friendIds: string[], handlers: PresenceChannelHandlers): Promise<() => void>
}

export interface PresenceSyncDeps {
  channel: PresenceChannel
  onPresence: (presence: Presence) => void
  onPresenceGone: (userId: string) => void
  /** Called when the socket comes back, so the caller can re-read a fresh list. */
  onResync?: () => void
  retryDelaysMs?: number[]
  onStatusChange?: (status: SyncStatus) => void
  onError?: (context: string, error: unknown) => void
}

export interface PresenceSync {
  /**
   * Subscribe to exactly this set of friends. Idempotent for an unchanged set,
   * so a friends-list refresh that changed nothing does not churn the socket.
   */
  setFriends(friendIds: string[]): void
  stop(): void
  getStatus(): SyncStatus
  /** The friend set currently subscribed, sorted. */
  getFriendIds(): string[]
}

const DEFAULT_RETRIES_MS = [1_000, 2_000, 5_000, 15_000, 30_000]

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index])

export function createPresenceSync(deps: PresenceSyncDeps): PresenceSync {
  const retries = deps.retryDelaysMs ?? DEFAULT_RETRIES_MS

  let friendIds: string[] = []
  let status: SyncStatus = 'idle'
  let close: (() => void) | null = null
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryIndex = 0
  let generation = 0

  function closeCurrent(): void {
    if (!close) return
    try {
      close()
    } catch (error) {
      deps.onError?.('presenceSync.close', error)
    }
    close = null
  }

  function scheduleRetry(ids: string[], forGeneration: number): void {
    const delay = retries[Math.min(retryIndex, retries.length - 1)]
    retryIndex += 1
    clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      if (generation !== forGeneration) return
      openFor(ids, forGeneration)
    }, delay)
  }

  function openFor(ids: string[], forGeneration: number): void {
    if (ids.length === 0) {
      status = 'idle'
      return
    }

    status = 'connecting'

    deps.channel
      .open(ids, {
        onPresence: (presence) => {
          if (generation !== forGeneration) return
          deps.onPresence(presence)
        },
        onPresenceGone: (userId) => {
          if (generation !== forGeneration) return
          deps.onPresenceGone(userId)
        },
        onStatus: (next) => {
          if (generation !== forGeneration) return
          if (next !== status) deps.onStatusChange?.(next)
          status = next
          if (next === 'connected') {
            retryIndex = 0
            // Anything that changed while the socket was down was missed, so
            // ask the owner for a fresh read rather than assuming continuity.
            deps.onResync?.()
          }
          if (next === 'error') {
            closeCurrent()
            scheduleRetry(ids, forGeneration)
          }
        },
      })
      .then((closeFn) => {
        if (generation !== forGeneration) {
          closeFn()
          return
        }
        close = closeFn
      })
      .catch((error: unknown) => {
        if (generation !== forGeneration) return
        deps.onError?.('presenceSync.open', error)
        status = 'error'
        scheduleRetry(ids, forGeneration)
      })
  }

  return {
    setFriends(nextIds: string[]): void {
      const sorted = [...new Set(nextIds)].sort()
      if (sameSet(sorted, friendIds) && status !== 'idle') return

      generation += 1
      clearTimeout(retryTimer)
      retryTimer = undefined
      closeCurrent()
      retryIndex = 0

      friendIds = sorted
      openFor(sorted, generation)
    },

    stop(): void {
      generation += 1
      clearTimeout(retryTimer)
      retryTimer = undefined
      closeCurrent()
      friendIds = []
      status = 'idle'
      retryIndex = 0
    },

    getStatus: () => status,
    getFriendIds: () => [...friendIds],
  }
}
