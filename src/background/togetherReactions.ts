import { parseReaction, pruneReactions, withReaction } from '../core/together'
import type { Reaction, TogetherReaction } from '../core/together'

/**
 * The viewer's reaction inbox.
 *
 * ONE SUBSCRIPTION, PER USER, NOT PER CHANNEL
 *
 * This is the fix for the one-way reaction bug, and it is a shape rather than
 * a patch.
 *
 * The first version subscribed every viewer on a stream to the SAME topic with
 * the SAME filter, so one inserted row matched MANY subscriptions - which is
 * the exact condition for a documented hosted-only Supabase defect where only
 * the most recently created subscription receives it. Whoever subscribed last
 * got reactions; the other side got nothing. It was never about friendship
 * direction.
 *
 * Presence never hit that because it binds one subscription per friend, so
 * every presence row has exactly one interested subscriber. Reactions now have
 * the same property: the server writes one row PER RECIPIENT, and each viewer
 * subscribes to `recipient_id = <themselves>` on a topic named after
 * themselves - matching every other realtime topic in this codebase.
 *
 * WHERE AUTHORIZATION LIVES
 *
 * Entirely on the write side. `send_together_reaction` computes the connected
 * component and addresses a row to each member, so the read policy is a single
 * equality and nothing here decides who may see what. A client-side privacy
 * filter is one the attacker controls; there isn't one.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not decide who is in the room. That is `stream_room_members`, via
 * streamRoom.ts. This is a buffer for one kind of event.
 */

export interface ReactionChannelHandlers {
  /**
   * One inserted row, exactly as realtime delivered it.
   *
   * Deliberately `unknown`: the transport hands over what the database sent
   * and parsing happens in one place, so a row that does not validate is
   * dropped by the same code whether it came from realtime, a test or the
   * Test Lab.
   */
  onReaction: (row: unknown) => void
  onStatus: (status: 'connected' | 'error') => void
}

export interface ReactionChannel {
  /** Subscribe to one user's inbox. Returns an unsubscribe function. */
  open(userId: string, handlers: ReactionChannelHandlers): Promise<() => void>
}

export interface ReactionBackend {
  /** Resolves to how many people it reached. Rejects on refusal. */
  send(channel: string, reaction: Reaction): Promise<number>
}

export interface TogetherReactionsDeps {
  channel: ReactionChannel
  backend: ReactionBackend
  /** Something changed and the panel should be told. */
  onChange?: () => void
  /** Every realtime transition, not only failures. See core/failures.ts. */
  onStatus?: (status: 'connected' | 'error') => void
  /** A reaction was delivered, for analytics. Includes the viewer's own. */
  onReaction?: (reaction: TogetherReaction, mine: boolean) => void
  now?: () => number
  onError?: (context: string, error: unknown) => void
}

export interface TogetherReactions {
  /**
   * Who the inbox belongs to, or null when signed out.
   *
   * Idempotent: safe to call on every auth tick. Re-subscribes only when the
   * user actually changes.
   */
  setUser(userId: string | null): void
  /**
   * Where the viewer is watching, or null.
   *
   * Not a subscription boundary any more - only a display one. Reactions do
   * not travel between channels, so moving clears the buffer.
   */
  /**
   * Every destination the viewer has open.
   *
   * A set, so one room's activity is not erased when the viewer looks at
   * another. Reactions already carry their own channel and liveReactions
   * already filters by it, so nothing needed partitioning - only the rule
   * about what to forget.
   */
  setChannels(channels: readonly string[]): void
  /** Send one. Fire-and-forget; failure is logged and never surfaced. */
  send(channel: string | null, reaction: Reaction): void
  /** Everything still worth showing. */
  snapshot(): TogetherReaction[]
  /** Sign-out, or a different account. */
  reset(): void
  /** For tests and diagnostics. */
  subscribedTo(): string | null
}

export function createTogetherReactions(deps: TogetherReactionsDeps): TogetherReactions {
  const now = deps.now ?? (() => Date.now())

  let userId: string | null = null
  let channels: string[] = []
  let close: (() => void) | null = null
  let reactions: TogetherReaction[] = []
  /** Guards a slow open landing after the subscription was replaced. */
  let generation = 0

  function receive(row: unknown, mine: number): void {
    if (mine !== generation) return

    const reaction = parseReaction(row)
    if (!reaction) return

    /*
     * A reaction for a channel the viewer has already left is dropped.
     *
     * The inbox is per user and outlives any one stream, so a row can arrive
     * moments after they moved. Showing it would be a friend laughing at
     * something they can no longer see.
     */
    if (!channels.includes(reaction.channel)) return

    const before = reactions.length
    reactions = withReaction(pruneReactions(reactions, now()), reaction)
    if (reactions.length === before && before !== 0) return

    deps.onReaction?.(reaction, reaction.senderId === userId)
    deps.onChange?.()
  }

  return {
    setUser(next): void {
      const id = next || null
      if (id === userId) return

      generation += 1
      const mine = generation

      close?.()
      close = null
      userId = id
      reactions = []
      deps.onChange?.()

      if (!id) return

      void deps.channel
        .open(id, {
          onReaction: (row) => receive(row, mine),
          onStatus: (status) => {
            if (mine !== generation) return
            deps.onStatus?.(status)
            if (status === 'error') deps.onError?.('together.subscribe', status)
          },
        })
        .then((unsubscribe) => {
          if (mine !== generation) {
            unsubscribe()
            return
          }
          close = unsubscribe
        })
        .catch((error) => {
          /*
           * Realtime is down. Presence is not, so the room still shows who is
           * in it - there is simply nothing landing. Enrichment failing must
           * never take the social map with it.
           */
          deps.onError?.('together.subscribe', error)
        })
    },

    setChannels(next): void {
      const wanted = [...new Set(next.map((entry) => entry.trim().toLowerCase()))].filter(
        (entry) => entry.length > 0,
      )
      channels = wanted

      /*
       * Only what has genuinely closed is forgotten.
       *
       * Reactions are eight seconds of punctuation and are never read back, so
       * there is nothing to fetch here - only the rule about what may still be
       * shown. Dropping a closed destination's reactions keeps the buffer
       * bounded; keeping the rest is what stops one room's activity vanishing
       * because the viewer glanced at another.
       */
      const live = new Set(wanted)
      const kept = reactions.filter((reaction) => live.has(reaction.channel))
      if (kept.length !== reactions.length) {
        reactions = kept
        deps.onChange?.()
      }
    },

    send(channel, reaction): void {
      // The caller names the room, for the same reason a message does.
      const here = channel ? channel.trim().toLowerCase() : null
      if (!here) return
      if (!channels.includes(here)) return

      void deps.backend.send(here, reaction).catch((error) => {
        // Nothing is drawn optimistically, so a failed send simply does not
        // appear - for the sender as well as everyone else. One path, and no
        // way for the sender to see a reaction the room did not get.
        deps.onError?.('together.send', error)
      })
    },

    snapshot(): TogetherReaction[] {
      const live = pruneReactions(reactions, now())
      if (live.length !== reactions.length) reactions = live
      return reactions
    },

    reset(): void {
      generation += 1
      close?.()
      close = null
      userId = null
      channels = []
      reactions = []
      deps.onChange?.()
    },

    subscribedTo: () => userId,
  }
}
