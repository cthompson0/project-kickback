/**
 * Everything analytics, assembled.
 *
 * The service worker is the only place that can answer the questions this
 * needs answered - which session is open, whether a JOIN is still waiting for
 * its arrival, who else is on this channel - so the whole of analytics lives
 * here rather than being sprinkled through the UI. A panel says what it saw
 * and what was clicked; this decides what that means and whether it is worth
 * an event.
 *
 * Nothing a caller does here is awaited. Every method returns void and swallows
 * its own failures: the rule is that a JOIN still joins and a message still
 * sends when analytics is broken, and the only way to guarantee that is for
 * there to be nothing for a product action to wait on.
 */

import { createAnalyticsRecorder } from './analytics'
import type { LiveState } from '../core/twitchMetadata'
import type { AnalyticsBackend, AnalyticsRecorder } from './analytics'
import { createAnalyticsSession, sessionDuration } from './analyticsSession'
import type { SessionStore } from './analyticsSession'
import { createJoinAttribution } from './joinAttribution'
import type { AttributionStore } from './joinAttribution'
import {
  createExposureTracker,
  friendPresenceKey,
  gatheringKey,
  gravityClusterKey,
} from './exposure'
import { opportunityKey } from '../core/socialGravity'
import { createTogetherWatch } from './togetherWatch'
import { createChannelDwell, reconcileDwell } from './channelDwell'
import type { DwellStream, PersistedDwell } from './channelDwell'
import { isObservationLost, reconcileLifecycle } from './togetherStore'
import type { PersistedLifecycle } from './togetherStore'
import { isRandomisedArm } from '../core/experiment'
import type { ExperimentArm } from '../core/experiment'
import type { StoredValue } from './storedValue'
import { normalizeChannel } from '../core/analytics'
import type { MeasurementReadiness } from '../client/types'
import type {
  AnalyticsEnvironment,
  AnalyticsEventMap,
  AnalyticsEventName,
  AnalyticsSurface,
} from '../core/analytics'

/**
 * How often the open interval's last-seen timestamp is refreshed in storage.
 *
 * It only has to be finer than the window a restart is judged against, and
 * this is an order of magnitude finer.
 */
const LAST_SEEN_WRITE_MS = 30_000

export interface ExposureReport {
  friends: Array<{
    userId: string
    channel: string
    state: 'watching_with_you' | 'watching_elsewhere'
  }>
  gatherings: Array<{ channel: string; friendCount: number; rank: number }>
  gravity: Array<{
    channel: string
    friendCount: number
    rank: number
    /** Whether Twitch said the destination was streaming when it was shown. */
    live?: LiveState
  }>
}

/**
 * Whether an eligible JOIN may have its follow baseline measured, and if not,
 * why not.
 *
 * Pure, and deliberately separate from the code that acts on it, because every
 * one of these refusals is a rule somebody could weaken without noticing. The
 * reasons are for tests and for the report; nothing user-facing is ever built
 * from them, and nothing is retried later on the strength of one.
 */
export type MeasurementDecision =
  | { measure: true }
  | {
      measure: false
      reason:
        | 'not_navigated'
        | 'no_attribution'
        | 'not_socially_initiated'
        | 'not_ready'
        | 'unacknowledged'
    }

/**
 * THE ELIGIBILITY GATE FOR THE FIRST PRODUCTION FOLLOW BASELINE.
 *
 * Five conditions, in the order that makes each refusal mean one thing:
 *
 *  1. the click actually navigated - a JOIN on the channel you are already
 *     watching is a real click that goes nowhere, and it mints no attribution
 *  2. an attribution was minted - this is the canonical social-JOIN identity,
 *     and there is no second definition of one anywhere
 *  3. somebody else was there - M3D measures SOCIALLY initiated discovery, and
 *     a JOIN nobody else was part of is a real JOIN outside this population
 *  4. the server says `ready` - any other readiness means no measurement, no
 *     prompt, no OAuth, and no user-visible anything
 *  5. the canonical join_clicked has been ACKNOWLEDGED by the server
 *
 * The fifth is the one Slice B left open, and it is the reason this function
 * takes a queue depth. The recorder re-queues a batch it failed to send, so a
 * drained queue after a flush is a positive signal that the write landed, and a
 * non-empty one means it did not. Measuring anyway would ask the server to bind
 * an attribution whose JOIN has not arrived - which the server would correctly
 * refuse as `unknown_attribution`, but "the server will catch it" is not a
 * reason for the client to try.
 *
 * Every refusal is FINAL for that JOIN. Nothing here schedules a retry, and
 * nothing anywhere backfills: if the permission arrives five minutes later, it
 * says nothing about whether this viewer followed this creator at this JOIN.
 */
