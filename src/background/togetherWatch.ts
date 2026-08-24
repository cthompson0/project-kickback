/**
 * Detecting that someone is watching WITH somebody - and what they do after.
 *
 * This is the outcome the whole product is aimed at, so it is measured from
 * real presence rather than from having clicked a button. A JOIN click is an
 * intention; arriving is a fact; being on a channel where a friend also is, for
 * a while, is the thing that was worth building. What happens once the friends
 * leave is the thing that tells us whether the destination stuck.
 *
 * TWO INTERVALS, NOT ONE
 *
 *   together     - I am on a channel and at least one visible person is too.
 *   post-social  - the last of them has gone, and I am still here.
 *
 * They are deliberately separate measurements. Merging them would answer
 * neither question: "how long did they watch together" would be inflated by
 * solo viewing, and "did the destination survive the social context" could not
 * be asked at all.
 *
 * DETECTION TIME IS NOT EVENT TIME
 *
 * The correction this file exists for. A remote friend leaving is not
 * something we are told; it is something we notice, later, when presence stops
 * arriving - and if no presence traffic arrives at all, we may not notice until
 * the user themselves moves. Observed for real: A left at T1, B kept watching,
 * and B's end-of-togetherness was only detected 40 minutes later at T2.
 *
 * So every ended event carries BOTH times. `effectiveAt` is when co-viewing
 * actually stopped; `detectedAt` is when we worked that out. The event is
 * recorded at its effective time, and the lag is recorded alongside it as a
 * fact rather than being smuggled into the timestamp. A late detection can
 * then never inflate a duration, and how late we were stays auditable.
 *
 * HYSTERESIS, UNCHANGED AND STILL EARNED
 *
 *   - Presence heartbeats every 45s and goes stale at 90s, so a friend can
 *     briefly appear to vanish. Ending on that would chop one evening into a
 *     dozen fragments, so the end waits END_GRACE_MS - but the interval is
 *     still dated to when they actually went, not to when the wait expired.
 *   - Channel changes are immediate, because they are not ambiguous.
 *
 * The peak count is carried rather than the final one: "how many people was
 * this shared with" is better answered by the most it ever was than by
 * whoever happened to still be there at the end.
 */

import type { PostSocialEndReason, TogetherEndReason } from '../core/analytics'

/*
 * Re-exported so callers of this module get the whole vocabulary from one
 * place, while core stays the single definition. Two enums that must agree is
 * a promise nobody keeps.
 */
export type { PostSocialEndReason, TogetherEndReason }

export interface TogetherState {
  channel: string
  startedAt: number
  otherCountPeak: number
  /** The JOIN this can be attributed to, if one led here. */
  attributionId: string | null
  /** When the co-viewers first dropped to zero. Null while they are here. */
  aloneSince: number | null
  /**
   * Set once the together interval has been closed and the user is STILL on
   * the channel: the effective moment co-viewing ended, and the start of the
   * post-social interval. Null while co-viewing is still open.
   */
  socialEndedAt: number | null
}


export type TogetherEvent =
  | {
      type: 'started'
      channel: string
      otherCount: number
      attributionId: string | null
      at: number
    }
  | {
      type: 'ended'
      channel: string
      otherCountPeak: number
      attributionId: string | null
      durationMs: number
      reason: TogetherEndReason
      /** When co-viewing actually stopped. This is the event's time. */
      effectiveAt: number
      /** When we worked that out. Never earlier than effectiveAt. */
      detectedAt: number
    }
  | {
      type: 'post_social_ended'
      channel: string
      /** The JOIN that brought them here, if one did. Null when organic. */
      attributionId: string | null
      /** From the effective end of co-viewing to leaving the destination. */
      durationMs: number
      reason: PostSocialEndReason
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
   * nothing, occasionally an end, a start, or an end immediately followed by a
   * start when the user moves from one shared channel to another.
   */
  update(input: { channel: string | null; otherCount: number }): TogetherEvent[]
  /** Sign-out or session end: close whatever is open. */
  stop(): TogetherEvent[]
  /** Attach the attribution for a shared watch about to start. */
  attribute(attributionId: string | null): void
  /**
   * True when a shared watch starting now would have no attribution yet, so
   * the caller knows whether to look one up. False while one is already open.
   */
  wantsAttribution(): boolean
  current(): TogetherState | null

  // --------------------------------------------------- surviving a restart
  //
  // An MV3 worker is evicted whenever Chrome feels like it, and a shared watch
  // or the retention after it can run for hours. These three let the hub keep
  // the open interval in extension storage without this file knowing storage
  // exists - it stays a pure state machine, and every rule above stays
  // testable without a browser.

  /** A plain copy of the open interval, safe to serialise. */
  snapshot(): TogetherState | null
  /**
   * Install an interval read back from storage.
   *
   * Emits nothing, deliberately: the start was recorded before the worker
   * died, and a second one would double-count it.
   */
  restore(state: TogetherState): void
  /**
   * Close a restored interval as of a moment in the past.
   *
   * For when the world moved on while nothing was running: the interval ended
   * at the last moment we could vouch for, and we are only finding out now.
   */
  closeAt(
    reason: TogetherEndReason & PostSocialEndReason,
    effectiveAt: number,
    detectedAt: number,
  ): TogetherEvent[]
}

