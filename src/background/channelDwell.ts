/**
 * Observed stream dwell: how long Watchside could see each live Twitch stream.
 *
 * WHAT THIS IS FOR
 *
 * Every viewing number Watchside had before this measured a socially selected
 * subset: `watching_together` is time spent with a friend, `post_social` is the
 * tail after they left. Neither can be a denominator - an average computed from
 * them is biased upward by construction, and a future holdout would have
 * nothing to compare, because a control arm produces no shared watches at all.
 *
 * PER STREAM, NOT PER PERSON
 *
 * This is the M3C.1 correction. The first version measured only the FOCUSED
 * tab, one interval at a time, on the grounds that counting three tabs as three
 * hours would invent watch time. That reasoning was wrong in an important way:
 * it protected the headline number by destroying the evidence. A viewer with
 * two streams legitimately open for an hour really did consume two
 * stream-hours of Twitch, and a measurement that records one of them has thrown
 * away a fact nobody can recover later.
 *
 * So each eligible live stream accrues its own interval, concurrently.
 *
 *   two streams open for 60 minutes  ->  120 observed STREAM-minutes
 *                                        60 wall-clock minutes
 *
 * Those are different quantities with different names, and both are derivable
 * (see the interval reconstruction note below). What is NOT allowed is calling
 * the first one "hours the user spent watching Twitch".
 *
 * BE CONSERVATIVE IN CLAIMS, NOT DESTRUCTIVE IN COLLECTION.
 *
 * FOCUS IS A DIMENSION, NOT A GATE
 *
 * A stream does not stop counting because its tab lost focus - the viewer may
 * have it on a second monitor, or be reading something else with a stream
 * running. But which stream was in front of them is real information, so every
 * interval carries the focused portion of its own duration alongside the total.
 * That preserves both readings rather than picking one:
 *
 *   focusedMs + backgroundMs === durationMs, exactly, by construction.
 *
 * WHAT STILL DOES NOT COUNT
 *
 * This is not permission to accrue an abandoned tab forever. An interval ends
 * when the evidence ends: the destination leaves the observed set (tab closed
 * or navigated), the stream stops being live under the SAME `socialViewing.ts`
 * rule the shared watch uses, the session ends, or observation is lost beyond
 * the resume window. Unobserved gaps are never bridged.
 *
 * RECONSTRUCTING INTERVALS
 *
 * The emitted event is dated to the EFFECTIVE end and carries the duration, so
 * `started_at = occurred_at - duration_ms` exactly. Concurrency and wall-clock
 * union are therefore derivable in SQL from what is already sent, with no
 * additional telemetry - see supabase/migrations/0031_m3c_stream_dwell.sql.
 */

import type { DwellEndReason } from '../core/analytics'
import { isObservationLost } from './togetherStore'

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
   * Focused time already banked, excluding any run still in progress.
   *
   * Accumulated at each focus TRANSITION rather than sampled per tick, so the
   * partition is exact rather than rounded to the heartbeat.
   */
  focusedMs: number
  /** When the current focused run began, or null while this stream is not focused. */
  focusedSince: number | null
  /**
   * Whether a shared watch was ever open on this stream during this interval.
   *
   * STICKY, and set from the shared-watch machine's own state rather than from
   * a friend count. Never cleared - an interval where a friend watched for two
   * minutes and then left is still `had_social`, which is the truthful answer.
   * Reading it at close time instead would report false for every interval that
   * outlived its social part, which is most of them.
   */
  hadSocial: boolean
  /**
   * The JOIN this stream's viewing can be attributed to, if one led here.
   *
   * Per stream, and fixed when the interval opens. A second stream opened
   * alongside an attributed one gets its own answer - see the attribution
   * isolation tests.
   */
  attributionId: string | null
}

export interface DwellEvent {
  type: 'ended'
  channel: string
  /** Measured to the effective end, never to when we noticed. */
  durationMs: number
  /** The part of `durationMs` this stream was the viewer's primary destination. */
  focusedMs: number
  /** `durationMs - focusedMs`, by construction. Never negative. */
  backgroundMs: number
  hadSocial: boolean
  attributionId: string | null
  reason: DwellEndReason
  /** When viewing actually stopped. This is the event's time. */
  effectiveAt: number
  /** When we worked that out. Never earlier than effectiveAt. */
  detectedAt: number
}

/** One eligible live stream, as observed this tick. */
export interface DwellStream {
  channel: string
  /** True when this is the viewer's primary destination right now. */
  focused: boolean
  /** The shared-watch lifecycle's own answer for THIS stream. Never a friend count. */
  social: boolean
}

export interface ChannelDwellDeps {
  now?: () => number
}

