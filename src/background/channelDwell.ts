/**
 * How long Watchside OBSERVED somebody watching one live channel.
 *
 * WHAT THIS IS FOR
 *
 * Every viewing number Watchside had before this measured a socially selected
 * subset: `watching_together` is time spent with a friend, `post_social` is the
 * tail after they left. Both are real, and neither can be a denominator - an
 * average computed from them is biased upward by construction, and a future
 * holdout would have nothing to compare, because the control arm produces no
 * shared watches at all.
 *
 * So this measures the whole of it: the interval, not the social part of it.
 *
 * WHAT IT DELIBERATELY IS NOT
 *
 *   not "how long was a Twitch tab open"
 *   not "how many Twitch tabs existed"
 *   not "how long did the browser run"
 *
 * FOCUSED TAB ONLY, AND WHY THAT IS STRUCTURAL RATHER THAN CHECKED
 *
 * This machine holds ONE open interval. It is fed `liveWatchChannel()`, which
 * is the primary destination from the activity registry - a visible tab always
 * beats a hidden one - narrowed to channels Twitch says are live. So there is
 * no code path on which two channels accrue at once, and none on which a
 * background tab accrues at all. It is not enforced by a guard that somebody
 * could later forget; there is simply nowhere to put a second interval.
 *
 * That matters because the alternative - counting three open tabs as three
 * concurrent hours - is the one way this system could INVENT watch time rather
 * than merely lose some, and inventing it is the failure that cannot be
 * detected afterwards.
 *
 * ONE DEFINITION OF WATCHING
 *
 * The channel arrives from the same call, in the same tick, with the same
 * value that drives the shared-watch lifecycle. Dwell and `watching_together`
 * therefore cannot disagree about what counts as watching, and a shared watch
 * is always inside a dwell interval on the same channel rather than beside one.
 *
 * CONSERVATIVE, IN THE SAME DIRECTION AS EVERYTHING ELSE
 *
 * A channel that stops being eligible - the stream ends, metadata goes cold,
 * the user backgrounds every tab - arrives here as `null`, which closes the
 * interval. An observation gap longer than the resume window closes it at the
 * last moment we could vouch for. Both under-report. That is the direction to
 * be wrong in.
 */

import type { DwellEndReason } from '../core/analytics'

/*
 * Re-exported so callers of this module get the whole vocabulary from one
 * place, while core stays the single definition - the same arrangement
 * togetherWatch.ts uses for TogetherEndReason. Two enums that must agree is a
 * promise nobody keeps.
 */
export type { DwellEndReason }

export interface DwellState {
  channel: string
  startedAt: number
  /**
   * Whether a shared watch was ever open during this interval.
   *
   * STICKY, and that is the whole point. It is set from the shared-watch
   * machine's own state rather than from a friend count, and it is never
   * cleared - so an interval where a friend watched for two minutes and then
   * left is still `had_social`, which is the truthful answer. Reading it at
   * close time instead would report false for every interval that outlived its
   * social part, which is most of them.
   */
  hadSocial: boolean
  /** The JOIN this viewing can be attributed to, if one led here. */
  attributionId: string | null
}

export interface DwellEvent {
  type: 'ended'
  channel: string
  /** Measured to the effective end, never to when we noticed. */
  durationMs: number
  hadSocial: boolean
  attributionId: string | null
  reason: DwellEndReason
  /** When viewing actually stopped. This is the event's time. */
  effectiveAt: number
  /** When we worked that out. Never earlier than effectiveAt. */
  detectedAt: number
}

export interface ChannelDwellDeps {
  now?: () => number
}

