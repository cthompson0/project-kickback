import { EMOTES } from './emotes'
import type { KickbackEmote, KickbackEmoteId } from './emotes'
import type { ComboMessage } from './combos'

/**
 * Automatic Stream Rooms: the last step of Presence → Gravity → JOIN → Together.
 *
 * WHAT A ROOM IS
 *
 * The connected component of the friendship graph, restricted to people whose
 * presence says they are on this destination, right now. `A ↔ B ↔ C ↔ D` all
 * watching lvndmark is ONE room of four, even though A and D have never met.
 * An unrelated E on the same stream is not in it.
 *
 * WHAT A ROOM IS NOT
 *
 * A record. Nothing is created, named, owned, joined, invited to or deleted.
 * Membership is computed by the server on demand (see stream_room_members in
 * 0020) and never stored, which is why merging and splitting need no
 * ceremony: they are what recomputation looks like.
 *
 * Watchside has persistent private spaces already - Groups, with intentional
 * membership and a conversation that is still there tomorrow. These share
 * transport, identity, combo semantics and UI primitives with that, and no
 * product semantics at all.
 *
 * WHY REACTIONS ARE KICKBACK EMOTES
 *
 * Because Watchside already has a combo engine, and it speaks emotes.
 *
 * The first version of this file invented a second one - a parallel palette of
 * unicode emoji with its own burst aggregator - and it rendered every burst
 * side by side instead of counting one in place, which is the emoji-stacking
 * that was reported. Rather than fix a duplicate, the duplicate is gone: a
 * reaction IS one of Watchside's own emotes, so `scanCombos` counts it,
 * `ComboBadge` draws the ×N, and `EmoteImage` draws the artwork. One engine,
 * one currency, two surfaces.
 */

/**
 * The reactions a person may send.
 *
 * Five of Watchside's own emotes rather than free entry. A closed set cannot
 * carry a payload, so nothing arbitrary reaches another person's screen; and
 * combos only mean anything when people can collide on the same symbol, which
 * unlimited choice makes almost impossible.
 *
 * Kept in step with the `p_reaction in (...)` check in 0020 by a test that
 * reads both.
 */
export const REACTIONS: readonly KickbackEmoteId[] = ['lol', 'heart', 'fire', 'sad', 'eyes']

export type Reaction = KickbackEmoteId

const REACTION_SET: ReadonlySet<string> = new Set(REACTIONS)

export function isReaction(value: unknown): value is Reaction {
  return typeof value === 'string' && REACTION_SET.has(value)
}

/** The artwork for a reaction, for the buttons and the combo badge. */
export function reactionEmote(reaction: Reaction): KickbackEmote {
  const emote = EMOTES.find((entry) => entry.id === reaction)
  // The palette is a subset of EMOTES, so this cannot miss - but a lookup that
  // silently returned undefined would surface as a blank button.
  if (!emote) throw new Error(`together: no emote for ${reaction}`)
  return emote
}

/**
 * How long an interaction counts as HAPPENING NOW.
 *
 * Reactions are ephemeral by design - no history, no inbox, no transcript -
 * because they exist to say "did you SEE that" about something happening on
 * the stream right now. Eight seconds is long enough to notice one that landed
 * while you were looking at the video, and short enough that the surface is
 * empty again before the moment has passed.
 */
export const ACTIVITY_TTL_MS = 8_000

/**
 * The old name, kept because it is what a reaction buffer is pruned by.
 *
 * One constant with two readers: reactions expire out of existence after
 * this, and the activity indicator - which also watches messages, and those
 * do NOT expire this fast - uses the same eight seconds to decide what counts
 * as now. Two names for one number would let them drift.
 */
export const REACTION_TTL_MS = ACTIVITY_TTL_MS

/** The most reactions worth keeping. A burst is a burst; a flood is noise. */
export const MAX_REACTIONS = 60

