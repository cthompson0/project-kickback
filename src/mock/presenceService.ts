import { IDLE } from '../core/types'
import type { Activity, Presence } from '../core/types'
import { isSameActivity, isWatching } from '../core/presence'

/**
 * Phase 0 stand-in for the future Kickback presence service.
 *
 * It holds presence for the mock users, lets the UI subscribe to changes, and
 * drifts a couple of people around on a timer so the prototype feels alive.
 * There is no network here - swapping this for a real client later should only
 * mean reimplementing `subscribe` / `getPresences` / `setLocalActivity`.
 */

const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000

const watching = (channel: string): Activity => ({
  type: 'watching',
  platform: 'twitch',
  channel,
})

/**
 * Three channels, chosen rather than sampled.
 *
 * The demo used to name whichever streamers were handy, which was fine while
 * this only ever ran on a developer's machine. It is not fine now: these names
 * appear in the store listing screenshots, so they are a product decision and
 * they stay fixed. Nothing here should ever pick a channel at random again.
 */
const CHANNELS = {
  gathering: 'theburntpeanut',
  elsewhere: 'summit1g',
  third: 'gingy',
}

const SEED: Presence[] = [
  // Three friends on one channel, always. A pair reads as a coincidence; three
  // people on the same stream is the gathering Social Gravity exists to
  // surface, and the demo should never fail to be able to show it.
  { userId: 'u_jake', status: 'online', activity: watching(CHANNELS.gathering), since: minutesAgo(47) },
  { userId: 'u_matt', status: 'online', activity: watching(CHANNELS.gathering), since: minutesAgo(12) },
  { userId: 'u_chris', status: 'online', activity: watching(CHANNELS.gathering), since: minutesAgo(31) },
  // And two people somewhere else, so "everyone is in one place" is visibly a
  // thing that happened rather than the only state the demo has.
  { userId: 'u_sarah', status: 'online', activity: watching(CHANNELS.elsewhere), since: minutesAgo(8) },
  { userId: 'u_nina', status: 'online', activity: watching(CHANNELS.third), since: minutesAgo(63) },
  { userId: 'u_kenji', status: 'online', activity: watching(CHANNELS.third), since: minutesAgo(19) },
  { userId: 'u_dave', status: 'offline', activity: IDLE, since: minutesAgo(190) },
]

/**
 * Sarah drifts onto whatever channel the local user opens, a few seconds later.
 * Without this you would only ever see the "here" state on the handful of
 * channels baked into the seed data, and "my friends are already here" is the
 * single most important feeling Phase 0 is trying to test.
 */
const DEMO_FOLLOWER_ID = 'u_sarah'
const FOLLOW_DELAY_MS = 5_000

/** Only these people wander, so the seeded invariants above stay intact. */
const ROAMER_IDS = ['u_nina', 'u_kenji']
/*
 * Roamers move between the same three channels and no others.
 *
 * Wandering onto an arbitrary streamer would put a name nobody chose into a
 * screenshot, so the only channels that exist in this demo are the three above.
 */
const ROAM_CHANNELS = [CHANNELS.gathering, CHANNELS.elsewhere, CHANNELS.third]
const ROAM_MIN_MS = 20_000
const ROAM_MAX_MS = 35_000

type Listener = (presences: Presence[]) => void

const pick = <T,>(items: T[]): T => items[Math.floor(Math.random() * items.length)]

export class MockPresenceService {
  private presences = new Map<string, Presence>()
  private listeners = new Set<Listener>()
  private localActivity: Activity = IDLE
  private roamTimer: number | undefined
  private followTimer: number | undefined

  constructor() {
    for (const presence of SEED) this.presences.set(presence.userId, presence)
  }

  getPresences(): Presence[] {
    return [...this.presences.values()]
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Called by the Twitch integration whenever the local user changes channel. */
  setLocalActivity(activity: Activity): void {
    if (isSameActivity(activity, this.localActivity)) return
    this.localActivity = activity
    this.scheduleFollow()
  }

  start(): void {
    this.scheduleRoam()
  }

  stop(): void {
    window.clearTimeout(this.roamTimer)
    window.clearTimeout(this.followTimer)
    this.roamTimer = undefined
    this.followTimer = undefined
  }

  private emit(): void {
    const snapshot = this.getPresences()
    for (const listener of this.listeners) listener(snapshot)
  }

  private update(userId: string, next: Omit<Presence, 'userId'>): void {
    this.presences.set(userId, { userId, ...next })
    this.emit()
  }

  private scheduleFollow(): void {
    window.clearTimeout(this.followTimer)
    const target = this.localActivity
    if (!isWatching(target)) return

    this.followTimer = window.setTimeout(() => {
      const follower = this.presences.get(DEMO_FOLLOWER_ID)
      if (!follower || follower.status !== 'online') return
      if (isSameActivity(follower.activity, target)) return
      this.update(DEMO_FOLLOWER_ID, { status: 'online', activity: target, since: Date.now() })
    }, FOLLOW_DELAY_MS)
  }

  private scheduleRoam(): void {
    const delay = ROAM_MIN_MS + Math.random() * (ROAM_MAX_MS - ROAM_MIN_MS)
    this.roamTimer = window.setTimeout(() => {
      this.roam()
      this.scheduleRoam()
    }, delay)
  }

  private roam(): void {
    const presence = this.presences.get(pick(ROAMER_IDS))
    if (!presence) return

    const current = presence.activity
    if (isWatching(current)) {
      // Wander to another channel, or step away for a bit.
      const elsewhere = ROAM_CHANNELS.filter((channel) => channel !== current.channel)
      const nextActivity = Math.random() < 0.65 ? watching(pick(elsewhere)) : IDLE
      this.update(presence.userId, { status: 'online', activity: nextActivity, since: Date.now() })
      return
    }

    this.update(presence.userId, {
      status: 'online',
      activity: watching(pick(ROAM_CHANNELS)),
      since: Date.now(),
    })
  }
}

export const mockPresenceService = new MockPresenceService()
