import { createAuthService } from './auth'
import { createSupabaseBackend, createSupabaseClient } from './supabaseBackend'
import { createExtensionStorage } from './storage'
import { PORT_NAME } from '../client/messages'
import type { ClientMessage, WorkerMessage } from '../client/messages'
import type { KickbackState } from '../client/types'

/**
 * Kickback's service worker: the one place that holds a session and talks to
 * Supabase. Twitch tabs connect over a port and receive state; they never see a
 * token.
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

const auth = createAuthService({
  backend: createSupabaseBackend(supabase),
  launchWebAuthFlow: (url) =>
    chrome.identity.launchWebAuthFlow({ url, interactive: true }).then((redirectedTo) => {
      if (!redirectedTo) throw new Error('Sign-in window closed')
      return redirectedTo
    }),
  redirectUrl: chrome.identity.getRedirectURL(),
  // Never log the error object itself - Supabase errors can quote the request.
  onError: (context, error) => {
    console.warn(`[Kickback] ${context} failed:`, error instanceof Error ? error.message : error)
  },
})

// ------------------------------------------------------------------ tabs

const ports = new Set<chrome.runtime.Port>()

function broadcast(state: KickbackState): void {
  const message: WorkerMessage = { type: 'state', state }
  for (const port of ports) {
    try {
      port.postMessage(message)
    } catch {
      ports.delete(port)
    }
  }
}

auth.subscribe(broadcast)

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return

  ports.add(port)
  port.postMessage({ type: 'state', state: auth.getState() } satisfies WorkerMessage)

  port.onMessage.addListener((raw: ClientMessage) => {
    switch (raw?.type) {
      case 'hello':
        port.postMessage({ type: 'state', state: auth.getState() } satisfies WorkerMessage)
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