export interface TogetherReaction {
  /** The row id. Different per recipient; unique within one client. */
  id: string
  senderId: string
  /** Canonical lowercase login it was sent on. */
  channel: string
  reaction: Reaction
  /** Epoch ms, from the server, so everybody orders them the same way. */
  at: number
  /**
   * Epoch ms on THIS machine, when this client learned of it.
   *
   * Ordering and recency are different questions and must use different
   * clocks. Ordering has to be the server's, or two clients would disagree
   * about which emote came first and therefore about the combo. Recency has to
   * be ours, because "is this happening now" is a question about the person
   * looking at the screen.
   *
   * Comparing `at` against Date.now() conflated them, and eight seconds is a
   * very small tolerance for two unsynchronised clocks: a machine a few
   * seconds behind Supabase never saw an activity window at all.
   */
  receivedAt: number
}

/** Reactions still worth showing on this channel, oldest first. */
export function liveReactions(
  reactions: readonly TogetherReaction[],
  channel: string | null,
  /*
   * Defaulted here rather than at the call site: freshness is a clock
   * question, and render paths in this project do not read the clock - a
   * render that did could disagree with itself.
   */
  now: number = Date.now(),
  ttl = REACTION_TTL_MS,
): TogetherReaction[] {
  if (!channel) return []
  const login = channel.toLowerCase()
  return (
    reactions
      // Recency against OUR clock, ordering by the server's. See receivedAt.
      .filter((entry) => entry.channel === login && now - entry.receivedAt < ttl)
      .sort((a, b) => a.at - b.at)
  )
}

/**
 * The reaction stream, as the combo engine reads it.
 *
 * This is the whole of the convergence. `scanCombos` walks ordered messages
 * whose body is a single emote and counts runs from DIFFERENT senders - which
 * is exactly what a reaction stream is. Handing it the same shape means
 * reactions get the existing rules for free: two voices to show a count, the
 * same person twice in a row adds nothing, a different emote starts its own
 * run rather than breaking one.
 *
 * A combo BREAKER cannot occur here, and that is correct rather than missing:
 * a breaker is an ordinary message interrupting a run, and this stream has no
 * ordinary messages in it. The rule is preserved, not removed - it simply has
 * nothing to fire on until a room has text, which v1 deliberately does not.
 */
export function reactionMessages(
  reactions: readonly TogetherReaction[],
  displayName: (userId: string) => string,
): ComboMessage[] {
  return reactions.map((entry) => ({
    id: entry.id,
    userId: entry.senderId,
    displayName: displayName(entry.senderId),
    body: reactionEmote(entry.reaction).token,
  }))
}

/**
 * Fold a new reaction into the buffer.
 *
 * Bounded and de-duplicated: realtime can redeliver, and a buffer that grew
 * without limit would be a memory leak in a service worker meant to be
 * evicted and restored cheaply.
 */
export function withReaction(
  reactions: readonly TogetherReaction[],
  next: TogetherReaction,
  max = MAX_REACTIONS,
): TogetherReaction[] {
  if (reactions.some((entry) => entry.id === next.id)) return reactions as TogetherReaction[]
  return [...reactions, next].slice(-max)
}

/** Drop everything that can no longer be shown. */
export function pruneReactions(
  reactions: readonly TogetherReaction[],
  now: number,
  ttl = REACTION_TTL_MS,
): TogetherReaction[] {
  return reactions.filter((entry) => now - entry.receivedAt < ttl)
}

/**
 * Validate a reaction row.
 *
 * It arrives over realtime from a table other people write to, so it is parsed
 * rather than cast - and an unknown reaction is dropped entirely rather than
 * rendered, which keeps anything arbitrary off somebody's screen even if the
 * server's own validation were ever loosened.
 */
export function parseReaction(value: unknown): TogetherReaction | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>

  const id = raw.id
  const senderId = raw.sender_id
  const channel = raw.channel
  const reaction = raw.reaction
  const at = raw.created_at

  if (typeof id !== 'string' || typeof senderId !== 'string') return null
  if (typeof channel !== 'string' || !/^[a-z0-9_]{3,25}$/.test(channel)) return null
  if (!isReaction(reaction)) return null

  const time = typeof at === 'string' ? Date.parse(at) : NaN
  return {
    id,
    senderId,
    channel,
    reaction,
    at: Number.isFinite(time) ? time : Date.now(),
    // A reaction is only ever delivered live, so learning of it IS now.
    receivedAt: Date.now(),
  }
}
