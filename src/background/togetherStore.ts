/**
 * Keeping an open shared watch alive across a service-worker restart.
 *
 * THE FAILURE THIS FIXES
 *
 * togetherWatch is a state machine in a closure, and an MV3 worker is evicted
 * whenever Chrome decides to. A shared watch runs for however long people
 * watch together; the post-social retention after it runs for however long
 * somebody stays on afterwards. Both are routinely longer than a worker lives.
 *
 * When the worker died mid-interval, the open interval went with it. The next
 * worker had no memory of it, so the end was never emitted - and if the user
 * was still watching with somebody, a second START was, counting one evening
 * as two. The numbers most likely to be lost were the long ones, which are
 * exactly the ones Social Gravity will be judged on.
 *
 * WHAT IS STORED
 *
 * One value: the currently open interval, and nothing else. No history, no
 * list of channels visited, no events. It is written while an interval is open
 * and deleted the moment it closes, so a user who is not in a shared watch has
 * nothing about their viewing stored anywhere.
 *
 * THE RULE FOR COMING BACK
 *
 * We cannot know what happened while nothing was running, so we do not guess.
 * A restored interval is only resumed when the world still looks the way we
 * left it AND the gap was short. Otherwise it is CLOSED at the last moment we
 * could vouch for - never at the moment we noticed, which would silently
 * credit the whole outage as viewing time.
 *
 * That is deliberately conservative: it under-reports a long eviction by
 * splitting one interval into two, rather than over-reporting a closed laptop
 * as three hours of watching together.
 */

import type { TogetherState } from './togetherWatch'

/**
 * A stored open interval, whatever kind it is.
 *
 * Generic over the state it carries so the RECOVERY POLICY below has exactly
 * one definition. Shared watching and channel dwell face the identical
 * question after a worker restart - is this still the world we left, and if
 * not, when did we last honestly know anything - and answering it twice would
 * be two chances to answer it differently.
 *
 * The only thing the policy reads from the state is its channel, so that is
 * all the constraint asks for.
 */
export interface PersistedLifecycle<S extends { channel: string } = TogetherState> {
  /**
   * Whose interval this is.
   *
   * Checked on the way back in, so an interval belonging to one account can
   * never be emitted under the next one after a sign-out and sign-in.
   */
  userId: string
  /**
   * The analytics session it began in.
   *
   * Carried because the reporting views pair a start with its end on
   * (actor, session, channel). An interval that outlives its session would
   * otherwise end under a new session id and pair with nothing, turning one
   * shared watch into an unfinished start plus an orphan end.
   */
  sessionId: string | null
  state: S
  /** The last moment we could vouch for the user being on that channel. */
  lastSeenAt: number
}

/**
 * How long a gap may be before a restored interval is closed rather than
 * resumed.
 *
 * An ordinary worker restart is seconds - the worker is revived by a tab
 * connecting or an alarm firing, and the content script re-reports activity
 * immediately. Five minutes is far longer than that and far shorter than any
 * gap where we could still honestly claim to know what the user was doing.
 */
export const RESUME_WINDOW_MS = 5 * 60 * 1000

/**
 * Whether a gap is too long to say what happened inside it.
 *
 * The single staleness rule, and it has two callers on purpose. The obvious
 * one is coming back from storage after a restart. The other is the tick that
 * runs while a worker is STILL ALIVE - because an OS suspend freezes the
 * worker without killing it, and a worker that woke up with its state intact
 * would otherwise have no reason to doubt any of it, and would report the
 * whole sleep as time spent watching.
 *
 * Both callers ask the same question of the same constant, so the answer
 * cannot differ depending on whether Chrome happened to keep the worker.
 */
export function isObservationLost(
  lastSeenAt: number,
  now: number,
  resumeWindowMs: number = RESUME_WINDOW_MS,
): boolean {
  return now - lastSeenAt > resumeWindowMs
}

