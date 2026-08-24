/**
 * What a Kickback session is, precisely.
 *
 * A session is a stretch of the user being on Twitch with Kickback loaded. It
 * OPENS the first time a Twitch tab reports activity, and CLOSES after
 * IDLE_MS with no Twitch tab open at all. Signing out closes it too.
 *
 * WHY IT IS DEFINED ON TAB LIFECYCLE
 *
 * Kickback already knows exactly this, from the activity registry that drives
 * presence: how many Twitch tabs exist and which one the user is looking at.
 * Inventing a second notion of "active" would mean two answers to the same
 * question, and the analytics one would be the one nobody noticed drifting.
 * So this reads the registry rather than tracking anything itself.
 *
 * WHY IT IS STORED
 *
 * An MV3 service worker is killed after about thirty seconds idle. A session
 * held in memory would end every time the user stopped clicking, and every
 * evening would look like forty sessions. So the id and the last-active
 * timestamp live in chrome.storage.local, and a worker waking up inside the
 * idle window RESUMES the session it finds rather than starting a new one.
 *
 * That is also why `extension_session_ended` is best-effort and says so. A
 * browser that is quit outright never runs anything again; the end is emitted
 * later, when something wakes up and finds an expired session, carrying the
 * true end time. A browser that is never opened again emits nothing at all -
 * which is why every duration question is answered from the session's first
 * and last event in SQL, and the explicit end event is only a cross-check.
 */

export interface SessionRecord {
  id: string
  startedAt: number
  lastActiveAt: number
}

export interface SessionStore {
  read(): Promise<SessionRecord | null>
  write(record: SessionRecord | null): Promise<void>
}

export interface SessionOutcome {
  /** The session that is now open. */
  current: SessionRecord
  /** True when an existing session was picked up rather than a new one begun. */
  resumed: boolean
  /**
   * A session that had already expired, discovered on the way in. Its end has
   * not been reported yet, and it ended at `lastActiveAt` - not now.
   */
  expired: SessionRecord | null
}

/** Thirty minutes: long enough to survive a break, short enough to mean something. */
export const SESSION_IDLE_MS = 30 * 60 * 1000

export interface AnalyticsSessionDeps {
  store: SessionStore
  now?: () => number
  newId?: () => string
  idleMs?: number
}

export interface AnalyticsSession {
  /**
   * Called whenever there is any sign of life. Opens a session if none is
   * running, resumes one inside the idle window, and reports any expired
   * session it displaced so its end can be recorded.
   */
  touch(): Promise<SessionOutcome>
  /** The open session, without opening one. */
  peek(): Promise<SessionRecord | null>
  /** Close the current session deliberately. Returns what was closed. */
  close(): Promise<SessionRecord | null>
  /** The session id held in memory, for events emitted between touches. */
  currentId(): string | null
}

export function createAnalyticsSession(deps: AnalyticsSessionDeps): AnalyticsSession {
  const now = deps.now ?? (() => Date.now())
  const idleMs = deps.idleMs ?? SESSION_IDLE_MS
  const newId = deps.newId ?? (() => crypto.randomUUID())

  /*
   * A cache, not the truth. The truth is in storage, because another wake-up
   * of this worker may have moved on; this only saves a read for the events
   * that fire between touches.
   */
  let cached: string | null = null

  return {
    async touch(): Promise<SessionOutcome> {
      const at = now()
      const existing = await deps.store.read()

      if (existing && at - existing.lastActiveAt < idleMs) {
        const current = { ...existing, lastActiveAt: at }
        await deps.store.write(current)
        cached = current.id
        // Resumed only when this worker did not already know about it: a
        // second touch inside one worker's life is not a new session start.
        return { current, resumed: true, expired: null }
      }

      const current: SessionRecord = { id: newId(), startedAt: at, lastActiveAt: at }
      await deps.store.write(current)
      cached = current.id
      return { current, resumed: false, expired: existing }
    },

    peek: () => deps.store.read(),

    async close(): Promise<SessionRecord | null> {
      const existing = await deps.store.read()
      await deps.store.write(null)
      cached = null
      return existing
    },

    currentId: () => cached,
  }
}

/** True when this session has been quiet long enough to be over. */
export function hasExpired(
  record: SessionRecord,
  at: number,
  idleMs: number = SESSION_IDLE_MS,
): boolean {
  return at - record.lastActiveAt >= idleMs
}

/** How long a session lasted, from its own timestamps. */
export function sessionDuration(record: SessionRecord): number {
  return Math.max(0, record.lastActiveAt - record.startedAt)
}
