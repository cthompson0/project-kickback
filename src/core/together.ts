import { COMBO_MIN_DISPLAY } from './combos'

/**
 * Automatic Together: the last step of Presence → Gravity → JOIN → Together.
 *
 * WHAT IT IS NOT
 *
 * It is not a room. Nothing is created, named, owned, joined, invited to or
 * deleted. There is no membership list to administer and no lifecycle to get
 * out of sync with reality, because there is no record: a Together is simply
 * the fact that you and some friends are on the same channel right now, which
 * presence already knows.
 *
 * Kickback has persistent private spaces already - Groups, with intentional
 * membership and a conversation that is still there tomorrow. This is the
 * opposite of that on every axis, and the two must not be confused. They share
 * transport, identity and UI primitives; they share no product semantics.
 *
 * WHERE THE PARTICIPANTS COME FROM
 *
 * `clusterMembers`, unchanged - the same `here` cluster the panel has drawn
 * since Social Gravity. That means Together inherits, for free and without a
 * second interpretation:
 *
 *   - multi-tab effective activity (one person, not one per tab);
 *   - the 90-second staleness rule (a closed laptop leaves on its own);
 *   - write-time privacy redaction (someone hiding their activity is simply
 *     not on a channel, so they are not here);
 *   - self-exclusion (you are never one of the people you are with).
 *
 * There is deliberately no participant list in this file. Deriving one would
 * be a second answer to a question presence has already answered.
 *
 * DESTINATION IDENTITY
 *
 * The canonical lowercase login, the same value presence, Gravity, JOIN,
 * `destination_channel` and `opportunity_key` all use. Conceptually
 * `twitch:lvndmark`; the platform is implicit while Twitch is the only one.
 * Not display casing, not the stream id - a stream ending and restarting is
 * the same people in the same place, and tying the social context to a stream
 * id would dissolve it mid-conversation. Metadata stays enrichment.
 */

/**
 * The reactions a person may send.
 *
 * A fixed, tiny palette rather than free emoji entry. Three reasons, in order
 * of how much they matter:
 *
 *   1. It is a couch, not a keyboard. Five things you can hit without looking
 *      is the whole interaction.
 *   2. A closed set is trivially safe: the server validates against this exact
 *      list, so no arbitrary text ever reaches another person's screen.
 *   3. Combos only mean anything when people can collide on the same symbol.
 *      With unlimited emoji, three people almost never pick the same one.
 */
export const REACTIONS = ['😂', '❤️', '🔥', '😭', '👀'] as const

export type Reaction = (typeof REACTIONS)[number]

const REACTION_SET: ReadonlySet<string> = new Set(REACTIONS)

export function isReaction(value: unknown): value is Reaction {
  return typeof value === 'string' && REACTION_SET.has(value)
}

/**
 * How long a reaction stays on screen.
 *
 * Reactions are ephemeral by design - there is no history, no inbox and no
 * transcript, because they exist to say "did you SEE that" about something
 * happening on the stream right now. Eight seconds is long enough to notice
 * one that landed while you were looking at the video, and short enough that
 * the surface is empty again before the moment has passed.
 */
export const REACTION_TTL_MS = 8_000

/**
 * How close together two reactions have to be to count as the same moment.
 *
 * Shorter than the TTL: reactions linger a little after they stop combining,
 * so a burst finishes as a stable "×3" rather than growing while it fades.
 */
export const COMBO_WINDOW_MS = 4_000

/** The most reactions worth keeping. A burst is a burst; a flood is noise. */
export const MAX_REACTIONS = 60

export interface TogetherReaction {
  id: string
  userId: string
  /** Canonical lowercase login the reaction was sent on. */
  channel: string
  reaction: Reaction
  /** Epoch ms, from the server, so everybody orders them the same way. */
  at: number
}

/**
 * A run of the same reaction from DIFFERENT people, close together.
 *
 * The one product rule: a combo is several people agreeing, not one person
 * pressing a button repeatedly. Somebody spamming 😂 five times is one 😂 -
 * which is also what stops the surface being a clicker game, without needing
 * any scoring, streaks, points or leaderboards to prevent it.
 */
