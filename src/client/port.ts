import { INITIAL_STATE } from './types'
import type {
  KickbackClient,
  KickbackState,
  SearchResult,
  SendRequestOutcome,
} from './types'
import { PORT_NAME, isWorkerMessage } from './messages'
import type { ClientMessage, RpcMethod } from './messages'

/**
 * The production client: a thin proxy from a Twitch tab to the service worker.
 *
 * It holds no session and performs no network calls. If the worker has been
 * shut down, connecting wakes it, so a dropped port is routine rather than an
 * error - we simply reconnect, and any request that was in flight is rejected
 * so the UI can recover instead of hanging on a promise that will never settle.
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
      failPending('Kickback lost its connection. Try again.')
      scheduleReconnect()
    })

    send({ type: 'hello' })
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
          reject(new Error('Kickback is not connected. Try again.'))
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
        reject(new Error('Kickback is not connected. Try again.'))
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
          failPending('Kickback panel closed.')
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
    refreshFriends: async () => {
      await rpc('refreshFriends')
    },

    reportActivity: (channel, visible) => send({ type: 'activity', channel, visible }),
    markSeen: (keys) => send({ type: 'seen', keys }),
    markKindSeen: (kind) => send({ type: 'seen', kind }),
    setPreferences: async (patch) => {
      await rpc('setPreferences', patch)
    },
    setPresenceVisibility: async (mode) => {
      await rpc('setPresenceVisibility', mode)
    },
  }
}
