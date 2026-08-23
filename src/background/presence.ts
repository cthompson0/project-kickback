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
  onError?: (context: string, error: unknown) => void
}

export interface PresenceReporter {
  /** Tell the reporter what the user is doing now. */
  setActivity(activity: Activity): void
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

    stop(): void {
      clearTimeout(writeTimer)
      clearTimeout(offlineTimer)
      stopHeartbeat()
      writeTimer = undefined
      offlineTimer = undefined
      desired = IDLE
      reported = null
    },

    async goOffline(): Promise<void> {
      clearTimeout(writeTimer)
      clearTimeout(offlineTimer)
      writeTimer = undefined
      offlineTimer = undefined
      stopHeartbeat()
      desired = IDLE
      await write(IDLE)
      reported = null
    },

    lastReported: () => reported,
  }
}