export interface ReactionBurst {
  reaction: Reaction
  /** Distinct people, so this is the number the UI shows. */
  count: number
  /** Everyone in the run, in arrival order, for avatars or a tooltip. */
  userIds: string[]
  /** The newest contribution, so the UI can age the whole burst out. */
  at: number
}

/** Reactions still worth showing, oldest first. */
export function liveReactions(
  reactions: readonly TogetherReaction[],
  channel: string | null,
  /*
   * Defaulted here rather than at the call site.
   *
   * Reaction freshness is a clock question, and render paths in this project
   * do not read the clock - a render that did could disagree with itself. The
   * same arrangement clusterMembers and socialGravity use.
   */
  now: number = Date.now(),
  ttl = REACTION_TTL_MS,
): TogetherReaction[] {
  if (!channel) return []
  const login = channel.toLowerCase()
  return reactions
    .filter((entry) => entry.channel === login && now - entry.at < ttl)
    .sort((a, b) => a.at - b.at)
}

/**
 * Collapse a stream of reactions into what should actually be drawn.
 *
 * Consecutive identical reactions inside the window become one burst. A
 * different reaction starts a new one - joining in with something else is
 * participation, not interruption, which is the same judgement the chat combo
 * scanner makes about a different emote.
 *
 * Deliberately NOT `scanCombos`. That models a CHAT: ordinary prose closes a
 * run, and a closing message can earn breaker credit. Neither concept exists
 * here - there is no prose in this stream and nothing to break - so reusing it
 * would mean feeding it synthetic messages and discarding half its output. The
 * threshold and the "×N" language are shared; the rules are not the same rules.
 */
export function reactionBursts(
  reactions: readonly TogetherReaction[],
  windowMs = COMBO_WINDOW_MS,
): ReactionBurst[] {
  const bursts: ReactionBurst[] = []

  for (const entry of reactions) {
    const open = bursts[bursts.length - 1]

    const extends_ =
      open &&
      open.reaction === entry.reaction &&
      entry.at - open.at <= windowMs &&
      // The same person again is enthusiasm, not a second voice.
      !open.userIds.includes(entry.userId)

    if (extends_) {
      open.userIds.push(entry.userId)
      open.count = open.userIds.length
      open.at = entry.at
      continue
    }

    // A repeat from someone already in the open run still refreshes it, so a
    // burst does not age out early while people are still reacting.
    if (open && open.reaction === entry.reaction && entry.at - open.at <= windowMs) {
      open.at = entry.at
      continue
    }

    bursts.push({
      reaction: entry.reaction,
      count: 1,
      userIds: [entry.userId],
      at: entry.at,
    })
  }

  return bursts
}

/** Whether a burst has enough voices to be worth a counter. */
export function isCombo(burst: ReactionBurst): boolean {
  return burst.count >= COMBO_MIN_DISPLAY
}

/**
 * Fold a new reaction into the buffer.
 *
 * Bounded and de-duplicated: realtime can redeliver, and a buffer that grew
 * without limit would be a memory leak in a service worker that is meant to
 * be evicted and restored cheaply.
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
  return reactions.filter((entry) => now - entry.at < ttl)
}

/**
 * Validate a reaction row.
 *
 * It arrives over realtime from a table other people write to, so it is parsed
 * rather than cast - and an unknown reaction is dropped entirely rather than
 * rendered, which is what keeps arbitrary text off somebody's screen even if
 * the server's own validation were ever loosened.
 */
export function parseReaction(value: unknown): TogetherReaction | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>

  const id = raw.id
  const userId = raw.user_id
  const channel = raw.channel
  const reaction = raw.reaction
  const at = raw.created_at

  if (typeof id !== 'string' || typeof userId !== 'string') return null
  if (typeof channel !== 'string' || !/^[a-z0-9_]{3,25}$/.test(channel)) return null
  if (!isReaction(reaction)) return null

  const time = typeof at === 'string' ? Date.parse(at) : NaN
  return {
    id,
    userId,
    channel,
    reaction,
    at: Number.isFinite(time) ? time : Date.now(),
  }
}
