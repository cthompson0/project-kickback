import { EMOTES, isEmoteOnly } from './emotes'
import type { KickbackEmote } from './emotes'
import { ACTIVITY_TTL_MS, liveReactions, reactionEmote } from './together'
import type { TogetherReaction } from './together'
import { activeCombo } from './combos'
import type { ComboMessage } from './combos'

/**
 * The conversation among the people watching this stream with you.
 *
 * WHY IT IS NOT GROUP CHAT
 *
 * Groups are intentional and durable: you create one, invite people, and the
 * conversation is still there tomorrow. This is the opposite on every axis,
 * and none of the difference is cosmetic:
 *
 *   * there is no room record and no room id - membership is the connected
 *     component the server computes on demand;
 *   * recipients are decided when the message is written, so a room that
 *     splits stops delivering and a room that merges never backfills;
 *   * rows are swept, so there is nothing to read tomorrow.
 *
 * WHY IT IS NOT A TRANSCRIPT, AND WHY IT IS NOT EIGHT SECONDS EITHER
 *
 * Reactions vanish in eight seconds because they are punctuation. A sentence
 * is not: a page refresh, a worker eviction, an ad break or getting a drink
 * must not destroy what people were saying to each other. Thirty minutes
 * covers all of those with margin and is still short enough that nobody
 * mistakes it for history.
 *
 * The clock alone would not be safe, though. Retention cost is
 * messages x recipients and a room holds up to fifty people, so the row cap
 * below is what actually bounds a fast conversation. Both are enforced by the
 * server on every write; the constants here exist so the client agrees about
 * what it is looking at.
 */

/**
 * One message, as it was addressed to this viewer.
 *
 * There is no `roomId` and there will not be one. The identity of a room is
 * (destination, current connected component), which is a thing you compute,
 * not a thing you store - see 0021 for why that is also the security model.
 */
export interface RoomMessage {
  /** The row id. Different per recipient; unique within one client. */
  id: string
  senderId: string
  /** Canonical lowercase login it was sent on. */
  channel: string
  body: string
  /** Epoch ms, from the server, so everybody orders them the same way. */
  at: number
}

/** As long as a message is worth keeping. Matches the sweep in 0021. */
export const RETENTION_MS = 30 * 60_000

/** As many as one inbox keeps per channel. Matches the cap in 0021. */
export const MAX_MESSAGES = 200

/**
 * As long as a message may be, in characters.
 *
 * Suits the medium - this is something you say during a play, not a post - and
 * it nearly halves the worst-case fan-out storage the row cap protects. The
 * server enforces the same number; this one is so the composer can stop you
 * before the round trip rather than after it.
 */
export const MAX_MESSAGE_LENGTH = 280

/**
 * Validate a message row.
 *
 * Parsed rather than cast, because it arrives over realtime from a table other
 * people write to. A row that does not validate is dropped entirely - which
 * keeps anything malformed off somebody's screen even if the server's own
 * checks were ever loosened.
 */
export function parseRoomMessage(value: unknown): RoomMessage | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>

  const id = raw.id
  const senderId = raw.sender_id
  const channel = raw.channel
  const body = raw.body
  const at = raw.created_at

  if (typeof id !== 'string' || typeof senderId !== 'string') return null
  if (typeof channel !== 'string' || !/^[a-z0-9_]{3,25}$/.test(channel)) return null
  if (typeof body !== 'string' || body.length === 0 || body.length > MAX_MESSAGE_LENGTH) return null

  const time = typeof at === 'string' ? Date.parse(at) : NaN
  return {
    id,
    senderId,
    channel,
    body,
    at: Number.isFinite(time) ? time : Date.now(),
  }
}

export function parseRoomMessages(value: unknown): RoomMessage[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((row) => {
    const message = parseRoomMessage(row)
    return message ? [message] : []
  })
}

/**
 * Fold a new message into the buffer.
 *
 * Bounded and de-duplicated: realtime can redeliver, a history fetch overlaps
 * with live delivery, and a buffer that grew without limit would be a memory
 * leak in a worker meant to be evicted and restored cheaply.
 */
export function withMessage(
  messages: readonly RoomMessage[],
  next: RoomMessage,
  max = MAX_MESSAGES,
): RoomMessage[] {
  if (messages.some((entry) => entry.id === next.id)) return messages as RoomMessage[]
  return [...messages, next].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)).slice(-max)
}

/** Merge a fetched page into the buffer, keeping one copy of each row. */
export function withMessages(
  messages: readonly RoomMessage[],
  next: readonly RoomMessage[],
  max = MAX_MESSAGES,
): RoomMessage[] {
  let out = messages as RoomMessage[]
  for (const message of next) out = withMessage(out, message, max)
  return out
}

/** Drop everything that has stopped being worth showing. */
export function pruneMessages(
  messages: readonly RoomMessage[],
  now: number,
  retention = RETENTION_MS,
): RoomMessage[] {
  return messages.filter((entry) => now - entry.at < retention)
}

/** Messages still worth showing on this channel, oldest first. */
export function liveMessages(
  messages: readonly RoomMessage[],
  channel: string | null,
  now: number = Date.now(),
  retention = RETENTION_MS,
): RoomMessage[] {
  if (!channel) return []
  const login = channel.toLowerCase()
  return messages
    .filter((entry) => entry.channel === login && now - entry.at < retention)
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
}

