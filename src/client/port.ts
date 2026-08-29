import { INITIAL_STATE } from './types'
import type {
  EmoteSection,
  KickbackClient,
  KickbackState,
  SearchResult,
  SendRequestOutcome,
} from './types'
import { PORT_NAME, isWorkerMessage } from './messages'
import type { EarnedBadge, FriendSuggestion } from '../background/supabaseBackend'
import type { ClientMessage, RpcMethod } from './messages'

/**
 * The production client: a thin proxy from a Twitch tab to the service worker.
 *
 * It holds no session and performs no network calls. If the worker has been
 * shut down, connecting wakes it, so a dropped port is routine rather than an
 * error - we simply reconnect, and any request that was in flight is rejected
 * so the UI can recover instead of hanging on a promise that will never settle.
 *
 * A DROPPED PORT LOSES THE WORKER'S MEMORY OF THIS TAB
 *
 * That is the part that is easy to miss, and it is why `reportActivity` is
 * replayed below. An MV3 service worker is evicted routinely - roughly thirty
 * seconds after it goes quiet - and eviction destroys its module scope, which
 * is where the tab registry lives. Every port then disconnects and every tab
 * reconnects here, transparently.
 *
 * Reconnecting is not enough. The worker learns which channel a tab is on from
 * one `activity` message, and the content script only sends that on mount, on
 * navigation, on visibilitychange, on pageshow and when the title settles - so
 * a tab sitting quietly in the background sends nothing, and the revived worker
 * never finds out it exists. With three streams open, only the tab the user
 * touched next was known, and multi-destination presence published exactly one
 * destination however many were open.
 *
 * So the last activity is remembered and re-sent on every connect. The tab is
 * the authority on what it is showing; the worker is entitled to ask again by
 * simply losing its memory.
 */

const RECONNECT_DELAY_MS = 500
const MAX_RECONNECT_DELAY_MS = 10_000

interface PendingCall {
  resolve(value: unknown): void
  reject(error: Error): void
}

