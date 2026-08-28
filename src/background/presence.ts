import { IDLE } from '../core/types'
import type { Activity } from '../core/types'
import type { BackendResult } from './auth'

/**
 * Reports what the local user is doing, and keeps saying so.
 *
 * Four jobs, all of them about not lying:
 *
 *   - report a change promptly, but debounced, so clicking through five
 *     channels writes once rather than five times;
 *   - heartbeat while online, so friends can tell the difference between
 *     "still here" and "closed the laptop";
 *   - keep the published destinations from ageing out from under a viewer who
 *     has simply been watching for a while;
 *   - when the last Twitch tab goes, say so - but not instantly, because
 *     clicking JOIN closes one tab's port and opens another a moment later,
 *     and flashing offline in between would look broken.
 *
 * ONE WRITE PER STATE. THIS IS THE LOAD-BEARING RULE.
 *
 * There are two server entry points that can set our presence, and they do
 * not compose: report_destinations publishes a SET, and report_presence
 * publishes a SINGLETON - and 0025's compatibility shim makes the singleton
 * REPLACE the set, because that is exactly what an old client means by it.
 *
 * So this reporter decides, once, which of them expresses the current state,
 * and issues that one and only that one:
 *
 *   idle                        -> reportOffline()
 *   any stream open             -> reportDestinations(the whole set)
 *   on Twitch, nothing open     -> reportPresence('twitch', null)
 *
 * The watching case never reaches report_presence, because report_destinations
 * already maintains the legacy presence row - status, platform, and channel
 * set to the primary destination - on the way past. Sending both meant two
 * concurrent requests with no ordering between them, and whenever the
 * singleton landed second it deleted every destination but one. That was the
 * multi-destination smoke failure, and this is the shape that prevents it
 * rather than the shape that sequences it: there is no second write to order.
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
   * How long a published destination may go unrefreshed.
   *
   * A destination is ACTIVE for thirty minutes after its last_active_at, and
   * nothing else in the system touches that column: the heartbeat only moves
   * presence.last_seen_at. So a viewer who opens two streams and then simply
   * watches - no navigation, no new tab - would have both rows expire out from
   * under them after half an hour and collapse back to the legacy singleton.
   *
   * Well inside that window, and cheap: the presence budget is ninety writes a
   * minute, and this is six an hour.
   */
  destinationRefreshMs?: number
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
/** A third of the thirty-minute destination window. Two may be missed. */
const DEFAULT_DESTINATION_REFRESH_MS = 600_000

/** Order matters: it decides the legacy primary, so a reorder is a change. */
function sameChannels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((channel, index) => channel === b[index])
}

/**
 * What the server has been told, in the shape it was told it.
 *
 * Intent is compared against this rather than against the pieces it was built
 * from, because the two entry points overlap: publishing the set ["a"] and
 * publishing the singleton "a" leave the same rows behind but are not the same
 * call, and only one of them is right for a given state.
 */
type Publication =
  | { kind: 'offline' }
  | { kind: 'destinations'; channels: readonly string[] }
  | { kind: 'presence'; channel: string | null }

function samePublication(a: Publication, b: Publication): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'destinations' && b.kind === 'destinations') {
    return sameChannels(a.channels, b.channels)
  }
  if (a.kind === 'presence' && b.kind === 'presence') return a.channel === b.channel
  return true
}

/** The destinations a publication leaves standing on the server. */
function publishedChannels(publication: Publication | null): readonly string[] {
  if (!publication) return []
  if (publication.kind === 'destinations') return publication.channels
  if (publication.kind === 'presence' && publication.channel) return [publication.channel]
  return []
}

