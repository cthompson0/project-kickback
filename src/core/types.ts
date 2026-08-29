/**
 * Watchside core domain types.
 *
 * These are deliberately platform-agnostic: a friend is a `User` with a
 * `Presence`, and what they are doing is an `Activity`. Twitch is currently the
 * only supported `Platform`, and all Twitch-specific behaviour lives in
 * `src/platforms/twitch`.
 */

export type Platform = 'twitch'

export interface User {
  id: string
  /** Stable handle. */
  username: string
  /** What we render. */
  displayName: string
  /** Real profile image when the platform gave us one. */
  avatarUrl?: string | null
  /** Placeholder avatar tint. Derived from the id when absent. */
  accentColor?: string
}

/** Watching a live channel on some platform. */
export interface WatchingActivity {
  type: 'watching'
  platform: Platform
  /** Platform channel identifier, e.g. the Twitch login `lirik`. */
  channel: string
}

/** On the platform, but not on a channel - the Twitch home page, directory... */
export interface BrowsingActivity {
  type: 'browsing'
  platform: Platform
}

/**
 * No activity at all. Distinct from browsing: idle means Watchside has nothing
 * to report, which is what "offline" is built from.
 */
export interface IdleActivity {
  type: 'idle'
}

export type Activity = WatchingActivity | BrowsingActivity | IdleActivity

export const IDLE: IdleActivity = { type: 'idle' }

export type PresenceStatus = 'online' | 'offline'

export interface Presence {
  userId: string
  status: PresenceStatus
  /** Always `idle` when the user is offline. */
  activity: Activity
  /** When this presence last changed, epoch ms. Used for "watching for 12m". */
  since: number
  /**
   * Last heartbeat, epoch ms. A client that crashes or loses its network stops
   * updating this, which is how someone stops appearing online without ever
   * having said goodbye. Undefined means "freshness does not apply here".
   */
  lastSeenAt?: number
}

export interface Group {
  id: string
  name: string
  emoji: string
  /**
   * Group membership is intentionally independent of friendship: a group can
   * contain users the local user is not friends with.
   */
  memberIds: string[]
}