export function createPortClient(): KickbackClient {
  const listeners = new Set<(state: KickbackState) => void>()
  const pending = new Map<number, PendingCall>()
  let state: KickbackState = { ...INITIAL_STATE }
  let port: chrome.runtime.Port | null = null
  let reconnectDelay = RECONNECT_DELAY_MS
  let nextCallId = 1
  let disposed = false
  /**
   * The last thing this tab told the worker it was showing.
   *
   * Durable per-tab state, unlike every other message here, which is an event.
   * Replayed on connect so a revived worker rebuilds the whole tab registry
   * rather than only the tabs that happen to move next.
   */
  let lastActivity: ClientMessage | null = null

  const setState = (next: KickbackState) => {
    state = next
    for (const listener of listeners) listener(state)
  }

  function failPending(reason: string): void {
    for (const call of pending.values()) call.reject(new Error(reason))
    pending.clear()
  }

  function connect(): void {
    if (disposed) return

    try {
      port = chrome.runtime.connect({ name: PORT_NAME })
    } catch {
      // Happens while the extension is being reloaded during development.
      scheduleReconnect()
      return
    }

    reconnectDelay = RECONNECT_DELAY_MS

    port.onMessage.addListener((message: unknown) => {
      if (!isWorkerMessage(message)) return

      if (message.type === 'state') {
        setState(message.state)
        return
      }

      const call = pending.get(message.callId)
      if (!call) return
      pending.delete(message.callId)
      if (message.ok) call.resolve(message.value)
      else call.reject(new Error(message.error))
    })

    port.onDisconnect.addListener(() => {
      port = null
      failPending('Watchside lost its connection. Try again.')
      scheduleReconnect()
    })

    send({ type: 'hello' })
    /*
     * And say where we are again, because the worker has forgotten.
     *
     * After `hello`, so the state snapshot the worker sends back is not racing
     * a registry update. Skipped on the very first connect only because there
     * is nothing to replay yet - the content script's own first report follows
     * a moment later.
     */
    if (lastActivity) send(lastActivity)
  }

  function scheduleReconnect(): void {
    if (disposed) return
    setTimeout(connect, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS)
  }

  function send(message: ClientMessage): void {
    if (!port) {
      connect()
      return
    }
    try {
      port.postMessage(message)
    } catch {
      port = null
      scheduleReconnect()
    }
  }

  function rpc<T>(method: RpcMethod, ...args: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!port) {
        connect()
        if (!port) {
          reject(new Error('Watchside is not connected. Try again.'))
          return
        }
      }

      const callId = nextCallId++
      pending.set(callId, {
        resolve: (value) => resolve(value as T),
        reject,
      })

      try {
        port.postMessage({ type: 'rpc', callId, method, args })
      } catch {
        pending.delete(callId)
        port = null
        scheduleReconnect()
        reject(new Error('Watchside is not connected. Try again.'))
      }
    })
  }

  connect()

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener)
      listener(state)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          disposed = true
          failPending('Watchside panel closed.')
          port?.disconnect()
          port = null
        }
      }
    },

    signIn: () => send({ type: 'signIn' }),
    signOut: () => send({ type: 'signOut' }),
    retry: () => send({ type: 'retry' }),

    searchUsers: (query) => rpc<SearchResult[]>('searchUsers', query),
    sendFriendRequest: (userId) => rpc<SendRequestOutcome>('sendFriendRequest', userId),
    respondToFriendRequest: (requestId, accept) =>
      rpc<'accepted' | 'declined'>('respondToFriendRequest', requestId, accept),
    acceptFriendRequestFrom: (userId) => rpc<'accepted'>('acceptFriendRequestFrom', userId),
    cancelFriendRequest: async (requestId) => {
      await rpc('cancelFriendRequest', requestId)
    },
    removeFriend: async (userId) => {
      await rpc('removeFriend', userId)
    },
    blockUser: async (userId) => {
      await rpc('blockUser', userId)
    },
    unblockUser: async (userId) => {
      await rpc('unblockUser', userId)
    },
    submitFeedback: async (input) => {
      await rpc('submitFeedback', input)
    },
    refreshFriends: async () => {
      await rpc('refreshFriends')
    },

    reportActivity: (channel, visible, channelName) => {
      // Remembered before it is sent, so a report that arrives while the port
      // is down is still replayed the moment it comes back.
      lastActivity = { type: 'activity', channel, visible, channelName: channelName ?? null }
      send(lastActivity)
    },
    reportInvite: (code) => send({ type: 'invite', code }),
    sendReaction: (reaction, channel) => send({ type: 'reaction', reaction, channel }),
    sendRoomMessage: (body, channel) => send({ type: 'roomMessage', body, channel }),
    selectSession: (channel) => send({ type: 'selectSession', channel }),
    setUserMuted: (userId, muted) => send({ type: 'mute', userId, muted }),
    markSeen: (keys) => send({ type: 'seen', keys }),
    markKindSeen: (kind) => send({ type: 'seen', kind }),
    setPreferences: async (patch) => {
      await rpc('setPreferences', patch)
    },

    createGroup: (name, icon) => rpc<string>('createGroup', name, icon ?? null),
    setGroupIcon: async (groupId, icon) => {
      await rpc('setGroupIcon', groupId, icon)
    },
    renameGroup: async (groupId, name) => {
      await rpc('renameGroup', groupId, name)
    },
    deleteGroup: async (groupId) => {
      await rpc('deleteGroup', groupId)
    },
    inviteToGroup: (groupId, userId) => rpc<string>('inviteToGroup', groupId, userId),
    cancelGroupInvite: async (groupId, userId) => {
      await rpc('cancelGroupInvite', groupId, userId)
    },
    respondToGroupInvite: (inviteId, accept) =>
      rpc<string>('respondToGroupInvite', inviteId, accept),
    leaveGroup: async (groupId) => {
      await rpc('leaveGroup', groupId)
    },
    removeGroupMember: async (groupId, userId) => {
      await rpc('removeGroupMember', groupId, userId)
    },
    sendGroupMessage: async (groupId, body) => {
      await rpc('sendGroupMessage', groupId, body)
    },
    markGroupRead: (groupId) => send({ type: 'groupRead', groupId }),

    // Analytics. One-way, never awaited, and `send` already swallows a dead
    // port - so a worker being restarted costs an event, never an error.
    track: (name, properties, options) =>
      send({
        type: 'analytics',
        name,
        properties: properties as Record<string, never> | undefined,
        source: options?.source,
        channel: options?.channel ?? null,
      }),
    recordJoin: (input) => send({ type: 'join', ...input }),
    reportExposure: (report) => send({ type: 'exposure', ...report }),
    setGroupMuted: async (groupId, muted) => {
      await rpc('setGroupMuted', groupId, muted)
    },
    searchEmotes: (query) => rpc<EmoteSection[]>('searchEmotes', query),

    suggestFriends: () => rpc<FriendSuggestion[]>('suggestFriends'),
    inviteCode: () => rpc<string>('inviteCode'),
    claimInvite: (code) => rpc<string>('claimInvite', code),
    referralSummary: () => rpc<{ successful: number; pending: number }>('referralSummary'),
    badges: () => rpc<EarnedBadge[]>('badges'),
    setDisplayedBadge: async (key) => {
      await rpc('setDisplayedBadge', key)
    },
    setPresenceVisibility: async (mode) => {
      await rpc('setPresenceVisibility', mode)
    },
  }
}
