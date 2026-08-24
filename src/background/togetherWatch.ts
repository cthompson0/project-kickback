/**
 * Detecting that someone is actually watching WITH somebody.
 *
 * This is the outcome the whole product is aimed at, so it is measured from
 * real presence rather than from having clicked a button. A JOIN click is an
 * intention; arriving is a fact; being on a channel where a friend also is, for
 * a while, is the thing that was worth building.
 *
 * The state is a fold over "my channel" and "the people visible to me":
 *
 *   started  - I am on a channel, and at least one visible person is too.
 *   ended    - I left, or the last of them did, or the session ended.
 *
 * TWO PIECES OF HYSTERESIS, BOTH EARNED
 *
 *   - Presence heartbeats every 45s and goes stale at 90s, so a friend can
 *     briefly appear to vanish. Ending a shared watch on that would chop one
 *     evening into a dozen sessions, each too short to mean anything. So the
 *     end waits: the co-watchers must be gone for END_GRACE_MS.
 *   - Channel changes are immediate, because they are not ambiguous. If I have
 *     navigated away, I am not watching with anyone here, and pretending
 *     otherwise would inflate every duration.
 *
 * The peak count is carried rather than the final one: "how many people was
 * this shared with" is better answered by the most it ever was than by
 * whoever happened to still be there at the end.
 */

export interface TogetherState {
  channel: string
  startedAt: number
  otherCountPeak: number
  /** The JOIN this shared watch can be attributed to, if any. */
  attributionId: string | null
  /** When the co-watchers first dropped to zero, or null while they are here. */
  aloneSince: number | null
}

export type TogetherEvent =
  | {
      type: 'started'
      channel: string
      otherCount: number
      /** The JOIN this can be attributed to, if one led here. */
      attributionId: string | null
      at: number
    }
  | {
      type: 'ended'
      channel: string
      otherCountPeak: number
      attributionId: string | null
      durationMs: number
      reason: 'left_channel' | 'alone_again' | 'session_ended'
      at: number
    }

/** How long the others must be absent before the shared watch is over. */
export const TOGETHER_END_GRACE_MS = 2 * 60 * 1000

export interface TogetherWatchDeps {
  now?: () => number
  endGraceMs?: number
}

export interface TogetherWatch {
  /**
   * Feed the current world. Returns whatever transitions that caused - usually
   * nothing, occasionally a start, an end, or an end immediately followed by a
   * start when the user moves from one shared channel to another.
   */
  update(input: { channel: string | null; otherCount: number }): TogetherEvent[]
  /** Sign-out or session end: close anything open. */
  stop(): TogetherEvent[]
  /** Attach the attribution for a shared watch about to start on this channel. */
  attribute(attributionId: string | null): void
  current(): TogetherState | null
}

export function createTogetherWatch(deps: TogetherWatchDeps = {}): TogetherWatch {
  const now = deps.now ?? (() => Date.now())
  const endGraceMs = deps.endGraceMs ?? TOGETHER_END_GRACE_MS

  let state: TogetherState | null = null
  let pendingAttribution: string | null = null

  function close(reason: 'left_channel' | 'alone_again' | 'session_ended', at: number): TogetherEvent | null {
    if (!state) return null
    const ended: TogetherEvent = {
      type: 'ended',
      channel: state.channel,
      otherCountPeak: state.otherCountPeak,
      attributionId: state.attributionId,
      /*
       * Measured to when they were last actually there, not to now. Otherwise
       * every shared watch would be reported as two minutes longer than it was
       * - the grace period would be counted as watching together.
       */
      durationMs: Math.max(0, (state.aloneSince ?? at) - state.startedAt),
      reason,
      at,
    }
    state = null
    return ended
  }

  return {
    update({ channel, otherCount }): TogetherEvent[] {
      const at = now()
      const events: TogetherEvent[] = []

      // Moving channels ends the old one at once - there is nothing ambiguous
      // about having navigated away.
      if (state && state.channel !== channel) {
        const ended = close('left_channel', at)
        if (ended) events.push(ended)
      }

      if (!channel) return events

      if (state) {
        if (otherCount > 0) {
          state.otherCountPeak = Math.max(state.otherCountPeak, otherCount)
          state.aloneSince = null
        } else if (state.aloneSince === null) {
          // Start the clock rather than ending immediately: presence flaps.
          state.aloneSince = at
        } else if (at - state.aloneSince >= endGraceMs) {
          const ended = close('alone_again', at)
          if (ended) events.push(ended)
        }
        return events
      }

      if (otherCount > 0) {
        state = {
          channel,
          startedAt: at,
          otherCountPeak: otherCount,
          attributionId: pendingAttribution,
          aloneSince: null,
        }
        pendingAttribution = null
        events.push({
          type: 'started',
          channel,
          otherCount,
          attributionId: state.attributionId,
          at,
        })
      }

      return events
    },

    stop(): TogetherEvent[] {
      const ended = close('session_ended', now())
      pendingAttribution = null
      return ended ? [ended] : []
    },

    attribute(attributionId: string | null): void {
      pendingAttribution = attributionId
    },

    current: () => state,
  }
}
