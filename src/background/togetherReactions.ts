import { parseReaction, pruneReactions, withReaction } from '../core/together'
import type { Reaction, TogetherReaction } from '../core/together'

/**
 * The reaction stream for the channel the viewer is currently on.
 *
 * ONE SUBSCRIPTION, AND ONLY WHILE IT MATTERS
 *
 * Reactions are only interesting on the channel you are watching, so exactly
 * one subscription is open at a time and none at all when you are not on a
 * channel. Moving to another stream closes the old one and opens a new one;
 * leaving Twitch closes it. That is what keeps this from being "subscribe to
 * everywhere my friends might be".
 *
 * WHO IS FILTERED, AND WHERE
 *
 * The channel filter is on the subscription. The FRIENDSHIP filter is not:
 * it is the row-level policy in 0019, re-checked by the server for each
 * subscriber. Nothing in this file decides who may see what, which is the
 * point - a client-side privacy filter is a privacy filter an attacker
 * controls.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not decide who is in a Together. Presence already answers that, and
 * the panel reads it from the same `here` cluster it has drawn since Social
 * Gravity. This is a buffer for one kind of event and nothing more.
 */

export interface ReactionChannelHandlers {
  /**
   * One inserted row, exactly as realtime delivered it.
   *
   * Deliberately `unknown`: the transport hands over what the database sent,
   * and parsing happens in one place - so a row that does not validate is
   * dropped by the same code whether it came from realtime, a test or the
   * Test Lab.
   */
  onReaction: (row: unknown) => void
  onStatus: (status: 'connected' | 'error') => void
}

export interface ReactionChannel {
  /** Subscribe to one channel's reactions. Returns an unsubscribe function. */
  open(channel: string, handlers: ReactionChannelHandlers): Promise<() => void>
}

export interface ReactionBackend {
  send(channel: string, reaction: Reaction): Promise<void>
}

export interface TogetherReactionsDeps {
  channel: ReactionChannel
  backend: ReactionBackend
  /** Something changed and the panel should be told. */
  onChange?: () => void
  /** A reaction arrived from somebody else, for analytics. */
  onReceived?: (reaction: TogetherReaction) => void
  now?: () => number
  onError?: (context: string, error: unknown) => void
}

export interface TogetherReactions {
  /**
   * The channel the viewer is on, or null.
   *
   * Idempotent: safe to call on every presence tick. Re-subscribes only when
   * the channel actually changes.
   */
  setChannel(channel: string | null): void
  /** Send one. Fire-and-forget; failure is logged and never surfaced. */
  send(reaction: Reaction): void
  /** Everything still worth showing. */
  snapshot(): TogetherReaction[]
  /** Sign-out, or a different account. */
  reset(): void
  /** For tests and diagnostics. */
  channel(): string | null
}

export function createTogetherReactions(deps: TogetherReactionsDeps): TogetherReactions {
  const now = deps.now ?? (() => Date.now())

  let current: string | null = null
  let close: (() => void) | null = null
  let reactions: TogetherReaction[] = []
  /** Guards against a slow open landing after the channel moved on again. */
  let generation = 0

  function publish(): void {
    deps.onChange?.()
  }

  function receive(row: unknown, forChannel: string, mine: number): void {
    // A subscription that has already been replaced must not write into the
    // buffer for the channel that replaced it.
    if (mine !== generation || current !== forChannel) return

    const reaction = parseReaction(row)
    if (!reaction || reaction.channel !== forChannel) return

    const before = reactions.length
    reactions = withReaction(pruneReactions(reactions, now()), reaction)
    if (reactions.length === before && before !== 0) return

    deps.onReceived?.(reaction)
    publish()
  }

  return {
    setChannel(next): void {
      const channel = next ? next.trim().toLowerCase() : null
      if (channel === current) return

      generation += 1
      const mine = generation

      close?.()
      close = null
      current = channel
      /*
       * Reactions do not travel between channels.
       *
       * They are about what just happened on THIS stream, so carrying them to
       * the next one would show a friend laughing at something the viewer
       * cannot see.
       */
      reactions = []
      publish()

      if (!channel) return

      void deps.channel
        .open(channel, {
          onReaction: (row) => receive(row, channel, mine),
          onStatus: (status) => {
            if (status === 'error') deps.onError?.('together.subscribe', status)
          },
        })
        .then((unsubscribe) => {
          // The channel changed while the subscription was opening.
          if (mine !== generation) {
            unsubscribe()
            return
          }
          close = unsubscribe
        })
        .catch((error) => {
          /*
           * Realtime is down. Presence is not, so the Together surface still
           * shows who is here - it simply has no reactions in it. Enrichment
           * failing must never take the social map with it.
           */
          deps.onError?.('together.subscribe', error)
        })
    },

    send(reaction): void {
      const channel = current
      if (!channel) return

      void deps.backend.send(channel, reaction).catch((error) => {
        // Nothing is shown optimistically, so a failed send simply does not
        // appear - for the sender as well as for everyone else. One path, and
        // no way for the sender to see a reaction their friends did not get.
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
      current = null
      reactions = []
      publish()
    },

    channel: () => current,
  }
}

