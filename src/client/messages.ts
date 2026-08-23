import type { KickbackState } from './types'

/**
 * Message protocol between a Twitch tab and the extension service worker.
 *
 * The tab never holds a session or talks to Supabase: content scripts cannot
 * use chrome.identity, their fetches are subject to the page's CORS, and there
 * can be several Twitch tabs at once. The worker is the single owner.
 */

export const PORT_NAME = 'kickback'

/** Tab -> worker. */
export type ClientMessage =
  | { type: 'hello' }
  | { type: 'signIn' }
  | { type: 'signOut' }
  | { type: 'retry' }

/** Worker -> tab. */
export type WorkerMessage = { type: 'state'; state: KickbackState }

export function isWorkerMessage(value: unknown): value is WorkerMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'state' &&
    typeof (value as { state?: unknown }).state === 'object'
  )
}