export interface ChannelDwell {
  /**
   * Feed the current world.
   *
   * `channel` is the eligible focused live destination, or null when there is
   * none. `social` is the shared-watch machine's own answer to "is a shared
   * watch open right now" - not a friend count, so this can never claim social
   * viewing on evidence the shared-watch lifecycle itself rejected.
   */
  update(input: { channel: string | null; social: boolean }): DwellEvent[]
  /** Sign-out or session end: close whatever is open. */
  stop(): DwellEvent[]
  /** Attach the attribution for an interval about to open. */
  attribute(attributionId: string | null): void
  /** True when an interval opening now would have no attribution yet. */
  wantsAttribution(): boolean
  current(): DwellState | null

  // --------------------------------------------------- surviving a restart
  /** A plain copy of the open interval, safe to serialise. */
  snapshot(): DwellState | null
  /**
   * Install an interval read back from storage.
   *
   * Emits nothing: there is no start event to replay, and the interval is
   * simply continuing.
   */
  restore(state: DwellState): void
  /** Close a restored interval as of a moment in the past. */
  closeAt(reason: DwellEndReason, effectiveAt: number, detectedAt: number): DwellEvent[]
}

export function createChannelDwell(deps: ChannelDwellDeps = {}): ChannelDwell {
  const now = deps.now ?? (() => Date.now())

  let state: DwellState | null = null
  let pendingAttribution: string | null = null

  function close(reason: DwellEndReason, effectiveAt: number, detectedAt: number): DwellEvent[] {
    if (!state) return []
    const open = state
    state = null
    return [
      {
        type: 'ended',
        channel: open.channel,
        /*
         * To the effective end.
         *
         * Not to now, and not to the moment a gap was noticed: an OS suspend
         * or an evicted worker can put hours between the two, and every one of
         * those hours would otherwise be reported as viewing.
         */
        durationMs: Math.max(0, effectiveAt - open.startedAt),
        hadSocial: open.hadSocial,
        attributionId: open.attributionId,
        reason,
        effectiveAt,
        detectedAt,
      },
    ]
  }

  return {
    update({ channel, social }): DwellEvent[] {
      const at = now()
      const events: DwellEvent[] = []

      if (state && state.channel !== channel) {
        /*
         * A hand-off to another eligible destination is a switch; anything
         * else is a departure. Deciding it here, from whether a new channel
         * arrived in the SAME tick, is what makes the distinction truthful -
         * there is no guessing about intent involved.
         */
        events.push(...close(channel ? 'switched_channel' : 'left_channel', at, at))
      }

      if (!channel) return events

      if (!state) {
        state = {
          channel,
          startedAt: at,
          hadSocial: social,
          attributionId: pendingAttribution,
        }
        pendingAttribution = null
        return events
      }

      // Sticky, never cleared. See DwellState.hadSocial.
      if (social) state.hadSocial = true
      return events
    },

    stop(): DwellEvent[] {
      const at = now()
      const events = close('session_ended', at, at)
      pendingAttribution = null
      return events
    },

    attribute(attributionId: string | null): void {
      pendingAttribution = attributionId
    },

    wantsAttribution: () => state === null,

    current: () => state,

    snapshot: () => (state ? { ...state } : null),

    restore(restored: DwellState): void {
      // Copied, so a caller holding the object it read out of storage cannot
      // mutate the machine's state behind its back.
      state = { ...restored }
      pendingAttribution = null
    },

    closeAt(reason, effectiveAt, detectedAt): DwellEvent[] {
      const events = close(reason, effectiveAt, detectedAt)
      pendingAttribution = null
      return events
    },
  }
}

/**
 * Whether a value read back out of storage is a dwell interval of ours.
 *
 * Anything that does not pass reads as absent, which fails closed: no interval
 * is resumed and no event is emitted from a shape we do not understand.
 */
export function isDwellState(value: unknown): value is DwellState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Record<string, unknown>
  if (typeof state.channel !== 'string' || state.channel === '') return false
  if (typeof state.startedAt !== 'number' || !Number.isFinite(state.startedAt)) return false
  if (typeof state.hadSocial !== 'boolean') return false
  if (state.attributionId !== null && typeof state.attributionId !== 'string') return false
  return true
}