export interface ChannelDwell {
  /**
   * Feed the current world: every eligible live stream observed right now.
   *
   * A channel present in `streams` continues or opens; a channel absent from it
   * closes. `reason` says why the absent ones went, and the caller supplies it
   * because only the caller can tell "the tab went away" from "the stream
   * stopped being live".
   */
  update(input: {
    streams: readonly DwellStream[]
    /** Why any stream missing from `streams` ended. Defaults to `left_channel`. */
    reasonFor?: (channel: string) => DwellEndReason
  }): DwellEvent[]
  /** Sign-out or session end: close everything open. */
  stop(): DwellEvent[]
  /** Attach the attribution an interval on this channel should open with. */
  attribute(channel: string, attributionId: string | null): void
  /** Channels with no open interval, so the caller knows what to look up. */
  wantsAttribution(channel: string): boolean
  current(): readonly DwellState[]
  /** The open interval for one channel, if there is one. */
  currentFor(channel: string): DwellState | null

  // --------------------------------------------------- surviving a restart
  /** A plain copy of every open interval, safe to serialise. */
  snapshot(): DwellState[]
  /**
   * Install intervals read back from storage.
   *
   * Emits nothing: there is no start event to replay, and the intervals are
   * simply continuing.
   */
  restore(states: readonly DwellState[]): void
  /** Close specific channels as of a moment in the past. */
  closeAt(
    channels: readonly string[],
    reason: DwellEndReason,
    effectiveAt: number,
    detectedAt: number,
  ): DwellEvent[]
  /** Close everything as of a moment in the past. */
  closeAllAt(reason: DwellEndReason, effectiveAt: number, detectedAt: number): DwellEvent[]
}

