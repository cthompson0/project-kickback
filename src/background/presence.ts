import { IDLE } from '../core/types'
import type { Activity } from '../core/types'
import type { BackendResult } from './auth'

/**
 * Reports what the local user is doing, and keeps saying so.
 *
 * Three jobs, all of them about not lying:
 *
 *   - report a change promptly, but debounced, so clicking through five
 *     channels writes once rather than five times;
 *   - heartbeat while online, so friends can tell the difference between
 *     "still here" and "closed the laptop";
 *   - when the last Twitch tab goes, say so - but not instantly, because
 *     clicking JOIN closes one tab's port and opens another a moment later,
 *     and flashing offline in between would look broken.
 */

export interface PresenceBackend {
  reportPresence(platform: string | null, channel: string | null): Promise<BackendResult<true>>
  /**
   * Publish the whole set of open destinations, most-recently-active first.
   *
   * Resolves to how many the server actually kept, which is not always what
   * was sent: the cap of three is enforced there, and this is how the client
   * learns it was reached without having to guess.
   */
  reportDestinations(channels: readonly string[]): Promise<BackendResult<number>>
  heartbeat(): Promise<BackendResult<true>>
  reportOffline(): Promise<BackendResult<true>>
}

export interface PresenceReporterDeps {
  backend: PresenceBackend
  /** Collapses rapid Twitch navigation into a single write. */
  debounceMs?: number
  /** How often to say "still here" while online. */
  heartbeatMs?: number
  /** How long to wait before declaring offline after the last tab goes. */
  offlineGraceMs?: number
  /**
   * Called on every heartbeat tick, before the write.
   *
   * The one periodic signal that exists only while the worker is alive AND
   * the user is online. Analytics uses it to keep the open shared watch's
   * last-seen timestamp fresh, so a service-worker restart can be told apart
   * from a laptop that was shut for three hours - which is otherwise exactly
   * the same thing from the far side of the gap.
   */
  onHeartbeat?: () => void
  /**
   * Called once a write has landed, with what the world can now see.
   *
   * The one moment anything downstream can know our own presence ROW exists,
   * which some server calls require. `stream_room_members` refuses unless the
   * caller's presence says they are on the channel - so a client that asked
   * before this fired got a correct, empty, and permanently cached answer.
   *
   * Fires on the write, not on the intent: `setActivity` is debounced by a
   * second, and the gap between the two is exactly where that race lived.
   */
  onReported?: (activity: Activity) => void
  /**
   * A destination set was published, with what the server kept.
   *
   * Analytics hangs off this rather than off the intent, for the same reason
   * onReported does: what was written is the fact, and `published` may be
   * smaller than `requested` when the cap bit.
   */
  onDestinations?: (published: { requested: number; published: number }) => void
  onError?: (context: string, error: unknown) => void
}

export interface PresenceReporter {
  /** Tell the reporter what the user is doing now. */
  setActivity(activity: Activity): void
  /**
   * Tell the reporter which streams are open, most-recently-active first.
   *
   * Debounced on the same clock as the activity write and skipped entirely
   * when the set has not changed, so switching between two already-open Twitch
   * tabs costs nothing at all - no write, no realtime event, and nothing that
   * any friend can observe. That is the point of the whole design: focus is
   * not a network event.
   */
  setDestinations(channels: readonly string[]): void
  /** The last set successfully published, for diagnostics and tests. */
  lastDestinations(): readonly string[]
  /** Stop reporting and forget state, without announcing offline. */
  stop(): void
  /** Announce offline immediately and stop. */
  goOffline(): Promise<void>
  /** Last activity successfully written, for diagnostics and tests. */
  lastReported(): Activity | null
}

const DEFAULT_DEBOUNCE_MS = 1_000
/** Half the 90s staleness window, so one lost beat is not enough to look gone. */
const DEFAULT_HEARTBEAT_MS = 45_000
const DEFAULT_OFFLINE_GRACE_MS = 5_000

/** Order matters: it decides the legacy primary, so a reorder is a change. */
function sameChannels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((channel, index) => channel === b[index])
}

function isSame(a: Activity, b: Activity): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'watching' && b.type === 'watching') {
    return a.platform === b.platform && a.channel === b.channel
  }
  return true
}

