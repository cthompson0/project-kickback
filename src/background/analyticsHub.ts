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
import { normalizeChannel } from '../core/analytics'
import type {
  AnalyticsEnvironment,
  AnalyticsEventMap,
  AnalyticsEventName,
  AnalyticsSurface,
} from '../core/analytics'

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
  /** True once there is a signed-in user to attribute events to. */
  canSend: () => boolean
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
        recorder.track({
          name: 'watching_together_started',
          properties: { other_count: event.otherCount, from_join: event.attributionId !== null },
          channel: event.channel,
          attributionId: event.attributionId,
          occurredAt: event.at,
        })
      } else {
        recorder.track({
          name: 'watching_together_ended',
          properties: {
            other_count_peak: event.otherCountPeak,
            duration_ms: event.durationMs,
            end_reason: event.reason,
          },
          channel: event.channel,
          attributionId: event.attributionId,
          occurredAt: event.at,
        })
      }
    }
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
        emitTogether(together.stop())
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
        // A shared watch beginning on a channel a JOIN led to is that JOIN's
        // outcome even if presence took a minute to catch up.
        if (login && !together.current()) {
          const credit = await attribution.forTogether(login)
          if (credit) together.attribute(credit.id)
        }
        emitTogether(together.update({ channel: login, otherCount }))
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
