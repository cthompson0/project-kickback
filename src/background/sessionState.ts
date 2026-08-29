import { describePresence } from '../core/personPresence'
import type { Activity, Presence } from '../core/types'
import type { RoomMessage } from '../core/roomMessages'
import { unreadCount } from '../core/roomMessages'

/**
 * What the viewer's own session is, derived rather than remembered.
 *
 * These five questions decide whether a Stream Room exists, who is in it, and
 * what is unread. Every one of them was answered inline in the service worker,
 * which is the one module that cannot be imported by a test - so the only way
 * they were ever protected was by string-matching the worker's source. That
 * broke once on a CRLF checkout, and it can never assert what the functions
 * actually DO.
 *
 * Pure functions over explicit inputs, so the awkward cases - published but no
 * longer open, open but not yet published, a room kept alive only by its
 * conversation - are ordinary tests.
 *
 * NOTHING HERE REINTERPRETS PRESENCE. `describePresence` and `unreadCount` are
 * the same functions the panel uses; this only decides which channels to ask
 * about.
 */

/**
 * The channel the viewer is on AND has successfully published.
 *
 * A channel is only a room once the WRITE has landed: `stream_room_members`
 * refuses unless the caller's own presence puts them there, so asking before
 * that is true returns a correct, empty, and permanently cached answer. That
 * was the bug that once made a page load resolve to nothing.
 *
 * Asked of the PUBLISHED destination set, which is literally what the server
 * holds - not of the last written activity, which under multi-destination
 * names only the most recently written channel.
 */
export function sessionChannelOf(
  here: string | null,
  published: readonly string[],
): string | null {
  if (!here) return null
  return published.includes(here) ? here : null
}

/**
 * Every destination the viewer has open AND has published.
 *
 * The multi-destination counterpart, applying the same rule for the same
 * reason. Ordered by the published set, because that order is the server's.
 */
export function openSessionChannels(
  open: readonly string[],
  published: readonly string[],
): string[] {
  const openSet = new Set(open)
  return published.filter((channel) => openSet.has(channel))
}

/**
 * Direct friends whose presence puts them here with the viewer, right now.
 *
 * THIS IS WHAT MAKES A SESSION AVAILABLE, AND WHY IT IS NOT THE RPC.
 *
 * Authenticated realtime presence already proves a friend is on this
 * destination - the same evidence the HERE card draws "1 friend watching with
 * you" from. Waiting for `stream_room_members` to rediscover it costs a round
 * trip, and every one of the arrival failures happened inside that trip.
 *
 * The server stays authoritative for everything that MATTERS: who receives a
 * message, who receives a reaction, and which friends-of-friends are in the
 * component. The client never invents membership - it only declines to pretend
 * it does not already know about a direct friend it can see.
 */
export function peersOnChannel(input: {
  channel: string
  presence: Readonly<Record<string, Presence>>
  friendIds: ReadonlySet<string>
  selfId: string | null
}): string[] {
  const viewer: Activity = { type: 'watching', platform: 'twitch', channel: input.channel }

  const peers: string[] = []
  for (const [userId, presence] of Object.entries(input.presence)) {
    if (userId === input.selfId || !input.friendIds.has(userId)) continue
    if (describePresence(presence, viewer).kind === 'watching_with_you') peers.push(userId)
  }
  return peers.sort()
}

/**
 * Whether a remembered session is still worth restoring.
 *
 * Three kinds of evidence, any one of which is enough: the server said
 * somebody is in the room, presence says a friend is here, or the conversation
 * itself is still on screen. The third is what supersedes the temporary Patch 1
 * rule - a room stays restorable for exactly as long as its messages live, and
 * not one moment longer, with no new lease and no new clock.
 */
export function restoredSessionChannel(input: {
  remembered: string | null
  here: string | null
  members: readonly unknown[]
  peers: readonly string[]
  messages: readonly RoomMessage[]
}): string | null {
  const { remembered } = input
  if (!remembered) return null
  // Only the channel the viewer is actually on can be restored; a remembered
  // session for somewhere else is somebody else's room now.
  if (remembered !== input.here) return null

  const live =
    input.members.length > 0 ||
    input.peers.length > 0 ||
    input.messages.some((message) => message.channel === remembered)
  return live ? remembered : null
}

/**
 * Messages waiting, per destination.
 *
 * Keyed by channel because unread is a fact about a conversation, and a viewer
 * with two rooms open has two of them. Computed over every channel that has
 * retained messages as well as the open ones, so a room kept alive by its
 * conversation still shows a count.
 */
export function unreadByChannel(input: {
  messages: readonly RoomMessage[]
  open: readonly string[]
  readAt(channel: string): number
  selfId: string | null
}): Record<string, number> {
  const channels = new Set([...input.open, ...input.messages.map((message) => message.channel)])

  const out: Record<string, number> = {}
  for (const channel of channels) {
    out[channel] = unreadCount(input.messages, channel, input.readAt(channel), input.selfId)
  }
  return out
}
