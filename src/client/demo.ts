import type { Friend, KickbackClient, KickbackState } from './types'
import { mockPresenceService } from '../mock/presenceService'
import { FRIEND_IDS } from '../mock/social'
import { getUser } from '../mock/users'
import { IDLE } from '../core/types'
import type { Presence } from '../core/types'
import { watchChannel } from '../platforms/twitch/navigation'

/**
 * Development-only client, reachable ONLY from a build made with
 * VITE_KICKBACK_MODE=demo. It is loaded through a dynamic import behind a
 * build-time constant so that a production bundle contains none of this file
 * and none of the mock people it depends on.
 *
 * Production never falls back to this. A backend failure surfaces as an error
 * state, because a prototype that invents friends when the server is down is
 * worse than one that admits it.
 */

const DEMO_IDENTITY = {
  userId: 'demo-user',
  displayName: 'Demo User',
  avatarUrl: null,
  twitchLogin: 'demo_user',
  friendCode: 'KB-DEMO-MODE',
  presenceVisibility: 'visible' as const,
}

const offlinePresence = (userId: string): Presence => ({
  userId,
  status: 'offline',
  activity: IDLE,
  since: 0,
})

export function createDemoClient(): KickbackClient {
  const listeners = new Set<(state: KickbackState) => void>()

  const toFriends = (presences: Presence[]): Friend[] => {
    const byId = new Map(presences.map((presence) => [presence.userId, presence]))
    return FRIEND_IDS.flatMap((id) => {
      const user = getUser(id)
      if (!user) return []
      return [{ user, presence: byId.get(id) ?? offlinePresence(id) }]
    })
  }

  let state: KickbackState = {
    status: 'signed_in',
    identity: DEMO_IDENTITY,
    error: null,
    friends: toFriends(mockPresenceService.getPresences()),
    signingIn: false,
    demo: true,
  }

  const setState = (patch: Partial<KickbackState>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }

  mockPresenceService.subscribe((presences) => setState({ friends: toFriends(presences) }))

  // The mock service needs to know where we are so its scripted follower can
  // walk onto the current channel.
  watchChannel((channel) => {
    mockPresenceService.setLocalActivity(
      channel ? { type: 'watching', platform: 'twitch', channel } : IDLE,
    )
  })

  mockPresenceService.start()

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      listener(state)
      return () => {
        listeners.delete(listener)
      }
    },
    signIn: () => setState({ status: 'signed_in', identity: DEMO_IDENTITY }),
    signOut: () => setState({ status: 'signed_out', identity: null, friends: [] }),
    retry: () => {},
  }
}
