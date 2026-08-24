import { effectiveStatus, isWatching } from './presence'
import type { Activity, Presence } from './types'

/**
 * What one person is doing, as far as the viewer is concerned.
 *
 * WHY THIS EXISTS
 *
 * Every surface used to answer this for itself. The group cluster decided
 * somebody was "here with you"; the user card, looking at the same presence
 * and the same viewer, decided they were "watching stankRat" and offered a
 * JOIN that reloaded the stream you were already on. Two implementations, one
 * question, two answers - which is the same shape of bug as the presence
 * index solved a layer down.
 *
 * So the *interpretation* lives here, once, exactly as the *value* lives in
 * the presence index once. Surfaces choose wording and layout; none of them
 * decides what is true.
 *
 * WHAT THIS DOES NOT DECIDE
 *
 * Who may see whom. Presence is redacted at write time and RLS decides which
 * rows come back at all, so by the time it reaches here the question has been
 * answered. Nothing here can widen it.
 *
 * A NOTE ON HIDDEN ACTIVITY
 *
 * Someone who hides their activity arrives as online with no channel - which
 * is exactly what someone merely browsing Twitch looks like. That is
 * deliberate: a client that could tell them apart would be leaking the fact
 * that somebody chose to hide. Both read as `around`, and Kickback says the
 * same thing about both.
 */

export type PresenceKind =
  /** On the same channel as the viewer, right now. */
  | 'watching_with_you'
  /** Watching something else, somewhere the viewer could go. */
  | 'watching_elsewhere'
  /** Online, but not on a channel - browsing, or hiding their activity. */
  | 'around'
  /** Offline, invisible, stale, or never shared anything. */
  | 'offline'

export interface PersonPresence {
  kind: PresenceKind
  /** The channel they are on, for both watching kinds. Null otherwise. */
  channel: string | null
  /**
   * Whether offering JOIN makes sense.
   *
   * False when there is nowhere to go, and false when the destination is where
   * the viewer already is - a JOIN that reloads your current stream is not an
   * action, it is a wasted click.
   */
  canJoin: boolean
}

/** The channel the viewer is on, lowercased, or null. */
export function viewerChannel(activity: Activity | null | undefined): string | null {
  if (!activity || !isWatching(activity)) return null
  const channel = activity.channel?.trim().toLowerCase()
  return channel ? channel : null
}

/**
 * Interprets one person's presence for one viewer.
 *
 * `viewer` is the viewer's own activity. Pass null when there is no viewer
 * context - a notification, say - and nobody will be reported as watching
 * with them.
 */
export function describePresence(
  presence: Presence | null | undefined,
  viewer: Activity | null | undefined,
  now: number = Date.now(),
): PersonPresence {
  if (!presence || effectiveStatus(presence, now) !== 'online') {
    return { kind: 'offline', channel: null, canJoin: false }
  }

  if (!isWatching(presence.activity)) {
    return { kind: 'around', channel: null, canJoin: false }
  }

  const channel = presence.activity.channel?.trim().toLowerCase()
  if (!channel) return { kind: 'around', channel: null, canJoin: false }

  const here = viewerChannel(viewer)
  if (here !== null && here === channel) {
    return { kind: 'watching_with_you', channel, canJoin: false }
  }

  return { kind: 'watching_elsewhere', channel, canJoin: true }
}

/**
 * True when JOIN would take the viewer somewhere they already are.
 *
 * Checked at the action layer as well as when deciding whether to draw the
 * button: a panel that has not re-rendered yet must not be able to navigate
 * the page to the stream it is already showing.
 */
export function isSameChannel(
  destination: string | null | undefined,
  viewer: Activity | null | undefined,
): boolean {
  const target = destination?.trim().toLowerCase()
  if (!target) return false
  return viewerChannel(viewer) === target
}
