import type { SyncStatus } from './socialSync'

/**
 * Live group chat and membership.
 *
 * Chat messages are applied directly - re-reading a conversation on every
 * message would be the pathological design. Membership and invite changes are
 * invalidation only, since they are rare and the group list is cheap.
 *
 * A realtime row carries the raw table shape, not the RPC shape: no display
 * name, no avatar. Rather than trust or fabricate those, the owner resolves
 * them from the member list it already has, and falls back to a re-read for a
 * sender it does not recognise.
 */

export interface RawChatMessage {
  id: string
  groupId: string
  userId: string
  body: string
  createdAt: string
}

export interface GroupChannelHandlers {
  onRawMessage: (message: RawChatMessage) => void
  onMembershipChanged: () => void
  onStatus: (status: SyncStatus) => void
}

export interface GroupChannel {
  open(
    groupIds: string[],
    userId: string,
    handlers: GroupChannelHandlers,
  ): Promise<() => void>
}

export interface GroupSyncDeps {
  channel: GroupChannel
  onRawMessage: (message: RawChatMessage) => void
  onMembershipChanged: () => void
  /** Fires on reconnect so the owner can re-read anything it missed. */
  onResync?: () => void
  retryDelaysMs?: number[]
  onStatusChange?: (status: SyncStatus) => void
  onError?: (context: string, error: unknown) => void
}

export interface GroupSync {
  /** Subscribe to exactly these groups. Idempotent for an unchanged set. */
  setGroups(userId: string, groupIds: string[]): void
  stop(): void
  getStatus(): SyncStatus
  getGroupIds(): string[]
}

const DEFAULT_RETRIES_MS = [1_000, 2_000, 5_000, 15_000, 30_000]

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index])

export function createGroupSync(deps: GroupSyncDeps): GroupSync {
  const retries = deps.retryDelaysMs ?? DEFAULT_RETRIES_MS

  let groupIds: string[] = []
  let currentUserId: string | null = null
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
      deps.onError?.('groupSync.close', error)
    }
    close = null
  }

  function scheduleRetry(userId: string, ids: string[], forGeneration: number): void {
    const delay = retries[Math.min(retryIndex, retries.length - 1)]
    retryIndex += 1
    clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      if (generation !== forGeneration) return
      openFor(userId, ids, forGeneration)
    }, delay)
  }

  function openFor(userId: string, ids: string[], forGeneration: number): void {
    status = 'connecting'

    deps.channel
      .open(ids, userId, {
        onRawMessage: (message) => {
          if (generation !== forGeneration) return
          deps.onRawMessage(message)
        },
        onMembershipChanged: () => {
          if (generation !== forGeneration) return
          deps.onMembershipChanged()
        },
        onStatus: (next) => {
          if (generation !== forGeneration) return
          if (next !== status) deps.onStatusChange?.(next)
          status = next
          if (next === 'connected') {
            retryIndex = 0
            deps.onResync?.()
          }
          if (next === 'error') {
            closeCurrent()
            scheduleRetry(userId, ids, forGeneration)
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
        deps.onError?.('groupSync.open', error)
        status = 'error'
        scheduleRetry(userId, ids, forGeneration)
      })
  }

  return {
    setGroups(userId: string, nextIds: string[]): void {
      const sorted = [...new Set(nextIds)].sort()
      if (currentUserId === userId && sameSet(sorted, groupIds) && status !== 'idle') return

      // Losing a group must tear the subscription down, not merely stop
      // rendering it - a stale binding would keep a removed member listening.
      generation += 1
      clearTimeout(retryTimer)
      retryTimer = undefined
      closeCurrent()
      retryIndex = 0

      groupIds = sorted
      currentUserId = userId

      // Membership itself must stay watched even with no groups, or an
      // invitation accepted elsewhere would never arrive.
      openFor(userId, sorted, generation)
    },

    stop(): void {
      generation += 1
      clearTimeout(retryTimer)
      retryTimer = undefined
      closeCurrent()
      groupIds = []
      currentUserId = null
      status = 'idle'
      retryIndex = 0
    },

    getStatus: () => status,
    getGroupIds: () => [...groupIds],
  }
}
