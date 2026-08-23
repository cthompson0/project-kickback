import { INITIAL_STATE } from './types'
import type { KickbackClient, KickbackState } from './types'
import { PORT_NAME, isWorkerMessage } from './messages'
import type { ClientMessage } from './messages'

/**
 * The production client: a thin proxy from a Twitch tab to the service worker.
 *
 * It holds no session and performs no network calls. If the worker has been
 * shut down, connecting wakes it, so a dropped port is routine rather than an
 * error - we simply reconnect.
 */

const RECONNECT_DELAY_MS = 500
const MAX_RECONNECT_DELAY_MS = 10_000

export function createPortClient(): KickbackClient {
  const listeners = new Set<(state: KickbackState) => void>()
  let state: KickbackState = { ...INITIAL_STATE }
  let port: chrome.runtime.Port | null = null
  let reconnectDelay = RECONNECT_DELAY_MS
  let disposed = false

  const setState = (next: KickbackState) => {
    state = next
    for (const listener of listeners) listener(state)
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
      if (isWorkerMessage(message)) setState(message.state)
    })

    port.onDisconnect.addListener(() => {
      port = null
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
          port?.disconnect()
          port = null
        }
      }
    },
    signIn: () => send({ type: 'signIn' }),
    signOut: () => send({ type: 'signOut' }),
    retry: () => send({ type: 'retry' }),
  }
}
