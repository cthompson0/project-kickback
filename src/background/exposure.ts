/**
 * Turning "this is on screen" into "this was seen", once.
 *
 * Impressions are the measurement the whole Social Gravity comparison rests on:
 * the question is not whether friend activity existed, but whether the user was
 * shown it and what they did next. That makes over-counting worse than useless
 * - a realtime presence update re-renders the friends list, and a naive
 * impression per render would report a hundred exposures for one glance.
 *
 * THE RULE
 *
 * The panel reports the SET of things currently visible, as often as it likes.
 * This turns that stream of sets into events:
 *
 *   - A key that is newly present emits one impression.
 *   - While it stays present, nothing more is emitted.
 *   - It may emit again once WINDOW_MS has passed, so a panel left open all
 *     evening records a fresh exposure every half hour rather than one for the
 *     whole evening or one per repaint.
 *   - If it DISAPPEARS for at least ABSENCE_MS and comes back, that is a new
 *     exposure immediately: the friend left and returned, and being shown that
 *     again is a real second opportunity.
 *   - Disappearing briefly - a presence blip, a re-render, a tab switch - is
 *     not enough. That is what ABSENCE_MS is for.
 *
 * WHAT COUNTS AS A KEY
 *
 * The key is the identity of the opportunity, not its appearance: a friend and
 * the channel they are on, or a gathering's channel. A gathering growing from
 * two friends to six is the same gathering and does not re-impress; the count
 * recorded is the one at the moment of the impression. A friend MOVING from one
 * channel to another is a different opportunity, and does.
 */

export interface ExposureRecord {
  /** When this key last produced an impression. */
  emittedAt: number
  /** When it was last reported as visible. */
  seenAt: number
  /** True while the key is in the currently-visible set. */
  present: boolean
}

/** One impression per key per half hour of continuous visibility. */
export const EXPOSURE_WINDOW_MS = 30 * 60 * 1000
/** Gone for this long and back again counts as a new opportunity. */
export const EXPOSURE_ABSENCE_MS = 5 * 60 * 1000

export interface ExposureTrackerDeps {
  now?: () => number
  windowMs?: number
  absenceMs?: number
  /** Guards against an unbounded map if a client reports nonsense. */
  maxKeys?: number
}

export interface ExposureTracker {
  /**
   * Report everything visible right now. Returns the keys that should emit an
   * impression - usually none.
   */
  observe(keys: readonly string[]): string[]
  /** Nothing is visible: the panel closed, the tab hid, the user signed out. */
  hideAll(): void
  reset(): void
  /** For tests and diagnostics. */
  size(): number
}

const DEFAULT_MAX_KEYS = 500

export function createExposureTracker(deps: ExposureTrackerDeps = {}): ExposureTracker {
  const now = deps.now ?? (() => Date.now())
  const windowMs = deps.windowMs ?? EXPOSURE_WINDOW_MS
  const absenceMs = deps.absenceMs ?? EXPOSURE_ABSENCE_MS
  const maxKeys = deps.maxKeys ?? DEFAULT_MAX_KEYS

  const seen = new Map<string, ExposureRecord>()

  /** Forgets the coldest entries. Bounded memory beats perfect history. */
  function prune(at: number): void {
    if (seen.size <= maxKeys) return
    const byAge = [...seen.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt)
    for (const [key] of byAge.slice(0, seen.size - maxKeys)) seen.delete(key)
    // Anything older than both windows is dead weight regardless of size.
    for (const [key, record] of seen) {
      if (at - record.seenAt > windowMs + absenceMs) seen.delete(key)
    }
  }

  return {
    observe(keys: readonly string[]): string[] {
      const at = now()
      const visible = new Set(keys)
      const emit: string[] = []

      for (const key of visible) {
        const record = seen.get(key)

        if (!record) {
          seen.set(key, { emittedAt: at, seenAt: at, present: true })
          emit.push(key)
          continue
        }

        const wasAway = !record.present && at - record.seenAt >= absenceMs
        const windowPassed = at - record.emittedAt >= windowMs

        if (wasAway || windowPassed) {
          emit.push(key)
          record.emittedAt = at
        }

        record.seenAt = at
        record.present = true
      }

      // Everything not in this report is now absent. The clock on its absence
      // starts from the last time it WAS seen, which is already recorded.
      for (const [key, record] of seen) {
        if (!visible.has(key)) record.present = false
      }

      prune(at)
      return emit
    },

    hideAll(): void {
      for (const record of seen.values()) record.present = false
    },

    reset(): void {
      seen.clear()
    },

    size: () => seen.size,
  }
}

// ------------------------------------------------------------------- keys
//
// Built here rather than at the call sites, so the panel and the worker cannot
// disagree about what a key means.

export function friendPresenceKey(userId: string, channel: string): string {
  return `friend:${userId}:${channel}`
}

export function gatheringKey(channel: string): string {
  return `gathering:${channel}`
}

/** Reserved for Social Gravity; the next checkpoint needs no new dedupe code. */
export function gravityClusterKey(channel: string): string {
  return `gravity:${channel}`
}
