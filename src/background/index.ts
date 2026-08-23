import { createAuthService } from './auth'
import { createFriendsService } from './friends'
import {
  createSupabaseBackend,
  createSupabaseClient,
  createSupabaseFriendsBackend,
} from './supabaseBackend'
import { createExtensionStorage } from './storage'
import { PORT_NAME } from '../client/messages'
import type { ClientMessage, RpcMethod, WorkerMessage } from '../client/messages'
import type { KickbackState } from '../client/types'
import { INITIAL_STATE } from '../client/types'

/**
 * Kickback's service worker: the one place that holds a session and talks to
 * Supabase. Twitch tabs connect over a port and receive state; they never see a
 * token, and they never call the database themselves.
 *
 * MV3 workers are killed after ~30s idle, so nothing here may live only in
 * memory. The session is in chrome.storage.local, and an alarm brings the
 * worker back to refresh it.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

const REFRESH_ALARM = 'kickback:refresh-session'
const REFRESH_PERIOD_MINUTES = 30

const storage = createExtensionStorage({
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
})

// Startup diagnostic. Logs which project the worker is pointed at and how long
// the key is - never the key itself. A truncated key is otherwise invisible:
// it fails much later, as "Invalid API key" from the code exchange.
console.info(
  '[Kickback] worker starting',
  JSON.stringify({
    supabaseUrl: SUPABASE_URL,
    publishableKeyLength: SUPABASE_PUBLISHABLE_KEY?.length ?? 0,
    mode: import.meta.env.VITE_KICKBACK_MODE ?? 'production',
  }),
)

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  console.error(
    '[Kickback] missing Supabase configuration - copy .env.example to .env.local and rebuild',
  )
}

const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, storage)

const logError = (context: string, error: unknown) => {
  // Never log the error object itself - Supabase errors can quote the request.
  console.warn(`[Kickback] ${context} failed:`, error instanceof Error ? error.message : error)
}

const auth = createAuthService({
  backend: createSupabaseBackend(supabase),
  launchWebAuthFlow: (url) =>
    chrome.identity.launchWebAuthFlow({ url, interactive: true }).then((redirectedTo) => {
      if (!redirectedTo) throw new Error('Sign-in window closed')
      return redirectedTo
    }),
  redirectUrl: chrome.identity.getRedirectURL(),
  onError: logError,
})

const friends = createFriendsService({
  backend: createSupabaseFriendsBackend(supabase),
  onError: logError,
})

// ------------------------------------------------------------------- state

let authState = auth.getState()
let friendsState = friends.getState()

const ports = new Set<chrome.runtime.Port>()

/**
 * One state object out of two services. Friends come last so their real data
 * wins, but they are cleared whenever auth is not healthy - so a signed-out or
 * erroring panel can never still be showing a friends list.
 */
function currentState(): KickbackState {
  return { ...INITIAL_STATE, ...authState, ...friendsState }
}

function broadcast(): void {
  const message: WorkerMessage = { type: 'state', state: currentState() }
  for (const port of ports) {
    try {
      port.postMessage(message)
    } catch {
      ports.delete(port)
    }
  }
}

let lastStatus = authState.status

auth.subscribe((next) => {
  authState = next

  if (next.status === 'signed_in') {
    // Only load on the transition, not on every unrelated auth update.
    if (lastStatus !== 'signed_in') void friends.refresh()
  } else {
    friends.clear()
  }

  lastStatus = next.status
  broadcast()
})

friends.subscribe((next) => {
  friendsState = next
  broadcast()
})

// --------------------------------------------------------------------- rpc

const RPC_HANDLERS: Record<RpcMethod, (args: unknown[]) => Promise<unknown>> = {
  searchUsers: ([query]) => friends.search(String(query ?? '')),
  sendFriendRequest: ([userId]) => friends.sendRequest(String(userId)),
  respondToFriendRequest: ([requestId, accept]) =>
    friends.respond(String(requestId), accept === true),
  cancelFriendRequest: ([requestId]) => friends.cancel(String(requestId)),
  removeFriend: ([userId]) => friends.remove(String(userId)),
  refreshFriends: () => friends.refresh(),
}

async function handleRpc(port: chrome.runtime.Port, message: ClientMessage): Promise<void> {
  if (message.type !== 'rpc') return

  const handler = RPC_HANDLERS[message.method]
  const reply = (result: WorkerMessage) => {
    try {
      port.postMessage(result)
    } catch {
      ports.delete(port)
    }
  }

  if (!handler) {
    reply({ type: 'rpcResult', callId: message.callId, ok: false, error: 'Unknown request' })
    return
  }

  // Friend operations require a live session; refreshing first means a request
  // made just after the token expired succeeds instead of failing confusingly.
  const signedIn = await auth.ensureFreshSession()
  if (!signedIn) {
    reply({
      type: 'rpcResult',
      callId: message.callId,
      ok: false,
      error: 'Your Kickback session ended. Sign in again.',
    })
    return
  }

  try {
    const value = await handler(message.args)
    reply({ type: 'rpcResult', callId: message.callId, ok: true, value: value ?? null })
  } catch (error) {
    reply({
      type: 'rpcResult',
      callId: message.callId,
      ok: false,
      error: error instanceof Error ? error.message : 'Something went wrong',
    })
  }
}

// -------------------------------------------------------------------- tabs

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return

  ports.add(port)
  port.postMessage({ type: 'state', state: currentState() } satisfies WorkerMessage)

  port.onMessage.addListener((raw: ClientMessage) => {
    switch (raw?.type) {
      case 'hello':
        port.postMessage({ type: 'state', state: currentState() } satisfies WorkerMessage)
        break
      case 'signIn':
        void auth.signIn()
        break
      case 'signOut':
        void auth.signOut()
        break
      case 'retry':
        void auth.retry()
        break
      case 'rpc':
        void handleRpc(port, raw)
        break
    }
  })

  port.onDisconnect.addListener(() => {
    ports.delete(port)
  })
})

// -------------------------------------------------------------- lifecycle

chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_PERIOD_MINUTES })

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) void auth.ensureFreshSession()
})

chrome.runtime.onStartup.addListener(() => {
  void auth.initialize()
})

chrome.runtime.onInstalled.addListener(() => {
  void auth.initialize()
})

// The worker is also revived by a tab connecting or an alarm firing, and each
// revival re-runs this module - so initialising here covers every wake-up.
void auth.initialize()
