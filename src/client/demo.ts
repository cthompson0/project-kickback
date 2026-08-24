import { INITIAL_STATE } from './types'
import type {
  ChatMessage,
  Friend,
  GroupMember,
  GroupSummary,
  KickbackClient,
  KickbackState,
} from './types'
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

/**
 * One scripted conversation.
 *
 * Demo mode exists so the panel can be worked on without a backend, and chat
 * is the view whose layout most needs looking at - it is the reason the panel
 * became resizable. Sending is still refused: this is a conversation to look
 * at, not one to take part in.
 */
const DEMO_GROUP_ID = 'demo-group'

const DEMO_GROUP: GroupSummary = {
  groupId: DEMO_GROUP_ID,
  name: 'The Boys',
  icon: '🎮',
  ownerId: 'demo-user',
  isOwner: true,
  memberCount: 4,
}

const chat = (id: number, userId: string, displayName: string, body: string): ChatMessage => ({
  id: `demo-msg-${id}`,
  groupId: DEMO_GROUP_ID,
  userId,
  displayName,
  avatarUrl: null,
  body,
  // Fixed timestamps: a demo that drifts with the clock is harder to compare
  // against a screenshot from yesterday.
  createdAt: `2024-01-01T20:${String(id).padStart(2, '0')}:00.000Z`,
})

const DEMO_MESSAGES: ChatMessage[] = [
  chat(1, 'u_jake', 'Jake', 'anyone else seeing this'),
  chat(2, 'u_matt', 'Matt', 'no way he lands that'),
  chat(3, 'u_jake', 'Jake', ':pog:'),
  chat(4, 'u_sarah', 'Sarah', ':pog:'),
  chat(5, 'u_matt', 'Matt', ':pog:'),
  chat(6, 'u_nina', 'Nina', ':pog:'),
  chat(7, 'u_dave', 'Dave', 'ok that was actually incredible'),
  chat(8, 'u_sarah', 'Sarah', 'clipped it :fire:'),
  chat(9, 'u_jake', 'Jake', 'send it in the group'),
  chat(10, 'u_nina', 'Nina', ':lol: :lol: :lol:'),
  chat(11, 'u_matt', 'Matt', 'what channel is he on after this'),
  chat(12, 'u_dave', 'Dave', 'said he was raiding someone'),
  // Ends mid-chant, so the anchored active-combo indicator has something to
  // show. Alternating users, because one person cannot build a combo alone.
  // Deliberately awkward shapes, so chat wrapping can be looked at without
  // waiting for a real conversation to produce them.
  chat(13, 'u_nina', 'Nina', 'also sometimes chats have a random line break from my username?'),
  chat(14, 'u_matt', 'Matt', 'making notes. should be able to use the streamers avatar/icon'),
  chat(15, 'u_dave', 'Dave', 'https://www.twitch.tv/videos/2147483647?filter=archives&sort=time'),
  chat(16, 'u_sarah', 'Sarah', 'Wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww'),
  chat(17, 'u_jake', 'Jake', ':fire:'),
  chat(18, 'u_sarah', 'Sarah', ':fire:'),
  chat(19, 'u_jake', 'Jake', ':fire:'),
]

const offlinePresence = (userId: string): Presence => ({
  userId,
  status: 'offline',
  activity: IDLE,
  since: 0,
})

export function createDemoClient(): KickbackClient {
  const listeners = new Set<(state: KickbackState) => void>()

  /**
   * Group members carrying the same live presence as the friends list, so the
   * clustered "where is everyone" view has something real to arrange - people
   * on different channels, people together on one, people merely around, and
   * people offline.
   */
  const demoMembers = (presences: Presence[]): GroupMember[] => {
    const byId = new Map(presences.map((presence) => [presence.userId, presence]))
    return ['u_jake', 'u_matt', 'u_sarah', 'u_nina', 'u_dave'].flatMap((id) => {
      const user = getUser(id)
      if (!user) return []
      return [
        {
          user,
          role: (id === 'u_jake' ? 'owner' : 'member') as 'owner' | 'member',
          presence: byId.get(id) ?? offlinePresence(id),
        },
      ]
    })
  }

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
    groups: [DEMO_GROUP],
    groupMembers: { [DEMO_GROUP_ID]: demoMembers(mockPresenceService.getPresences()) },
    groupMessages: { [DEMO_GROUP_ID]: DEMO_MESSAGES },
    demo: true,
  }

  const setState = (patch: Partial<KickbackState>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }

  mockPresenceService.subscribe((presences) =>
    setState({
      friends: toFriends(presences),
      groupMembers: { [DEMO_GROUP_ID]: demoMembers(presences) },
    }),
  )

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
    // Demo mode has no worker, so it keeps the learned channel casing itself.
    // Same resolution path as production, just a shorter one.
    reportActivity: (channel, _visible, channelName) => {
      if (!channel || !channelName) return
      const login = channel.toLowerCase()
      if (channelName.toLowerCase() !== login) return
      if (state.channelNames[login] === channelName) return
      setState({ channelNames: { ...state.channelNames, [login]: channelName } })
    },
    markSeen: () => {},
    markKindSeen: () => {},
    setPreferences: () => Promise.resolve(),
    createGroup: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    renameGroup: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    setGroupIcon: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
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