export function createTogetherWatch(deps: TogetherWatchDeps = {}): TogetherWatch {
  const now = deps.now ?? (() => Date.now())
  const endGraceMs = deps.endGraceMs ?? TOGETHER_END_GRACE_MS

  let state: TogetherState | null = null
  let pendingAttribution: string | null = null

  function togetherEnded(
    reason: TogetherEndReason,
    effectiveAt: number,
    detectedAt: number,
  ): TogetherEvent {
    const open = state!
    return {
      type: 'ended',
      channel: open.channel,
      otherCountPeak: open.otherCountPeak,
      attributionId: open.attributionId,
      /*
       * Measured to when they were last actually there.
       *
       * Not to now, and not to the end of the grace period: both would report
       * every shared watch as longer than it was, and in the delayed-detection
       * case the error is unbounded - forty minutes, in the case this was
       * written for.
       */
      durationMs: Math.max(0, effectiveAt - open.startedAt),
      reason,
      effectiveAt,
      detectedAt,
    }
  }

  function postSocialEnded(
    reason: PostSocialEndReason,
    from: number,
    at: number,
  ): TogetherEvent {
    const open = state!
    return {
      type: 'post_social_ended',
      channel: open.channel,
      attributionId: open.attributionId,
      durationMs: Math.max(0, at - from),
      reason,
      at,
    }
  }

  /**
   * Closes whatever is open, in order.
   *
   * The awkward case is one close producing two events: the user leaves a
   * channel whose co-viewers had already gone, so the together interval ends
   * (back at the moment they went) and the post-social interval that followed
   * it ends now. Handling both here means the two phases can never disagree
   * about when one stopped and the other started.
   */
  function closeAll(
    reason: TogetherEndReason & PostSocialEndReason,
    at: number,
    /*
     * When we worked it out, which differs from the moment above only when
     * closing a lifecycle restored from storage: that one ended at the last
     * moment we could vouch for, and was noticed now.
     */
    detectedAt: number = at,
  ): TogetherEvent[] {
    if (!state) return []
    const out: TogetherEvent[] = []

    if (state.socialEndedAt === null) {
      const effectiveAt = state.aloneSince ?? at
      /*
       * The reason is what actually ended it, not what happened to reveal it.
       *
       * If the co-viewers had already gone, the shared watch ended because it
       * ran out of people - even though the thing that made us look was the
       * user navigating away several minutes later. Reporting that as
       * `left_channel` was the second half of the observed bug.
       */
      out.push(
        togetherEnded(state.aloneSince !== null ? 'alone_again' : reason, effectiveAt, detectedAt),
      )
      if (state.aloneSince !== null) out.push(postSocialEnded(reason, state.aloneSince, at))
    } else {
      out.push(postSocialEnded(reason, state.socialEndedAt, at))
    }

    state = null
    return out
  }

  return {
    update({ channel, otherCount }): TogetherEvent[] {
      const at = now()
      const events: TogetherEvent[] = []

      // Moving channels ends everything on the old one at once - there is
      // nothing ambiguous about having navigated away.
      if (state && state.channel !== channel) {
        events.push(...closeAll('left_channel', at))
      }

      if (!channel) return events

      if (state && state.socialEndedAt !== null) {
        // Watching on alone. Only somebody arriving changes anything.
        if (otherCount > 0) {
          events.push(postSocialEnded('rejoined', state.socialEndedAt, at))
          /*
           * The attribution carries forward.
           *
           * A JOIN brought them to this channel; friends left and came back.
           * The whole visit is that JOIN's outcome, and re-deriving it would
           * mean asking the attribution store for something it may already
           * have expired.
           */
          state = {
            channel,
            startedAt: at,
            otherCountPeak: otherCount,
            attributionId: state.attributionId,
            aloneSince: null,
            socialEndedAt: null,
          }
          events.push({
            type: 'started',
            channel,
            otherCount,
            attributionId: state.attributionId,
            at,
          })
        }
        return events
      }

      if (state) {
        if (otherCount > 0) {
          state.otherCountPeak = Math.max(state.otherCountPeak, otherCount)
          state.aloneSince = null
        } else if (state.aloneSince === null) {
          // Start the clock rather than ending immediately: presence flaps.
          state.aloneSince = at
        } else if (at - state.aloneSince >= endGraceMs) {
          /*
           * Confirmed alone. The shared watch ends at the moment they went,
           * and the post-social interval begins there too - so however late
           * this was noticed, the two intervals still meet exactly.
           */
          events.push(togetherEnded('alone_again', state.aloneSince, at))
          state.socialEndedAt = state.aloneSince
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
          socialEndedAt: null,
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
      const events = closeAll('session_ended', now())
      pendingAttribution = null
      return events
    },

    attribute(attributionId: string | null): void {
      pendingAttribution = attributionId
    },

    // Nothing is open, or what is open is a post-social interval whose next
    // shared watch will inherit the attribution it already holds.
    wantsAttribution: () => state === null,

    current: () => state,

    snapshot: () => (state ? { ...state } : null),

    restore(restored: TogetherState): void {
      // Copied, so a caller holding the object it read out of storage cannot
      // mutate the machine's state behind its back.
      state = { ...restored }
      pendingAttribution = null
    },

    closeAt(reason, effectiveAt, detectedAt): TogetherEvent[] {
      const events = closeAll(reason, effectiveAt, detectedAt)
      pendingAttribution = null
      return events
    },
  }
}
