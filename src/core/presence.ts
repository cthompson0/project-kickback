import type { Activity, Presence, User, WatchingActivity } from './types'

export function isWatching(activity: Activity): activity is WatchingActivity {
  return activity.type === 'watching'
}

/** True when two activities point at the same place on the same platform. */
export function isSameActivity(a: Activity, b: Activity): boolean {
  return (
    isWatching(a) &&
    isWatching(b) &&
    a.platform === b.platform &&
    a.channel.toLowerCase() === b.channel.toLowerCase()
  )
}

/** "Here" = this person is watching exactly what the local user is watching. */
export function isHere(presence: Presence, localActivity: Activity): boolean {
  return presence.status === 'online' && isSameActivity(presence.activity, localActivity)
}

export function countHere(presences: Presence[], localActivity: Activity): number {
  return presences.filter((p) => isHere(p, localActivity)).length
}

/** A set of people who happen to be in the same place. */
export interface Gathering {
  platform: 'twitch'
  channel: string
  userIds: string[]
}

/**
 * Group presences by what they are watching, biggest crowd first.
 * `excludeActivity` drops the local user's own channel so callers can surface
 * "here" separately from "somewhere else".
 */
export function findGatherings(presences: Presence[], excludeActivity?: Activity): Gathering[] {
  const byChannel = new Map<string, Gathering>()

  for (const presence of presences) {
    if (presence.status !== 'online' || !isWatching(presence.activity)) continue
    if (excludeActivity && isSameActivity(presence.activity, excludeActivity)) continue

    const { platform, channel } = presence.activity
    const key = `${platform}:${channel.toLowerCase()}`
    const existing = byChannel.get(key)
    if (existing) {
      existing.userIds.push(presence.userId)
    } else {
      byChannel.set(key, { platform, channel, userIds: [presence.userId] })
    }
  }

  return [...byChannel.values()].sort((a, b) => b.userIds.length - a.userIds.length)
}

/** Sort order: here, then watching elsewhere, then online, then offline. */
export function presenceRank(presence: Presence, localActivity: Activity): number {
  if (presence.status === 'offline') return 3
  if (isHere(presence, localActivity)) return 0
  return isWatching(presence.activity) ? 1 : 2
}

export function sortForDisplay(
  entries: Array<{ user: User; presence: Presence }>,
  localActivity: Activity,
): Array<{ user: User; presence: Presence }> {
  return [...entries].sort((a, b) => {
    const rank = presenceRank(a.presence, localActivity) - presenceRank(b.presence, localActivity)
    if (rank !== 0) return rank
    return a.user.displayName.localeCompare(b.user.displayName)
  })
}

/** Compact "how long have they been there" label. */
export function formatSince(since: number, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - since) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