export function createPresenceReporter(deps: PresenceReporterDeps): PresenceReporter {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const graceMs = deps.offlineGraceMs ?? DEFAULT_OFFLINE_GRACE_MS

  let desired: Activity = IDLE
  let reported: Activity | null = null
  /** What the client wants published, and what actually is. */
  let desiredDestinations: readonly string[] = []
  let reportedDestinations: readonly string[] = []
  let destinationTimer: ReturnType<typeof setTimeout> | undefined
  let writeTimer: ReturnType<typeof setTimeout> | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let offlineTimer: ReturnType<typeof setTimeout> | undefined

  function stopHeartbeat(): void {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
  }

  function startHeartbeat(): void {
    if (heartbeatTimer !== undefined) return
    heartbeatTimer = setInterval(() => {
      // Before the write, and regardless of whether it succeeds: this says
      // the worker is running and the user is online, which is true either way.
      deps.onHeartbeat?.()
      void deps.backend.heartbeat().then((result) => {
        if (result.error) deps.onError?.('heartbeat', result.error)
      })
    }, heartbeatMs)
  }

  async function write(activity: Activity): Promise<void> {
    if (activity.type === 'idle') {
      const result = await deps.backend.reportOffline()
      if (result.error) {
        deps.onError?.('reportOffline', result.error)
        return
      }
      reported = activity
      stopHeartbeat()
      deps.onReported?.(activity)
      return
    }

    const channel = activity.type === 'watching' ? activity.channel : null
    const result = await deps.backend.reportPresence('twitch', channel)
    if (result.error) {
      // Leave `reported` alone so the next change still counts as a change and
      // gets retried. No immediate retry loop: a failing backend must not turn
      // into a write storm.
      deps.onError?.('reportPresence', result.error)
      return
    }
    reported = activity
    startHeartbeat()
    deps.onReported?.(activity)
  }

  async function writeDestinations(channels: readonly string[]): Promise<void> {
    const result = await deps.backend.reportDestinations(channels)
    if (result.error) {
      // Leave reportedDestinations alone, so the next change still counts as a
      // change and is retried. No immediate retry: a failing backend must not
      // become a write storm.
      deps.onError?.('reportDestinations', result.error)
      return
    }
    reportedDestinations = channels
    deps.onDestinations?.({ requested: channels.length, published: result.value ?? 0 })
  }

  function flushDestinationsSoon(): void {
    clearTimeout(destinationTimer)
    destinationTimer = setTimeout(() => {
      destinationTimer = undefined
      if (sameChannels(desiredDestinations, reportedDestinations)) return
      void writeDestinations(desiredDestinations)
    }, debounceMs)
  }

  function flushSoon(): void {
    clearTimeout(writeTimer)
    writeTimer = setTimeout(() => {
      writeTimer = undefined
      if (reported && isSame(desired, reported)) return
      void write(desired)
    }, debounceMs)
  }

  return {
    setActivity(activity: Activity): void {
      clearTimeout(offlineTimer)
      offlineTimer = undefined

      if (isSame(activity, desired) && reported && isSame(activity, reported)) return
      desired = activity

      if (activity.type === 'idle') {
        // Do not announce offline the instant a tab goes: JOIN tears one tab
        // down and brings another up, and a blip of offline in between reads
        // as a bug to whoever is watching.
        clearTimeout(writeTimer)
        writeTimer = undefined
        offlineTimer = setTimeout(() => {
          offlineTimer = undefined
          if (desired.type !== 'idle') return
          void write(IDLE)
        }, graceMs)
        return
      }

      flushSoon()
    },

    setDestinations(channels: readonly string[]): void {
      const next = [...channels]
      if (sameChannels(next, desiredDestinations)) return
      desiredDestinations = next
      /*
       * An empty set is written promptly rather than on the offline grace:
       * closing your last Twitch tab should stop advertising the stream even
       * if the account stays online for a moment. Going offline entirely is
       * still handled by setActivity, which clears the rows server-side.
       */
      flushDestinationsSoon()
    },

    lastDestinations: () => reportedDestinations,

    stop(): void {
      clearTimeout(writeTimer)
      clearTimeout(offlineTimer)
      clearTimeout(destinationTimer)
      destinationTimer = undefined
      desiredDestinations = []
      reportedDestinations = []
      stopHeartbeat()
      writeTimer = undefined
      offlineTimer = undefined
      desired = IDLE
      reported = null
    },

    async goOffline(): Promise<void> {
      clearTimeout(writeTimer)
      clearTimeout(offlineTimer)
      clearTimeout(destinationTimer)
      writeTimer = undefined
      offlineTimer = undefined
      destinationTimer = undefined
      stopHeartbeat()
      desired = IDLE
      /*
       * report_offline deletes the destination rows server-side, so the local
       * record of what is published has to be cleared with it - otherwise
       * signing back in with the same streams open would look unchanged and
       * publish nothing.
       */
      desiredDestinations = []
      reportedDestinations = []
      await write(IDLE)
      reported = null
    },

    lastReported: () => reported,
  }
}