export function decideMeasurement(input: {
  navigated: boolean
  attributionId: string | null
  socialCount: number
  readiness: MeasurementReadiness | null
  /** Events still queued after the JOIN flush. Zero means the write landed. */
  pendingEvents: number
}): MeasurementDecision {
  if (!input.navigated) return { measure: false, reason: 'not_navigated' }
  if (!input.attributionId) return { measure: false, reason: 'no_attribution' }
  if (!(input.socialCount > 0)) return { measure: false, reason: 'not_socially_initiated' }
  if (input.readiness !== 'ready') return { measure: false, reason: 'not_ready' }
  if (input.pendingEvents > 0) return { measure: false, reason: 'unacknowledged' }
  return { measure: true }
}

export interface AnalyticsHubDeps {
  backend: AnalyticsBackend
  environment: AnalyticsEnvironment
  appVersion: string | null
  enabled: boolean
  /** See AnalyticsRecorderDeps. Passed straight through; the hub decides nothing. */
  collectTechnical?: boolean
  sessionStore: SessionStore
  attributionStore: AttributionStore
  /**
   * Where the currently open shared watch lives between worker lives.
   *
   * An MV3 worker is evicted at will and these intervals run for hours, so
   * without this the long ones - the ones worth measuring - were the ones
   * most likely to be lost. See togetherStore.ts.
   */
  lifecycleStore: StoredValue<PersistedLifecycle>
  /**
   * Where the currently open DWELL interval lives between worker lives.
   *
   * Separate from lifecycleStore rather than folded into it: the two intervals
   * have different lifetimes - dwell continues after the last friend leaves,
   * and starts before the first one arrives - so one value could not describe
   * both without one of them being wrong. Same recovery policy, same
   * conservative rules; see channelDwell.ts and togetherStore.ts.
   */
  dwellStore: StoredValue<PersistedDwell>
  /** True once there is a signed-in user to attribute events to. */
  canSend: () => boolean
  /**
   * Who is signed in, for the stored lifecycle's owner check.
   *
   * Separate from canSend because "may we send" and "whose interval is this"
   * are different questions, and conflating them is how one account's viewing
   * ends up recorded against another's.
   */
  selfId: () => string | null
  /**
   * What the SERVER last said about measuring this actor.
   *
   * Read rather than remembered, because it changes underneath us - a
   * credential can be revoked on Twitch between one JOIN and the next. Null
   * means "we could not ask", which is not the same as "not permitted" and is
   * treated as not-ready either way.
   */
  measurementReadiness?: () => MeasurementReadiness | null
  /**
   * Records the follow baseline for one eligible JOIN.
   *
   * Best-effort by construction: it is called AFTER the canonical join_clicked
   * has landed, it is never awaited by anything the user is waiting on, and its
   * failure is invisible to them. The JOIN has already happened - the browser
   * navigated to Twitch before this module was even told about the click.
   */
  measureRelationship?: (input: {
    broadcasterLogin: string
    attributionId: string
  }) => Promise<void>
  now?: () => number
  onError?: (context: string, error: unknown) => void
}

export interface AnalyticsHub {
  /** Any sign of life on Twitch: opens a session, or keeps the open one alive. */
  noteActive(): void
  /** A signed-in session now exists. Flushes whatever was waiting for an actor. */
  /**
   * A signed-in session now exists.
   *
   * `experimentArm` is what the caller resolved. Whether it is RECORDED is
   * decided here, not there - see the gate in the implementation.
   */
  noteSignedIn(counts: {
    friendCount: number
    groupCount: number
    experimentArm?: ExperimentArm | null
  }): void
  noteSignedOut(): void

  track<N extends AnalyticsEventName>(
    name: N,
    properties?: Partial<AnalyticsEventMap[N]>,
    options?: { source?: AnalyticsSurface; channel?: string | null },
  ): void

  /** A JOIN was clicked. Mints and stores the attribution arrival is matched on. */
  recordJoin(input: {
    channel: string
    source: AnalyticsSurface
    socialCount: number
    navigated: boolean
    alreadyOnTwitch: boolean
    alreadyOnDestination: boolean
  }): void

  /** The user is now here. Emits join_arrived if this answers a pending click. */
  noteChannel(channel: string | null): void
  /**
   * The viewing world, right now.
   *
   * `channel` / `otherCount` drive the SHARED WATCH, which is single-channel
   * by design - it is about the destination the viewer is at with somebody.
   *
   * `streams` drives OBSERVED STREAM DWELL, which is per stream and may hold
   * several at once: every eligible live destination the viewer has open,
   * whether or not it is the one in front of them.
   *
   * Both arrive on ONE call so they are computed from the same metadata
   * snapshot in the same tick. Two calls would be two chances for the shared
   * watch and the dwell interval containing it to disagree about the world.
   */
  noteTogether(input: {
    channel: string | null
    otherCount: number
    streams?: readonly DwellStream[]
    /**
     * Every destination still OPEN, live or not.
     *
     * The difference between this and `streams` is what lets an ending stream
     * be told from a closing tab: a channel that drops out of `streams` but is
     * still here stopped being live, and one that drops out of both went away.
     * Neither is guessed.
     */
    openChannels?: readonly string[]
  }): void
  noteExposure(report: ExposureReport): void

