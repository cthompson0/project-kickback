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
import type { AnalyticsBackend, AnalyticsRecorder } from './analytics'
import { createAnalyticsSession, sessionDuration } from './analyticsSession'
import type { SessionStore } from './analyticsSession'
import { createJoinAttribution } from './joinAttribution'
import type { AttributionStore } from './joinAttribution'
import { createExposureTracker, friendPresenceKey, gatheringKey } from './exposure'
import { createTogetherWatch } from './togetherWatch'
import { isObservationLost, reconcileLifecycle } from './togetherStore'
import type { PersistedLifecycle } from './togetherStore'
import type { StoredValue } from './storedValue'
import { normalizeChannel } from '../core/analytics'
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
}

export interface AnalyticsHubDeps {
  backend: AnalyticsBackend
  environment: AnalyticsEnvironment
  appVersion: string | null
  enabled: boolean
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
  now?: () => number
  onError?: (context: string, error: unknown) => void
}

export interface AnalyticsHub {
  /** Any sign of life on Twitch: opens a session, or keeps the open one alive. */
  noteActive(): void
  /** A signed-in session now exists. Flushes whatever was waiting for an actor. */
  noteSignedIn(counts: { friendCount: number; groupCount: number }): void
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
  /** Who else is on this channel with them. Emits the shared-watch transitions. */
  noteTogether(input: { channel: string | null; otherCount: number }): void
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

  const recorder = createAnalyticsRecorder({
    backend: deps.backend,
    environment: deps.environment,
    appVersion: deps.appVersion,
    enabled: deps.enabled,
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

    noteSignedIn({ friendCount, groupCount }): void {
      if (off) return
      serial(async () => {
        await session.touch()
        recorder.track({
          name: 'authenticated_session_started',
          properties: { friend_count: friendCount, group_count: groupCount },
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
        /*
         * Before stop(), which closes at now(). Signing out after a long sleep
         * must not credit the sleep any more than a heartbeat tick would.
         */
        closeIfObservationLost(now())
        emitTogether(together.stop())
        await deps.lifecycleStore.write(null)
        persistedJson = null
        lifecycleSessionId = null
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
          },
          source: input.source,
          channel,
          attributionId: minted?.id ?? null,
        })

        // The navigation is about to tear the tab down; get this out now
        // rather than hoping the worker survives to the next flush.
        await recorder.flush()
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

    noteTogether({ channel, otherCount }): void {
      if (off) return
      const login = normalizeChannel(channel)
      serial(async () => {
        /*
         * Before anything else, and only once per worker life: whatever
         * interval was open when the last worker died is either resumed or
         * closed here. Doing it lazily rather than at startup means there is
         * no ordering to get wrong - this is the first place that needs it.
         */
        await ensureLifecycle(login, now())

        /*
         * Then doubt it again, every time.
         *
         * A worker that was merely frozen by an OS suspend comes back with its
         * state intact and would otherwise carry the interval straight through
         * the sleep. This is the tick that stops the gap being counted.
         */
        closeIfObservationLost(now())

        /*
         * A shared watch beginning on a channel a JOIN led to is that JOIN's
         * outcome even if presence took a minute to catch up.
         *
         * Asked of the tracker rather than of `current()`: a post-social
         * interval is open state, but the shared watch that follows it if
         * somebody comes back inherits the attribution already held, so
         * looking one up again would be wrong as well as wasteful.
         */
        if (login && together.wantsAttribution()) {
          const credit = await attribution.forTogether(login)
          if (credit) together.attribute(credit.id)
        }
        emitTogether(together.update({ channel: login, otherCount }))

        // This tick is now the last moment we can vouch for, and the stored
        // copy is written from it - see persistLifecycle.
        if (together.current()) lifecycleSeenAt = now()
        await persistLifecycle(now())
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

      for (const key of exposure.observe([...keyed.keys()])) {
        const entry = keyed.get(key)
        if (!entry) continue
        record({
          name: entry.name,
          properties: entry.props as never,
          source: entry.name === 'gathering_impression' ? 'gathering' : 'friend_row',
          channel: entry.channel,
        })
      }
    },

    flush: () => (off ? Promise.resolve() : recorder.flush()),
    recorder: () => recorder,
  }
}
