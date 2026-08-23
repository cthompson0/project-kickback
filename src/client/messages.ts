import type { KickbackState } from './types'

/**
 * Message protocol between a Twitch tab and the extension service worker.
 *
 * The tab never holds a session or talks to Supabase: content scripts cannot
 * use chrome.identity, their fetches are subject to the page's CORS, and there
 * can be several Twitch tabs at once. The worker is the single owner.
 *
 * Two shapes travel over the port. State is pushed (one way, broadcast to every
 * tab). Friend operations are request/response, correlated by a call id, so the
 * tab that asked gets the answer and the others just see the resulting state.
 */

export const PORT_NAME = 'kickback'

/** Friend operations a tab may ask the worker to perform on its behalf. */
export type RpcMethod =
  | 'searchUsers'
  | 'sendFriendRequest'
  | 'respondToFriendRequest'
  | 'acceptFriendRequestFrom'
  | 'cancelFriendRequest'
  | 'removeFriend'
  | 'refreshFriends'
  | 'setPresenceVisibility'
  | 'setPreferences'

/** Tab -> worker. */
export type ClientMessage =
  | { type: 'hello' }
  | { type: 'signIn' }
  | { type: 'signOut' }
  | { type: 'retry' }
  /** What this tab is looking at. Sent on connect and on every change. */
  | { type: 'activity'; channel: string | null; visible: boolean }
  /** The user has looked at these things; clear their unread state. */
  | { type: 'seen'; keys?: string[]; kind?: 'friend_request' | 'gathering' }
  | { type: 'rpc'; callId: number; method: RpcMethod; args: unknown[] }

/** Worker -> tab. */
export type WorkerMessage =
  | { type: 'state'; state: KickbackState }
  | { type: 'rpcResult'; callId: number; ok: true; value: unknown }
  | { type: 'rpcResult'; callId: number; ok: false; error: string }

export function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as { type?: unknown; state?: unknown; callId?: unknown }
  if (message.type === 'state') return typeof message.state === 'object' && message.state !== null
  if (message.type === 'rpcResult') return typeof message.callId === 'number'
  return false
}