export function createChannelDwell(deps: ChannelDwellDeps = {}): ChannelDwell {
  const now = deps.now ?? (() => Date.now())

  /** Open intervals, keyed by channel. Insertion order is preserved. */
  const open = new Map<string, DwellState>()
  /** Attributions waiting for an interval on that channel to open. */
  const pending = new Map<string, string>()

  function close(
    channel: string,
    reason: DwellEndReason,
    effectiveAt: number,
    detectedAt: number,
  ): DwellEvent | null {
    const state = open.get(channel)
    if (!state) return null
    open.delete(channel)

    /*
     * To the effective end.
     *
     * Not to now, and not to the moment a gap was noticed: an OS suspend or an
     * evicted worker can put hours between the two, and every one of those
     * hours would otherwise be reported as viewing.
     */
    const durationMs = Math.max(0, effectiveAt - state.startedAt)

    /*
     * The focus partition, closed out and clamped.
     *
     * A run still in progress is banked up to the effective end - never past
     * it, which matters when an interval is closed retroactively at a moment
     * earlier than the focus run began. Clamping to the duration is what makes
     * focused + background === duration true by construction rather than by
     * hoping the arithmetic lined up.
     */
    const trailing =
      state.focusedSince === null ? 0 : Math.max(0, effectiveAt - state.focusedSince)
    const focusedMs = Math.min(state.focusedMs + trailing, durationMs)

    return {
      type: 'ended',
      channel: state.channel,
      durationMs,
      focusedMs,
      backgroundMs: durationMs - focusedMs,
      hadSocial: state.hadSocial,
      attributionId: state.attributionId,
      reason,
      effectiveAt,
      detectedAt,
    }
  }

  return {
    update({ streams, reasonFor }): DwellEvent[] {
      const at = now()
      const events: DwellEvent[] = []
      const seen = new Set(streams.map((stream) => stream.channel))

      // Anything no longer observed closes. The caller says why, because only
      // it can tell a closed tab from a stream that stopped being live.
      for (const channel of [...open.keys()]) {
        if (seen.has(channel)) continue
        const event = close(channel, reasonFor?.(channel) ?? 'left_channel', at, at)
        if (event) events.push(event)
      }

      for (const stream of streams) {
        const state = open.get(stream.channel)

        if (!state) {
          open.set(stream.channel, {
            channel: stream.channel,
            startedAt: at,
            focusedMs: 0,
            focusedSince: stream.focused ? at : null,
            hadSocial: stream.social,
            attributionId: pending.get(stream.channel) ?? null,
          })
          pending.delete(stream.channel)
          continue
        }

        // Sticky, never cleared. See DwellState.hadSocial.
        if (stream.social) state.hadSocial = true

        /*
         * Focus transitions, banked as they happen.
         *
         * Sampling per tick instead would smear each transition across the
         * heartbeat interval, and the error would always be in the same
         * direction for whichever stream happened to be focused at tick time.
         */
        if (stream.focused && state.focusedSince === null) {
          state.focusedSince = at
        } else if (!stream.focused && state.focusedSince !== null) {
          state.focusedMs += Math.max(0, at - state.focusedSince)
          state.focusedSince = null
        }
      }

      return events
    },

    stop(): DwellEvent[] {
      const at = now()
      const events: DwellEvent[] = []
      for (const channel of [...open.keys()]) {
        const event = close(channel, 'session_ended', at, at)
        if (event) events.push(event)
      }
      pending.clear()
      return events
    },

    attribute(channel, attributionId): void {
      if (attributionId === null) pending.delete(channel)
      else pending.set(channel, attributionId)
    },

    wantsAttribution: (channel) => !open.has(channel),

    current: () => [...open.values()],

    currentFor: (channel) => open.get(channel) ?? null,

    snapshot: () => [...open.values()].map((state) => ({ ...state })),

    restore(states): void {
      // Copied, so a caller holding objects it read out of storage cannot
      // mutate the machine's state behind its back.
      open.clear()
      for (const state of states) open.set(state.channel, { ...state })
      pending.clear()
    },

    closeAt(channels, reason, effectiveAt, detectedAt): DwellEvent[] {
      const events: DwellEvent[] = []
      for (const channel of channels) {
        const event = close(channel, reason, effectiveAt, detectedAt)
        if (event) events.push(event)
      }
      return events
    },

    closeAllAt(reason, effectiveAt, detectedAt): DwellEvent[] {
      const events: DwellEvent[] = []
      for (const channel of [...open.keys()]) {
        const event = close(channel, reason, effectiveAt, detectedAt)
        if (event) events.push(event)
      }
      pending.clear()
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
  if (typeof state.focusedMs !== 'number' || !Number.isFinite(state.focusedMs)) return false
  if (state.focusedSince !== null && typeof state.focusedSince !== 'number') return false
  if (typeof state.hadSocial !== 'boolean') return false
  if (state.attributionId !== null && typeof state.attributionId !== 'string') return false
  return true
}

/** Every open interval, as stored between worker lives. */
export interface PersistedDwell {
  /**
   * Whose intervals these are.
   *
   * Checked on the way back in, so intervals belonging to one account can never
   * be emitted under the next one after a sign-out and sign-in.
   */
  userId: string
  /** The analytics session they began in, so ends pair with their starts. */
  sessionId: string | null
  states: DwellState[]
  /** The last moment we could vouch for observing the user. */
  lastSeenAt: number
}

export function isPersistedDwell(value: unknown): value is PersistedDwell {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record.userId !== 'string' || record.userId === '') return false
  if (record.sessionId !== null && typeof record.sessionId !== 'string') return false
  if (typeof record.lastSeenAt !== 'number' || !Number.isFinite(record.lastSeenAt)) return false
  if (!Array.isArray(record.states)) return false
  return record.states.every(isDwellState)
}

export type DwellReconciliation =
  /** Nothing to restore, or nothing we may act on. */
  | { action: 'discard'; why: 'nothing_stored' | 'other_account' | 'signed_out' }
  /**
   * Resume what is still observed and close what is not.
   *
   * Both halves come back together because a restart usually finds some of the
   * world as it left it and some of it gone - two streams open, one tab closed
   * during the outage - and handling that as two separate decisions is how one
   * of them gets forgotten.
   */
  | {
      action: 'apply'
      resume: DwellState[]
      close: DwellState[]
      /** The last moment the closed ones could be vouched for. */
      effectiveAt: number
      reason: DwellEndReason
    }

/**
 * Decides what to do with stored intervals, given the world we woke up to.
 *
 * Pure, and the whole of the recovery policy for the SET case.
 *
 * It reuses `isObservationLost` - the same rule and the same constant the
 * shared watch uses - rather than restating staleness, so a frozen worker and a
 * restarted one cannot reach different answers. What it cannot reuse is
 * `reconcileLifecycle` itself: that one asks "is the stored channel still THE
 * channel", and the question here is set membership across several intervals at
 * once.
 */
export function reconcileDwell(
  stored: PersistedDwell | null,
  world: { userId: string | null; channels: readonly string[]; now: number },
  resumeWindowMs?: number,
): DwellReconciliation {
  if (!stored) return { action: 'discard', why: 'nothing_stored' }

  // Nobody is signed in, so there is no actor to record against and no way to
  // know whose these are. Leave them alone rather than guessing.
  if (!world.userId) return { action: 'discard', why: 'signed_out' }

  /*
   * A different account. Dropped without emitting anything at all.
   *
   * Emitting the ends would attribute them to whoever is signed in NOW, because
   * the actor is always auth.uid() server-side - so one person's viewing would
   * be recorded against another's. Losing the intervals is the correct trade.
   */
  if (stored.userId !== world.userId) return { action: 'discard', why: 'other_account' }

  /*
   * Checked before membership, deliberately.
   *
   * A long gap and a changed destination set are both true after a laptop has
   * been shut overnight, and of the two "we stopped being able to see" is the
   * honest description. Saying `left_channel` would claim we knew they left,
   * when all we know is that we were not looking.
   */
  if (isObservationLost(stored.lastSeenAt, world.now, resumeWindowMs)) {
    return {
      action: 'apply',
      resume: [],
      close: stored.states,
      effectiveAt: stored.lastSeenAt,
      reason: 'observation_lost',
    }
  }

  const live = new Set(world.channels)
  return {
    action: 'apply',
    resume: stored.states.filter((state) => live.has(state.channel)),
    close: stored.states.filter((state) => !live.has(state.channel)),
    // Still here, but that stream is gone. It ended at the last moment we could
    // vouch for; the gap becomes detection lag, as for any late detection.
    effectiveAt: stored.lastSeenAt,
    reason: 'left_channel',
  }
}
