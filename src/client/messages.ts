import type { KickbackState } from './types'
import type { AnalyticsEventName, AnalyticsSurface, AnalyticsValue } from '../core/analytics'
import type { LiveState } from '../core/twitchMetadata'

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
  | 'blockUser'
  | 'unblockUser'
  | 'refreshFriends'
  | 'setPresenceVisibility'
  | 'setPreferences'
  | 'createGroup'
  | 'renameGroup'
  | 'deleteGroup'
  | 'inviteToGroup'
  | 'respondToGroupInvite'
  | 'leaveGroup'
  | 'removeGroupMember'
  | 'sendGroupMessage'
  | 'setGroupMuted'
  | 'cancelGroupInvite'
  | 'setGroupIcon'
  | 'searchEmotes'

/** Tab -> worker. */
export type ClientMessage =
  | { type: 'hello' }
  | { type: 'signIn' }
  | { type: 'signOut' }
  | { type: 'retry' }
  /** What this tab is looking at. Sent on connect and on every change. */
  | {
      type: 'activity'
      channel: string | null
      visible: boolean
      /** Twitch's own capitalisation, read off the page title. */
      channelName?: string | null
    }
  /** The user has looked at these things; clear their unread state. */
  | {
      type: 'seen'
      keys?: string[]
      kind?: 'friend_request' | 'gathering' | 'group_invite' | 'group_unread'
    }
  /** The user is reading this group; clear its unread. */
  | { type: 'groupRead'; groupId: string }
  /**
   * A Together reaction, on whatever channel the worker knows this user is on.
   *
   * Fire-and-forget like activity rather than an RPC: there is no answer worth
   * waiting for, and nothing is drawn optimistically - the sender sees their
   * own reaction arrive back through the same realtime path everyone else
   * does, so there is exactly one way for one to appear.
   */
  | { type: 'reaction'; reaction: string }
  /**
   * An ephemeral room message, on whatever channel the worker knows this
   * user is on.
   *
   * Fire-and-forget for the same reason a reaction is: nothing is drawn
   * optimistically, so the sender's own copy arrives back through the same
   * inbox as everybody else's and there is exactly one way for a message to
   * appear. The channel is not a parameter - the worker owns which one is
   * eligible, and a client that could name one could talk into a room it is
   * not in.
   */
  | { type: 'roomMessage'; body: string }
  /** The viewer opened, or left, the contextual stream session. */
  | { type: 'selectSession'; channel: string | null }
  /** Mute or unmute somebody. Local to this browser; never sent onwards. */
  | { type: 'mute'; userId: string; muted: boolean }
  /*
   * ------------------------------------------------------------- analytics
   *
   * Three messages, and all three are one-way. Analytics never uses the RPC
   * path, because an RPC has a reply the caller can wait on, and nothing about
   * measurement may ever be something a product action waits for.
   */
  /** A product event the panel observed. The worker fills in session and build. */
  | {
      type: 'analytics'
      name: AnalyticsEventName
      properties?: Record<string, AnalyticsValue>
      source?: AnalyticsSurface
      channel?: string | null
    }
  /**
   * A JOIN was clicked. Separate from 'analytics' because the worker mints the
   * attribution that arrival is matched against, and because facts like "were
   * they already on Twitch" are the worker's to know, not the tab's.
   */
  | {
      type: 'join'
      channel: string
      source: AnalyticsSurface
      /** How many people the surface was showing on that channel. */
      socialCount: number
      /** False when the click was a no-op because it is the current channel. */
      navigated: boolean
    }
  /**
   * Everything socially meaningful currently VISIBLE in the open panel.
   *
   * Sent as a whole set rather than as individual impressions, as often as the
   * panel likes. Turning that into events - once each, not once per render -
   * is exposure.ts's job, in the worker, where there is one copy of the rule.
   */
  | {
      type: 'exposure'
      friends: Array<{
        userId: string
        channel: string
        state: 'watching_with_you' | 'watching_elsewhere'
      }>
      gatherings: Array<{ channel: string; friendCount: number; rank: number }>
      /**
       * Social Gravity destinations, in rank order.
       *
       * The opportunity key is deliberately NOT sent. The worker derives it
       * when it emits, from the channel and the clock, so an impression and
       * the JOIN that follows it cannot disagree about which opportunity they
       * were - and so nothing about the cluster's membership has to travel.
       */
      gravity: Array<{
      channel: string
      friendCount: number
      rank: number
      /** Whether Twitch said the destination was streaming. */
      live?: LiveState
    }>
    }
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
