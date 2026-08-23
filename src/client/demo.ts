import { INITIAL_STATE } from './types'
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

const DEMO_UNAVAILABLE = 'Friend management needs the real backend; this is a demo build.'

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
    ...INITIAL_STATE,
    status: 'signed_in',
    identity: DEMO_IDENTITY,
    friends: toFriends(mockPresenceService.getPresences()),
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

    // Friend management is a real-backend feature. Demo mode exists to work on
    // the presence UI offline, so these refuse rather than pretend.
    searchUsers: () => Promise.resolve([]),
    sendFriendRequest: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    respondToFriendRequest: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    acceptFriendRequestFrom: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    cancelFriendRequest: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    removeFriend: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    refreshFriends: () => Promise.resolve(),
    reportActivity: () => {},
    markSeen: () => {},
    markKindSeen: () => {},
    setPreferences: () => Promise.resolve(),
    createGroup: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    renameGroup: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    deleteGroup: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    inviteToGroup: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    respondToGroupInvite: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    leaveGroup: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    removeGroupMember: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    sendGroupMessage: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    markGroupRead: () => {},
    setGroupMuted: () => Promise.resolve(),
    searchEmotes: () => Promise.resolve([]),
    setPresenceVisibility: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
  }
}
