import type { AsyncStorageArea } from './storage'

/**
 * What Kickback thinks is worth your attention, and what you have already seen.
 *
 * Deliberately small. It models "here are the things currently worth noticing"
 * plus "here is what has been seen", and derives unread from the difference.
 * That is enough for friend requests and gatherings today, and group unread
 * counts drop in later as another kind - without a notification framework.
 *
 * Two properties matter:
 *
 *   - A key identifies a *thing*, not an event. A gathering on lirik is
 *     `gathering:lirik` for as long as it lasts, so it is unread once rather
 *     than once per presence update.
 *   - Seen keys are pruned when the thing goes away. When that lirik gathering
 *     ends, its key is forgotten, so a new gathering there later is unread
 *     again rather than permanently dismissed.
 */

export type AttentionKind = 'friend_request' | 'gathering' | 'group_invite' | 'group_unread'

export interface AttentionItem {
  /** Stable while the thing exists; reused only for the same thing. */
  key: string
  kind: AttentionKind
  /** People involved - requests are 1, gatherings are the friend count. */
  count: number
}

export interface AttentionState {
  items: AttentionItem[]
  unread: AttentionItem[]
  /** Distinct things unseen. Not a sum, so one busy gathering is one badge. */
  unreadCount: number
}

export const EMPTY_ATTENTION: AttentionState = { items: [], unread: [], unreadCount: 0 }

const STORAGE_KEY = 'kickback:attention:seen'

export interface AttentionServiceDeps {
  storage?: AsyncStorageArea
  onError?: (context: string, error: unknown) => void
}

export interface AttentionService {
  getState(): AttentionState
  subscribe(listener: (state: AttentionState) => void): () => void
  /** Load persisted seen keys. Survives SPA navigation and worker restarts. */
  hydrate(): Promise<void>
  /** Replace the current attention-worthy set. */
  setItems(items: AttentionItem[]): void
  markSeen(keys: string[]): void
  /** Mark everything of one kind seen - "the user looked at the requests". */
  markKindSeen(kind: AttentionKind): void
  /** Sign-out: forget everything, including what was seen. */
  clear(): void
}

export function gatheringKey(channel: string): string {
  return `gathering:${channel.toLowerCase()}`
}

export function friendRequestKey(requestId: string): string {
  return `friend_request:${requestId}`
}

export function groupInviteKey(inviteId: string): string {
  return `group_invite:${inviteId}`
}

/**
 * Keyed by group and by the newest message seen in it, so the key changes
 * exactly when there is something new - and reverts to "seen" once read.
 */
export function groupUnreadKey(groupId: string): string {
  return `group_unread:${groupId}`
}

export function createAttentionService(deps: AttentionServiceDeps = {}): AttentionService {
  const listeners = new Set<(state: AttentionState) => void>()
  let items: AttentionItem[] = []
  let seen = new Set<string>()
  let state: AttentionState = { ...EMPTY_ATTENTION }

  function recompute(): void {
    const unread = items.filter((item) => !seen.has(item.key))
    state = { items, unread, unreadCount: unread.length }
    for (const listener of listeners) listener(state)
  }

  function persist(): void {
    if (!deps.storage) return
    void deps.storage
      .set({ [STORAGE_KEY]: [...seen] })
      .catch((error: unknown) => deps.onError?.('attention.persist', error))
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener)
      listener(state)
      return () => {
        listeners.delete(listener)
      }
    },

    async hydrate() {
      if (!deps.storage) return
      try {
        const stored = await deps.storage.get(STORAGE_KEY)
        const value = stored[STORAGE_KEY]
        if (Array.isArray(value)) {
          seen = new Set(value.filter((entry): entry is string => typeof entry === 'string'))
          recompute()
        }
      } catch (error) {
        deps.onError?.('attention.hydrate', error)
      }
    },

    setItems(next: AttentionItem[]): void {
      items = next

      // Forget seen keys for things that no longer exist, so the same channel
      // gathering again later is genuinely new rather than pre-dismissed.
      const live = new Set(next.map((item) => item.key))
      let pruned = false
      for (const key of seen) {
        if (!live.has(key)) {
          seen.delete(key)
          pruned = true
        }
      }
      if (pruned) persist()

      recompute()
    },

    markSeen(keys: string[]): void {
      let changed = false
      for (const key of keys) {
        if (!seen.has(key)) {
          seen.add(key)
          changed = true
        }
      }
      if (!changed) return
      persist()
      recompute()
    },

    markKindSeen(kind: AttentionKind): void {
      this.markSeen(items.filter((item) => item.kind === kind).map((item) => item.key))
    },

    clear(): void {
      items = []
      seen = new Set()
      persist()
      recompute()
    },
  }
}