export function createPresenceReporter(deps: PresenceReporterDeps): PresenceReporter {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const graceMs = deps.offlineGraceMs ?? DEFAULT_OFFLINE_GRACE_MS
  const refreshMs = deps.destinationRefreshMs ?? DEFAULT_DESTINATION_REFRESH_MS

  /** What the client wants the world to see. */
  let desired: Activity = IDLE
  let desiredDestinations: readonly string[] = []

  /** What it has actually been told, and when. */
  let published: Publication | null = null
  let publishedAt = 0
  let reported: Activity | null = null

  /**
   * Set when the published state is correct but old enough to need saying
   * again, so the settled check does not skip the refresh.
   */
  let stale = false
  let writing = false

  let writeTimer: ReturnType<typeof setTimeout> | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let offlineTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * The one call that expresses the current state.
   *
   * Deciding this in a single place is the whole fix: an open stream is
   * published as a SET and never also as a singleton, so nothing can arrive
   * after the set and narrow it.
   */
  function intended(): Publication {
    if (desired.type === 'idle') return { kind: 'offline' }
    if (desiredDestinations.length > 0) {
      return { kind: 'destinations', channels: desiredDestinations }
    }
    /*
     * On Twitch with no stream open. report_presence(platform, null) is what
     * says that, and its shim clears the destination rows - which is correct
     * here, and only here.
     */
    return { kind: 'presence', channel: desired.type === 'watching' ? desired.channel : null }
  }

  function settled(): boolean {
    return !stale && published !== null && samePublication(intended(), published)
  }

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

      /*
       * And, occasionally, say the destinations again.
       *
       * The heartbeat moves presence.last_seen_at and nothing else. Without
       * this, thirty minutes of uninterrupted watching would expire every
       * destination row and drop the viewer back to their legacy single
       * channel - the same collapse, arriving slowly instead of at once.
       */
      if (publishedChannels(published).length > 0 && Date.now() - publishedAt >= refreshMs) {
        stale = true
        flushNow()
      }
    }, heartbeatMs)
  }

  /**
   * Issue exactly one write, and record what it made true.
   *
   * Resolves false when the write failed, which is what stops the caller
   * re-arming: a failing backend must not become a write storm.
   */
  async function publish(): Promise<boolean> {
    const target = intended()
    const activity = desired
    // A genuine change, or the periodic refresh? Analytics only wants the
    // former, and the cap event is meaningless for a re-statement.
    const changed = published === null || !samePublication(target, published)

    if (target.kind === 'offline') {
      const result = await deps.backend.reportOffline()
      if (result.error) {
        deps.onError?.('reportOffline', result.error)
        return false
      }
      published = target
      publishedAt = Date.now()
      stale = false
      reported = activity
      stopHeartbeat()
      deps.onReported?.(activity)
      return true
    }

    if (target.kind === 'destinations') {
      const result = await deps.backend.reportDestinations(target.channels)
      if (result.error) {
        // Leave the published record alone, so the next change still counts
        // as a change and is retried.
        deps.onError?.('reportDestinations', result.error)
        return false
      }
      published = target
      publishedAt = Date.now()
      stale = false
      reported = activity
      startHeartbeat()
      deps.onReported?.(activity)
      if (changed) {
        deps.onDestinations?.({
          requested: target.channels.length,
          published: result.value ?? 0,
        })
      }
      return true
    }

    const result = await deps.backend.reportPresence('twitch', target.channel)
    if (result.error) {
      deps.onError?.('reportPresence', result.error)
      return false
    }
    published = target
    publishedAt = Date.now()
    stale = false
    reported = activity
    startHeartbeat()
    deps.onReported?.(activity)
    return true
  }

  function flushNow(): void {
    if (settled()) return
    if (writing) {
      // A write is already on the wire. Come back after it rather than put a
      // second one beside it - that overlap is the bug this file exists to
      // rule out.
      flushSoon()
      return
    }
    writing = true
    void publish()
      .then((ok) => {
        writing = false
        // Only chase our own tail on success. On failure the next real change
        // re-arms, exactly as it always did.
        if (ok) flushSoon()
      })
      .catch(() => {
        writing = false
      })
  }

  function flushSoon(): void {
    clearTimeout(writeTimer)
    writeTimer = undefined
    if (settled()) return
    writeTimer = setTimeout(() => {
      writeTimer = undefined
      flushNow()
    }, debounceMs)
  }

  return {
    setActivity(activity: Activity): void {
      clearTimeout(offlineTimer)
      offlineTimer = undefined

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
          flushNow()
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
      flushSoon()
    },

    lastDestinations: () => publishedChannels(published),

    stop(): void {
      clearTimeout(writeTimer)
      clearTimeout(offlineTimer)
      stopHeartbeat()
      writeTimer = undefined
      offlineTimer = undefined
      desired = IDLE
      desiredDestinations = []
      published = null
      publishedAt = 0
      stale = false
      reported = null
    },

    async goOffline(): Promise<void> {
      clearTimeout(writeTimer)
      clearTimeout(offlineTimer)
      writeTimer = undefined
      offlineTimer = undefined
      stopHeartbeat()
      desired = IDLE
      /*
       * report_offline deletes the destination rows server-side, so the local
       * record of what is published has to be cleared with it - otherwise
       * signing back in with the same streams open would look unchanged and
       * publish nothing.
       */
      desiredDestinations = []
      stale = false
      await publish()
      published = null
      publishedAt = 0
      reported = null
    },

    lastReported: () => reported,
  }
}