export type Reconciliation<S extends { channel: string } = TogetherState> =
  /** The world is as we left it. Continue the interval; emit nothing. */
  | { action: 'resume'; lifecycle: PersistedLifecycle<S> }
  /**
   * The world moved on. Close the interval as of `effectiveAt` - the last
   * moment we could vouch for - having only found out now.
   */
  | {
      action: 'close'
      lifecycle: PersistedLifecycle<S>
      effectiveAt: number
      reason: 'left_channel' | 'observation_lost'
    }
  /** Nothing to restore, or nothing we may act on. Drop it silently. */
  | { action: 'discard'; why: 'nothing_stored' | 'other_account' | 'signed_out' }

/**
 * Decides what to do with a stored interval, given the world we woke up to.
 *
 * Pure, and the whole of the recovery policy. Every rule in the module comment
 * is one branch here, which is what makes them testable without a browser, a
 * worker or a clock.
 */
export function reconcileLifecycle<S extends { channel: string } = TogetherState>(
  stored: PersistedLifecycle<S> | null,
  world: { userId: string | null; channel: string | null; now: number },
  resumeWindowMs: number = RESUME_WINDOW_MS,
): Reconciliation<S> {
  if (!stored) return { action: 'discard', why: 'nothing_stored' }

  // Nobody is signed in, so there is no actor to record against and no way to
  // know whose this is. Leave it alone rather than guessing.
  if (!world.userId) return { action: 'discard', why: 'signed_out' }

  /*
   * A different account. Dropped without emitting anything at all.
   *
   * Emitting the end would attribute it to whoever is signed in NOW, because
   * the actor is always auth.uid() server-side - so one person's viewing would
   * be recorded against another's. Losing the interval is the correct trade.
   */
  if (stored.userId !== world.userId) return { action: 'discard', why: 'other_account' }

  /*
   * Checked before the channel, deliberately.
   *
   * A long gap and a changed channel are both true after a laptop has been
   * shut overnight, and of the two "we stopped being able to see" is the
   * honest description. Saying `left_channel` would claim we knew they left,
   * when all we know is that we were not looking.
   */
  if (isObservationLost(stored.lastSeenAt, world.now, resumeWindowMs)) {
    return {
      action: 'close',
      lifecycle: stored,
      effectiveAt: stored.lastSeenAt,
      reason: 'observation_lost',
    }
  }

  /*
   * Still here, but somewhere else. They left the channel at some point we did
   * not see, so the interval ends at the last moment we could vouch for and
   * the gap is reported as detection lag - the same shape as any other late
   * detection.
   */
  if (stored.state.channel !== world.channel) {
    return {
      action: 'close',
      lifecycle: stored,
      effectiveAt: stored.lastSeenAt,
      reason: 'left_channel',
    }
  }

  return { action: 'resume', lifecycle: stored }
}

/**
 * Whether a value read back out of storage is one of ours.
 *
 * Storage survives extension upgrades and is shared with everything else, so
 * what comes back is not guaranteed to be what this version wrote. Anything
 * that does not pass reads as absent, which fails closed: no interval is
 * resumed and no event is emitted from a shape we do not understand.
 */
export function isPersistedLifecycleOf<S extends { channel: string }>(
  value: unknown,
  isState: (candidate: unknown) => candidate is S,
): value is PersistedLifecycle<S> {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>

  if (typeof record.userId !== 'string' || record.userId === '') return false
  if (record.sessionId !== null && typeof record.sessionId !== 'string') return false
  if (typeof record.lastSeenAt !== 'number' || !Number.isFinite(record.lastSeenAt)) return false

  return isState(record.state)
}

/** The shared-watch half: exactly the fields TogetherState declares. */
export function isTogetherState(value: unknown): value is TogetherState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Record<string, unknown>

  if (typeof state.channel !== 'string' || state.channel === '') return false
  if (typeof state.startedAt !== 'number' || !Number.isFinite(state.startedAt)) return false
  if (typeof state.otherCountPeak !== 'number' || !Number.isFinite(state.otherCountPeak)) {
    return false
  }
  if (state.attributionId !== null && typeof state.attributionId !== 'string') return false
  if (state.aloneSince !== null && typeof state.aloneSince !== 'number') return false
  if (state.socialEndedAt !== null && typeof state.socialEndedAt !== 'number') return false

  return true
}

export function isPersistedLifecycle(value: unknown): value is PersistedLifecycle {
  return isPersistedLifecycleOf(value, isTogetherState)
}