/**
 * How many messages are waiting.
 *
 * UNREAD IS NOT ACTIVITY
 *
 * This counts things somebody said to you that you have not looked at. It
 * deliberately does not count reactions or combos: those are something
 * HAPPENING, they are gone in eight seconds, and a number that accrued for
 * them would never settle. The tab shows a count for this and a transient dot
 * for that, and the two must not be merged.
 *
 * Own messages never count. Not because sending also marks read - because a
 * thing you said is not a thing waiting for you.
 */
export function unreadCount(
  messages: readonly RoomMessage[],
  channel: string | null,
  lastSeenAt: number,
  selfId: string | null,
  now: number = Date.now(),
): number {
  return liveMessages(messages, channel, now).filter(
    (entry) => entry.senderId !== selfId && entry.at > lastSeenAt,
  ).length
}

/**
 * Reactions and messages, as ONE stream for the combo engine.
 *
 * This is the whole of the convergence, and the reason there is no second
 * combo implementation anywhere in the room.
 *
 *   * A reaction is an emote. Its body is the emote token, so `scanCombos`
 *     counts it exactly as it counts an emote in group chat.
 *   * An emote-only message is also an emote - a reaction sent the slow way -
 *     and contributes to the same run.
 *   * Ordinary text does NOT contribute. It closes the run, and if the run had
 *     reached the threshold and the sender was not the last contributor, it is
 *     credited with breaking it.
 *
 * That last rule has existed in `scanCombos` since group chat and has never
 * had anything to fire on in a room, because a room had no text in it. It
 * does now, unchanged and unduplicated.
 *
 * Ordering is by server timestamp, so every client builds the same stream and
 * therefore agrees about every combo without a shared counter.
 */
export function comboStream(
  reactions: readonly TogetherReaction[],
  messages: readonly RoomMessage[],
  displayName: (userId: string) => string,
): ComboMessage[] {
  const entries: Array<{ at: number; id: string; message: ComboMessage }> = []

  for (const reaction of reactions) {
    entries.push({
      at: reaction.at,
      id: reaction.id,
      message: {
        id: reaction.id,
        userId: reaction.senderId,
        displayName: displayName(reaction.senderId),
        body: reactionEmote(reaction.reaction).token,
      },
    })
  }

  for (const message of messages) {
    entries.push({
      at: message.at,
      id: message.id,
      message: {
        id: message.id,
        userId: message.senderId,
        displayName: displayName(message.senderId),
        body: message.body,
      },
    })
  }

  return entries
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
    .map((entry) => entry.message)
}

/** Whether a message is one emote and nothing else, for the room's own sizing. */
export function isEmoteMessage(body: string): boolean {
  return isEmoteOnly(body)
}

/**
 * What is happening in a room, right now.
 *
 * ONE FUNCTION, TWO SURFACES, ONE STREAM
 *
 * The room draws this above its composer, and so does the ephemeral preview
 * on the Gravity card outside it. They must never disagree - glancing at the
 * card and then opening the room should continue what you saw, not offer a
 * second opinion about the same eight seconds - so there is exactly one place
 * that decides and both call it.
 *
 * Its input is reactions AND messages, merged by `comboStream`. A reaction is
 * an emote; an emote-only message is the same emote sent the slow way; and
 * ordinary text does not contribute but does close a run. All three of those
 * are `scanCombos` rules that already existed - nothing here counts anything.
 *
 * WHY IT IS THE TRAILING RUN AND NOTHING ELSE
 *
 * `activeCombo` returns the run still open at the end of the stream, which is
 * the definition of "right now". Below COMBO_MIN_DISPLAY it returns null, and
 * rather than showing nothing this falls back to the most recent emote at a
 * count of one - the same run, reported at length one, with the caller
 * deciding whether that is worth a number beside it.
 *
 * WHY IT VANISHES ON ITS OWN
 *
 * The window is ACTIVITY_TTL_MS, and it is the only clock in the path. This
 * is deliberately much shorter than how long a message is kept: the room
 * shows half an hour of conversation, and the activity indicator shows eight
 * seconds of it. If a combo is on screen, it is happening - no timestamps, no
 * "recently", no decayed remnant kept so the layout does not move.
 */
export interface RoomActivity {
  emote: KickbackEmote
  /** Distinct people in the run. One means a single emote, not a combo. */
  count: number
}

export function roomActivity(
  reactions: readonly TogetherReaction[],
  messages: readonly { id: string; senderId: string; channel: string; body: string; at: number }[],
  channel: string | null,
  displayName: (userId: string) => string,
  now: number = Date.now(),
): RoomActivity | null {
  if (!channel) return null
  const login = channel.toLowerCase()

  const live = liveReactions(reactions, login, now)
  /*
   * The same eight-second window, applied to messages.
   *
   * Not liveMessages: that is the thirty-minute retention window the room
   * itself renders. Activity is a much shorter question asked of the same
   * data, which is exactly why the two lifetimes are separate constants.
   */
  const recent = messages.filter(
    (entry) => entry.channel === login && now - entry.at < ACTIVITY_TTL_MS,
  )

  const stream = comboStream(live, recent, displayName)
  const last = stream[stream.length - 1]
  if (!last) return null

  const emote = emoteOf(last.body)
  // Text closes a run rather than extending it, so the trailing entry being
  // a sentence means nothing is currently happening worth a symbol.
  if (!emote) return null

  const combo = activeCombo(stream)
  return { emote, count: combo?.count ?? 1 }
}

/** The Kickback emote a combo body stands for, if it is one at all. */
function emoteOf(body: string): KickbackEmote | null {
  const match = EMOTES.find((emote) => emote.token === body.trim())
  return match ?? null
}