  flush(): Promise<void>
  /** For tests and diagnostics. */
  recorder(): AnalyticsRecorder
}

export function createAnalyticsHub(deps: AnalyticsHubDeps): AnalyticsHub {
  const now = deps.now ?? (() => Date.now())
  const report = (context: string, error: unknown) => deps.onError?.(context, error)

  const session = createAnalyticsSession({ store: deps.sessionStore, now })
  const attribution = createJoinAttribution({ store: deps.attributionStore, now })
  const exposure = createExposureTracker({ now })
  const together = createTogetherWatch({ now })
  const dwell = createChannelDwell({ now })

  const recorder = createAnalyticsRecorder({
    backend: deps.backend,
    environment: deps.environment,
    appVersion: deps.appVersion,
    enabled: deps.enabled,
    collectTechnical: deps.collectTechnical,
    sessionId: () => session.currentId(),
    canSend: deps.canSend,
    now,
    onError: deps.onError,
  })

  /** Guards the whole surface, so a disabled build has no live code path at all. */
  const off = !deps.enabled

  /**
   * The session the open interval began in, pinned for its whole life.
   *
   * The reporting views pair a start with its end on (actor, session,
   * channel). An interval that outlives its session - a worker gone long
   * enough that the session expired - would otherwise end under a new id and
   * pair with nothing, turning one shared watch into an unfinished start plus
   * an orphan end.
   */
  let lifecycleSessionId: string | null = null

  /** Whether this worker has looked in storage yet. Once per worker life. */
  let lifecycleRestored = false

  /**
   * The last tick at which we could vouch for the open interval.
   *
   * Kept separately from the throttled storage write, because it has to be
   * exact: it is both what a restart closes a stale interval at, and what the
   * tick below measures the gap against. The stored copy is this value, so the
   * two can never disagree about when we last actually saw the user.
   */
  let lifecycleSeenAt = 0

  /** What was last written, so an unchanged interval is not rewritten. */
  let persistedJson: string | null = null
  let persistedAt = 0

  /*
   * The same four pieces of bookkeeping again, for the dwell interval.
   *
   * Deliberately parallel rather than shared. The two intervals open and close
   * at different moments - dwell spans the whole visit, the shared watch only
   * the part with somebody else in it - so a single set of these would have to
   * describe two different "last moment we could vouch for" answers, and would
   * get one of them wrong.
   */
  let dwellSessionId: string | null = null
  let dwellRestored = false
  let dwellSeenAt = 0
  let dwellPersistedJson: string | null = null
  let dwellPersistedAt = 0

  /*
   * Serialises the storage-backed work.
   *
   * Sessions and attributions are read-modify-write against chrome.storage, and
   * activity messages can arrive in bursts - two tabs reporting at once is
   * ordinary. Without a queue, two touches could each read "no session" and
   * each open one. This is a promise chain rather than a lock because the work
   * is tiny and nobody is waiting on it.
   */
  let chain: Promise<void> = Promise.resolve()
  function serial(work: () => Promise<void>, context: string): void {
    chain = chain
      .then(work)
      .catch((error) => report(context, error))
  }

  /**
   * Records an event, making sure it lands in a session.
   *
   * The session is opened asynchronously - it is read out of extension storage
   * - so an event fired in the same tick as the first sign of life would
   * otherwise be written with no session id and fall out of every duration and
   * funnel query. Once a session is open this is a synchronous call; only the
   * first event of a worker's life takes the queue.
   */
  function record(request: Parameters<AnalyticsRecorder['track']>[0]): void {
    if (session.currentId()) {
      recorder.track(request)
      return
    }
    serial(async () => {
      await session.touch()
      recorder.track(request)
    }, 'analytics.record')
  }

  function emitTogether(events: ReturnType<typeof together.update>): void {
    for (const event of events) {
      if (event.type === 'started') {
        // A new interval belongs to whatever session is open now, and keeps
        // that id even if it outlives the session.
        lifecycleSessionId = session.currentId()
        record({
          name: 'watching_together_started',
          properties: { other_count: event.otherCount, from_join: event.attributionId !== null },
          channel: event.channel,
          attributionId: event.attributionId,
          sessionId: lifecycleSessionId,
          occurredAt: event.at,
        })
        continue
      }

      if (event.type === 'ended') {
        record({
          name: 'watching_together_ended',
          properties: {
            other_count_peak: event.otherCountPeak,
            duration_ms: event.durationMs,
            end_reason: event.reason,
            detection_delay_ms: Math.max(0, event.detectedAt - event.effectiveAt),
          },
          channel: event.channel,
          attributionId: event.attributionId,
          sessionId: lifecycleSessionId,
          /*
           * The EFFECTIVE end, not the moment we noticed.
           *
           * A remote friend leaving is something we work out, sometimes long
           * afterwards - forty minutes, in the case this was written for. If
           * the event were dated to the detection, every "when did people stop
           * watching together" question would be wrong by however slow we
           * were, and post-social retention would start in the wrong place.
           * The lag is not lost: it is the property above.
           */
          occurredAt: event.effectiveAt,
        })
        continue
      }

      record({
        name: 'post_social_retention_ended',
        properties: {
          duration_ms: event.durationMs,
          from_join: event.attributionId !== null,
          end_reason: event.reason,
        },
        channel: event.channel,
        attributionId: event.attributionId,
        sessionId: lifecycleSessionId,
        occurredAt: event.at,
      })
    }

    // The interval is over, so the pinned session goes with it. The next one
    // will pin whatever session is open when it starts.
    if (!together.current()) lifecycleSessionId = null
  }

  function emitDwell(events: ReturnType<typeof dwell.update>): void {
    for (const event of events) {
      record({
        name: 'channel_dwell_ended',
        properties: {
          duration_ms: event.durationMs,
          /*
           * The focus partition, carried rather than left to be derived.
           *
           * focused + background === duration exactly, enforced where the
           * interval closes. Sending both means a query cannot forget the
           * subtraction exists or get its sign wrong, and it keeps
           * "focused stream-minutes" a first-class metric rather than
           * something each analyst re-derives slightly differently.
           */
          focused_duration_ms: event.focusedMs,
          background_duration_ms: event.backgroundMs,
          from_join: event.attributionId !== null,
          had_social: event.hadSocial,
          end_reason: event.reason,
        },
        channel: event.channel,
        /*
         * Carried when a JOIN legitimately covered this viewing, under the
         * EXISTING attribution rules - nothing here widens them. An interval
         * that opened without one never acquires one later, so organic viewing
         * cannot be retroactively credited to a JOIN.
         */
        attributionId: event.attributionId,
        sessionId: dwellSessionId,
        /*
         * The EFFECTIVE end. A frozen worker or an evicted one can put hours
         * between when viewing stopped and when we noticed; dating the event
         * to the detection would report every one of those hours as watching.
         */
        occurredAt: event.effectiveAt,
      })
    }

    if (dwell.current().length === 0) dwellSessionId = null
  }

  /** The dwell counterpart of persistLifecycle. Same throttle, same reasons. */
  async function persistDwell(at: number): Promise<void> {
    const states = dwell.snapshot()

    if (states.length === 0) {
      if (dwellPersistedJson !== null) {
        await deps.dwellStore.write(null)
        dwellPersistedJson = null
      }
      return
    }

    const userId = deps.selfId()
    if (!userId) return

    const json = JSON.stringify(states)
    if (json === dwellPersistedJson && at - dwellPersistedAt < LAST_SEEN_WRITE_MS) return

    await deps.dwellStore.write({
      userId,
      sessionId: dwellSessionId,
      states,
      lastSeenAt: dwellSeenAt,
    })
    dwellPersistedJson = json
    dwellPersistedAt = at
  }

  /** The dwell counterpart of closeIfObservationLost. See that comment. */
  function closeDwellIfObservationLost(at: number): void {
    if (dwell.current().length === 0) return
    if (!isObservationLost(dwellSeenAt, at)) return

    // Every open stream at once: the gap was in our observation, not in any
    // one destination, so they all end at the same last-vouched moment.
    emitDwell(dwell.closeAllAt('observation_lost', dwellSeenAt, at))
    dwellPersistedJson = null
    void deps.dwellStore.write(null)
  }

  /**
   * The dwell counterpart of ensureLifecycle.
   *
   * The staleness RULE is shared with the shared watch (isObservationLost, same
   * constant), but the membership question is not: several intervals come back
   * at once and each one has to be judged against the destination set rather
   * than against a single channel. reconcileDwell holds that policy, and it is
   * pure so every branch is testable without a browser.
   *
   * A restart usually finds some of the world as it left it and some of it
   * gone - two streams open, one tab closed during the outage - so resume and
   * close are applied together rather than as separate decisions.
   */
  async function ensureDwell(channels: readonly string[], at: number): Promise<void> {
    if (dwellRestored) return
    dwellRestored = true

    const stored = await deps.dwellStore.read()
    const decision = reconcileDwell(stored, { userId: deps.selfId(), channels, now: at })

    if (decision.action === 'discard') {
      if (stored) await deps.dwellStore.write(null)
      dwellPersistedJson = null
      return
    }

    dwellSessionId = stored?.sessionId ?? null

    // Everything is installed first, then the departed ones are closed - so
    // each close emits from a real interval with its focus partition intact.
    dwell.restore([...decision.resume, ...decision.close])

    if (decision.close.length > 0) {
      emitDwell(
        dwell.closeAt(
          decision.close.map((state) => state.channel),
          decision.reason,
          decision.effectiveAt,
          at,
        ),
      )
    }

    if (decision.resume.length > 0) {
      dwellPersistedJson = JSON.stringify(dwell.snapshot())
      dwellPersistedAt = stored?.lastSeenAt ?? at
      // Carry the stored moment forward, so the very next tick measures its
      // gap from when we last saw the user rather than from the restart.
      dwellSeenAt = stored?.lastSeenAt ?? at
      return
    }

    await deps.dwellStore.write(null)
    dwellPersistedJson = null
  }

  /**
   * Writes the open interval to storage, or removes it once there is none.
   *
   * Throttled on the last-seen timestamp alone: noteTogether runs on every
   * presence change, which is several times a minute with a few friends
   * online, and rewriting an unchanged interval that often would be silly.
   * Anything that actually changes the interval is written immediately.
   */
  async function persistLifecycle(now: number): Promise<void> {
    const state = together.snapshot()

    if (!state) {
      if (persistedJson !== null) {
        await deps.lifecycleStore.write(null)
        persistedJson = null
      }
      return
    }

    // No actor means nothing we could safely resume under later.
    const userId = deps.selfId()
    if (!userId) return

    const json = JSON.stringify(state)
    if (json === persistedJson && now - persistedAt < LAST_SEEN_WRITE_MS) return

    await deps.lifecycleStore.write({
      userId,
      sessionId: lifecycleSessionId,
      state,
      // The tick's own timestamp, not this write's: writes are throttled, and
      // storing the write time would quietly age the interval by up to the
      // throttle interval every time we skipped one.
      lastSeenAt: lifecycleSeenAt,
    })
    persistedJson = json
    persistedAt = now
  }

  /**
   * Doubts an interval that is still in memory, on every tick.
   *
   * THE CASE THIS EXISTS FOR
   *
   * ensureLifecycle runs once per worker life, which is right for a worker
   * that DIED - it comes back, reads storage, and decides. But an OS suspend
   * freezes a worker without killing it. Such a worker wakes with its state
   * intact and no reason to doubt any of it, so the interval simply carried on
   * and the entire sleep was reported as time spent watching together.
   *
   * That was the one place in the system that could invent viewing time rather
   * than merely lose some, which is the wrong direction to be wrong in.
   *
   * So the same staleness rule is asked on every tick, of the in-memory
   * interval, against the last moment we could vouch for. A frozen worker and
   * a restarted one now produce the same answer.
   *
   * Only the staleness dimension is checked here. Whether the user has changed
   * channel is togetherWatch's own job, and it handles it with a better reason
   * and no grace - taking that decision away from it here would emit the wrong
   * end for an ordinary navigation.
   */
  function closeIfObservationLost(now: number): void {
    if (!together.current()) return
    if (!isObservationLost(lifecycleSeenAt, now)) return

    emitTogether(together.closeAt('observation_lost', lifecycleSeenAt, now))
    persistedJson = null
    void deps.lifecycleStore.write(null)
  }

  /**
   * Reads the stored interval back, once per worker life, and acts on it.
   *
   * Every rule lives in reconcileLifecycle, which is pure; this only applies
   * the decision. Resume installs the interval and emits nothing - the start
   * was recorded before the worker died, and a second one would double-count
   * it. Close emits the ends at the last moment we could vouch for.
   */
  async function ensureLifecycle(channel: string | null, now: number): Promise<void> {
    if (lifecycleRestored) return
    // Set first: a failure below must not make this run again and again, and
    // whatever went wrong, the safe state is "nothing restored".
    lifecycleRestored = true

    const stored = await deps.lifecycleStore.read()
    const decision = reconcileLifecycle(stored, { userId: deps.selfId(), channel, now })

    if (decision.action === 'discard') {
      // Includes another account's interval, which is dropped rather than
      // emitted: the actor is always auth.uid() server-side, so recording it
      // now would file one person's viewing under another's name.
      if (stored) await deps.lifecycleStore.write(null)
      persistedJson = null
      return
    }

    lifecycleSessionId = decision.lifecycle.sessionId
    together.restore(decision.lifecycle.state)

    if (decision.action === 'resume') {
      persistedJson = JSON.stringify(decision.lifecycle.state)
      persistedAt = decision.lifecycle.lastSeenAt
      // Carry the stored moment forward, so the very next tick measures its
      // gap from when we last saw the user rather than from the restart.
      lifecycleSeenAt = decision.lifecycle.lastSeenAt
      return
    }

    emitTogether(together.closeAt(decision.reason, decision.effectiveAt, now))
    await deps.lifecycleStore.write(null)
    persistedJson = null
  }

  return {
    noteActive(): void {
      if (off) return
      serial(async () => {
        const outcome = await session.touch()

        /*
         * A session that expired while nothing was running. Its end is emitted
         * now, but dated to when it actually stopped and tagged with ITS id -
         * not the session that is starting. Getting that wrong would make
         * every overnight gap look like a session lasting until morning.
         */
        if (outcome.expired) {
          recorder.track({
            name: 'extension_session_ended',
            properties: {
              duration_ms: sessionDuration(outcome.expired),
              end_reason: 'idle',
            },
            sessionId: outcome.expired.id,
            occurredAt: outcome.expired.lastActiveAt,
          })
        }

        if (!outcome.resumed) {
          recorder.track({ name: 'extension_session_started' })
        }
      }, 'analytics.noteActive')
    },

    noteSignedIn({ friendCount, groupCount, experimentArm }): void {
      if (off) return
      serial(async () => {
        await session.touch()
        recorder.track({
          name: 'authenticated_session_started',
          properties: {
            friend_count: friendCount,
            group_count: groupCount,
            /*
             * THE ARM GATE, and it lives here rather than at the call site.
             *
             * Outside production every user is forced into `gravity`, so
             * recording the arm there would file a CONSTANT as an experiment
             * result - which is exactly how a fake causal claim reaches a deck.
             * isRandomisedArm() is the existing function that answers "is this
             * a real randomisation", and asking it here means a caller cannot
             * leak a beta arm by passing one: the property is simply dropped.
             *
             * Absent, not 'gravity'. A missing property reads as missing in
             * every query; a literal would have to be excluded by hand in each
             * one, and eventually would not be.
             */
            ...(experimentArm && isRandomisedArm(deps.environment)
              ? { experiment_arm: experimentArm }
              : {}),
          },
        })
        // Anything queued before there was an actor to attribute it to can go
        // now. Until this point the recorder was holding, not dropping.
        await recorder.flush()
      }, 'analytics.noteSignedIn')
    },

    noteSignedOut(): void {
      if (off) return
      serial(async () => {
        /*
         * A worker that started and signed out without ever seeing presence
         * still has an interval in storage. Restoring it first means it is
         * ended properly rather than left to be found - and closed at the last
         * moment we could vouch for, not at the moment of the sign-out.
         */
        await ensureLifecycle(null, now())
        await ensureDwell([], now())
        /*
         * Before stop(), which closes at now(). Signing out after a long sleep
         * must not credit the sleep any more than a heartbeat tick would.
         */
        closeIfObservationLost(now())
        closeDwellIfObservationLost(now())
        emitTogether(together.stop())
        emitDwell(dwell.stop())
        await deps.lifecycleStore.write(null)
        await deps.dwellStore.write(null)
        persistedJson = null
        dwellPersistedJson = null
        lifecycleSessionId = null
        dwellSessionId = null
        const closed = await session.close()
        if (closed) {
          recorder.track({
            name: 'extension_session_ended',
            properties: { duration_ms: sessionDuration(closed), end_reason: 'signed_out' },
            sessionId: closed.id,
          })
        }
        await attribution.clear()
        exposure.reset()
        // Send what belongs to the account that is leaving, then drop anything
        // that did not make it: it must never be attributed to the next one.
        await recorder.flush()
        recorder.clear()
      }, 'analytics.noteSignedOut')
    },

    track(name, properties, options): void {
      if (off) return
      record({
        name,
        properties,
        source: options?.source,
        channel: options?.channel ?? null,
      })
    },

    recordJoin(input): void {
      if (off) return
      const channel = normalizeChannel(input.channel)
      if (!channel) return

      serial(async () => {
        await session.touch()

        /*
         * A click that navigates nowhere gets no attribution.
         *
         * Clicking JOIN on the channel you are already watching is a real
         * click and is recorded as one, but there is no arrival coming - so
         * minting an attribution would leave a pending record that could
         * later be answered by an unrelated navigation back to this channel.
         */
        const minted = input.navigated
          ? await attribution.click({
              channel,
              source: input.source,
              sessionId: session.currentId(),
            })
          : null

        recorder.track({
          name: 'join_clicked',
          properties: {
            social_count: input.socialCount,
            already_on_twitch: input.alreadyOnTwitch,
            already_on_destination: input.alreadyOnDestination,
            navigated: input.navigated,
            /*
             * Only Gravity has an opportunity to name. A friend row is one
             * person and needs no key; a cluster is a thing several people act
             * on separately, and counting how many viewers ONE gathering
             * produced needs them all to write down the same name for it.
             */
            ...(input.source === 'social_gravity'
              ? { opportunity_key: opportunityKey(channel, now()) }
              : {}),
          },
          source: input.source,
          channel,
          attributionId: minted?.id ?? null,
        })

        // The navigation is about to tear the tab down; get this out now
        // rather than hoping the worker survives to the next flush.
        await recorder.flush()

        /*
         * M3D: the follow baseline, strictly after the JOIN is durable.
         *
         * ORDERING. This runs after `flush()` resolved, and it is gated on the
         * queue having drained - so the canonical join_clicked the server will
         * be asked to bind has already been accepted by that server. Nothing
         * here sleeps, widens a window, or hopes.
         *
         * NOT AWAITED. Deliberately detached from the serial chain rather than
         * held inside it. A Twitch round trip inside this queue would sit in
         * front of `noteChannel`, whose arrival timestamp is taken when it is
         * processed - so awaiting here would inflate `join_arrived.elapsed_ms`
         * on every measured JOIN. Measurement must not distort the product's
         * own numbers any more than it distorts the product.
         *
         * The user is not waiting on any of this. The browser navigated to
         * Twitch in the content script before this message was even posted.
         */
        const decision = decideMeasurement({
          navigated: input.navigated,
          attributionId: minted?.id ?? null,
          socialCount: input.socialCount,
          readiness: deps.measurementReadiness?.() ?? null,
          pendingEvents: recorder.pending(),
        })
        if (!decision.measure || !deps.measureRelationship) return

        void deps
          .measureRelationship({ broadcasterLogin: channel, attributionId: minted!.id })
          // Swallowed on purpose. A failed baseline is a JOIN with no
          // observation, which is the honest outcome; it is never a user-facing
          // error and never a reason to try again later under a column that
          // says "at join".
          .catch((error) => report('analytics.measureRelationship', error))
      }, 'analytics.recordJoin')
    },

    noteChannel(channel): void {
      if (off) return
      const login = normalizeChannel(channel)
      serial(async () => {
        await session.touch()
        const arrived = await attribution.arrive(login)
        if (!arrived) return

        recorder.track({
          name: 'join_arrived',
          properties: { elapsed_ms: Math.max(0, (arrived.arrivedAt ?? now()) - arrived.clickedAt) },
          source: arrived.source as AnalyticsSurface,
          channel: arrived.channel,
          attributionId: arrived.id,
        })
        // Hand it to the shared-watch detector, so if friends are already here
        // the session that follows is credited to the JOIN that caused it.
        together.attribute(arrived.id)
      }, 'analytics.noteChannel')
    },

    noteTogether({ channel, otherCount, streams = [], openChannels = [] }): void {
      if (off) return
      const login = normalizeChannel(channel)
      /*
       * Normalised here, once, so a caller cannot introduce a channel spelling
       * the envelope would reject later. Anything that fails the login rule is
       * dropped rather than guessed at.
       */
      const observed: DwellStream[] = []
      for (const stream of streams) {
        const channelLogin = normalizeChannel(stream.channel)
        if (channelLogin) observed.push({ ...stream, channel: channelLogin })
      }
      const stillOpen = new Set<string>()
      for (const candidate of openChannels) {
        const channelLogin = normalizeChannel(candidate)
        if (channelLogin) stillOpen.add(channelLogin)
      }
      serial(async () => {
        /*
         * Before anything else, and only once per worker life: whatever
         * interval was open when the last worker died is either resumed or
         * closed here. Doing it lazily rather than at startup means there is
         * no ordering to get wrong - this is the first place that needs it.
         */
        await ensureLifecycle(login, now())
        await ensureDwell(
          observed.map((stream) => stream.channel),
          now(),
        )

        /*
         * Then doubt it again, every time.
         *
         * A worker that was merely frozen by an OS suspend comes back with its
         * state intact and would otherwise carry the interval straight through
         * the sleep. This is the tick that stops the gap being counted.
         */
        closeIfObservationLost(now())
        closeDwellIfObservationLost(now())

        /*
         * A shared watch beginning on a channel a JOIN led to is that JOIN's
         * outcome even if presence took a minute to catch up.
         *
         * Asked of the tracker rather than of `current()`: a post-social
         * interval is open state, but the shared watch that follows it if
         * somebody comes back inherits the attribution already held, so
         * looking one up again would be wrong as well as wasteful.
         */
        /*
         * Attribution is looked up PER DESTINATION, and only for the one a
         * JOIN actually led to.
         *
         * forTogether() answers for one channel and returns null for any other,
         * so a second stream open at the same time cannot inherit the first
         * one's credit. That isolation is the whole reason this asks per
         * channel rather than once for "the current attribution".
         */
        const needsCredit = new Set<string>()
        if (login && together.wantsAttribution()) needsCredit.add(login)
        for (const stream of observed) {
          if (dwell.wantsAttribution(stream.channel)) needsCredit.add(stream.channel)
        }
        for (const candidate of needsCredit) {
          const credit = await attribution.forTogether(candidate)
          if (!credit) continue
          if (candidate === login && together.wantsAttribution()) together.attribute(credit.id)
          if (dwell.wantsAttribution(candidate)) dwell.attribute(candidate, credit.id)
        }
        emitTogether(together.update({ channel: login, otherCount }))

        /*
         * Dwell is driven AFTER the shared watch, in the same tick, and its
         * social flag is read from the shared-watch machine's own state rather
         * than from a friend count.
         *
         * PER STREAM. The shared watch is single-channel by design, so only the
         * stream it currently holds can be marked social - a background stream
         * where friends happen to be is NOT claimed as shared viewing, because
         * the shared-watch lifecycle never opened an interval there. That
         * under-reports, which is the direction to be wrong in, and it keeps
         * had_social meaning exactly "the shared watch was open on this
         * stream".
         *
         * The flag is sticky inside channelDwell, so a stream whose social part
         * ended an hour ago is still had_social - which is why this reads
         * current() rather than trying to catch the moment it was open.
         */
        const socialChannel = together.current()?.channel ?? null
        emitDwell(
          dwell.update({
            streams: observed.map((stream) => ({
              ...stream,
              social: stream.channel === socialChannel,
            })),
            reasonFor: (channel) => (stillOpen.has(channel) ? 'stream_ended' : 'left_channel'),
          }),
        )

        // This tick is now the last moment we can vouch for, and the stored
        // copy is written from it - see persistLifecycle.
        if (together.current()) lifecycleSeenAt = now()
        if (dwell.current().length > 0) dwellSeenAt = now()
        await persistLifecycle(now())
        await persistDwell(now())
      }, 'analytics.noteTogether')
    },

    noteExposure(report): void {
      if (off) return

      const keyed = new Map<string, { name: AnalyticsEventName; props: Record<string, unknown>; channel: string }>()

      for (const friend of report.friends) {
        const channel = normalizeChannel(friend.channel)
        if (!channel) continue
        keyed.set(friendPresenceKey(friend.userId, channel), {
          name: 'friend_presence_impression',
          props: { state: friend.state, visible_count: report.friends.length },
          channel,
        })
      }

      for (const gathering of report.gatherings) {
        const channel = normalizeChannel(gathering.channel)
        if (!channel) continue
        keyed.set(gatheringKey(channel), {
          name: 'gathering_impression',
          props: {
            friend_count: gathering.friendCount,
            rank: gathering.rank,
            visible_count: report.gatherings.length,
          },
          channel,
        })
      }

      for (const cluster of report.gravity) {
        const channel = normalizeChannel(cluster.channel)
        if (!channel) continue
        keyed.set(gravityClusterKey(channel), {
          name: 'gravity_cluster_impression',
          props: {
            friend_count: cluster.friendCount,
            rank: cluster.rank,
            visible_clusters: report.gravity.length,
            /*
             * Derived here rather than sent, so the impression and the JOIN
             * that may follow it cannot disagree about which opportunity they
             * were - both call the same function with the same clock.
             */
            opportunity_key: opportunityKey(channel, now()),
            /*
             * Whether the destination was actually streaming.
             *
             * Omitted entirely when nothing told us, rather than sent as
             * "unknown": a property that is absent reads as absent in every
             * query, whereas a literal "unknown" would have to be excluded by
             * hand in each one, and eventually would not be.
             *
             * This is the ONLY Twitch field analytics carries. Titles, viewer
             * counts, categories and avatars answer no question we have.
             */
            ...(cluster.live && cluster.live !== 'unknown'
              ? { destination_live: cluster.live === 'live' }
              : {}),
          },
          channel,
        })
      }

      for (const key of exposure.observe([...keyed.keys()])) {
        const entry = keyed.get(key)
        if (!entry) continue
        record({
          name: entry.name,
          properties: entry.props as never,
            source:
            entry.name === 'gathering_impression'
              ? 'gathering'
              : entry.name === 'gravity_cluster_impression'
                ? 'social_gravity'
                : 'friend_row',
          channel: entry.channel,
        })
      }
    },

    flush: () => (off ? Promise.resolve() : recorder.flush()),
    recorder: () => recorder,
  }
}
