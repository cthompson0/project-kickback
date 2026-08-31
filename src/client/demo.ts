import { INITIAL_STATE } from './types'
import type {
  ChatMessage,
  Friend,
  GroupMember,
  GroupSummary,
  KickbackClient,
  KickbackState,
} from './types'
import { CHANNELS, mockPresenceService } from '../mock/presenceService'
import { FRIEND_IDS } from '../mock/social'
import { getUser } from '../mock/users'
import { IDLE } from '../core/types'
import type { Presence } from '../core/types'
import type { RoomMember } from '../core/streamRoom'
import type { RoomMessage } from '../core/roomMessages'
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

/*
 * People watching the same stream, talking about the stream.
 *
 * It used to double as a wrapping fixture - a 56-character run of Ws, a raw
 * VOD URL, and two notes to myself about avatars and line breaks. Those earned
 * their place while chat layout was being built and they are the wrong thing
 * for a demo now: anybody looking at this is trying to understand what Watchside
 * is for, and reading somebody's bug notes does not help them.
 *
 * Chat wrapping still has a gate of its own - scripts/verify-chat-wrapping.mjs
 * carries its own awkward strings and does not read this file - so nothing was
 * lost by making the conversation sound like a conversation.
 */
const DEMO_MESSAGES: ChatMessage[] = [
  chat(1, 'u_jake', 'Jake', 'ok he is actually going for it'),
  chat(2, 'u_matt', 'Matt', 'no way he lands this'),
  chat(3, 'u_sarah', 'Sarah', 'he has done it once before'),
  chat(4, 'u_jake', 'Jake', ':pog:'),
  chat(5, 'u_sarah', 'Sarah', ':pog:'),
  chat(6, 'u_matt', 'Matt', ':pog:'),
  chat(7, 'u_nina', 'Nina', ':pog:'),
  chat(8, 'u_dave', 'Dave', 'that was genuinely incredible'),
  chat(9, 'u_sarah', 'Sarah', 'clipping it now'),
  chat(10, 'u_nina', 'Nina', 'chat has completely lost it :lol:'),
  chat(11, 'u_matt', 'Matt', 'what is he playing after this'),
  chat(12, 'u_dave', 'Dave', 'said he was raiding someone at the top of the hour'),
  chat(13, 'u_jake', 'Jake', 'im staying for the raid'),
  chat(14, 'u_nina', 'Nina', 'same, ping me if it moves'),
  // Ends mid-chant, so the anchored combo indicator has something to show.
  // Alternating people, because one person cannot build a combo alone.
  chat(15, 'u_sarah', 'Sarah', ':fire:'),
  chat(16, 'u_jake', 'Jake', ':fire:'),
  chat(17, 'u_matt', 'Matt', ':fire:'),
]

/**
 * The Stream Room on the gathering channel.
 *
 * WHY THIS EXISTS
 *
 * The third store screenshot is meant to say "watching together", and without
 * this the panel had no room to show: `sessionAvailable` needs peers or members
 * on the channel the viewer is on, and demo mode supplies state directly rather
 * than deriving it from presence the way the worker does. So the screenshot fell
 * back to group chat, which is a different feature telling a different story.
 *
 * The people are the three the seed already puts on the gathering, so the room
 * agrees with the Gravity card in screenshot 2 - the same friends, one step
 * later. Kenji is a hop-2 member: he is NOT in FRIEND_IDS, so he is somebody
 * reached through Jake, which is real product behaviour (a room is a connected
 * component, not a friend list) and worth one row of the picture.
 *
 * Fixed timestamps, like DEMO_MESSAGES, so a screenshot taken today can be
 * compared against one taken last week.
 */
const ROOM_CHANNEL = CHANNELS.gathering

/** Twelve minutes ago, so the whole conversation sits inside the 30m window. */
const ROOM_EPOCH = Date.now() - 12 * 60_000

const ROOM_MEMBERS: RoomMember[] = [
  { userId: 'u_jake', hops: 1, viaUserId: null },
  { userId: 'u_matt', hops: 1, viaUserId: null },
  { userId: 'u_chris', hops: 1, viaUserId: null },
  { userId: 'u_kenji', hops: 2, viaUserId: 'u_jake' },
]

/** The peers the client can see directly - the three friends, not Kenji. */
const ROOM_PEERS = ['u_jake', 'u_matt', 'u_chris']

const roomChat = (index: number, senderId: string, body: string): RoomMessage => ({
  id: `demo-room-${index}`,
  senderId,
  channel: ROOM_CHANNEL,
  body,
  at: ROOM_EPOCH + index * 60_000,
  // Zero is what history reads back as; these are not messages that just
  // arrived, and the activity window would otherwise treat them as live.
  receivedAt: 0,
})

const ROOM_MESSAGES: RoomMessage[] = [
  roomChat(1, 'u_chris', 'this is the run he was talking about'),
  roomChat(2, 'u_jake', 'no chance he clears it first try'),
  roomChat(3, 'u_matt', 'he has been practising all week'),
  roomChat(4, 'u_kenji', 'first time seeing this, what is the record'),
  roomChat(5, 'u_chris', 'four minutes and change'),
  roomChat(6, 'u_jake', ':pog:'),
  roomChat(7, 'u_matt', ':pog:'),
  roomChat(8, 'u_chris', ':pog:'),
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
    // The room on the gathering channel. Keyed by channel, so it only appears
    // when the viewer is actually there - which is what screenshot 3 stages.
    roomMembers: { [ROOM_CHANNEL]: ROOM_MEMBERS },
    roomPeers: { [ROOM_CHANNEL]: ROOM_PEERS },
    roomMessages: ROOM_MESSAGES,
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
    /*
     * Analytics does not exist in demo mode.
     *
     * Not "is configured off" - there is no recorder, no queue and no session
     * here at all, and these three are the only way to reach one. The demo
     * build is also compiled without the worker's analytics code entirely,
     * because it never runs the worker; tests/extension/bundle.test.ts checks
     * that nothing analytics-shaped reaches the demo bundle.
     */
    track: () => {},
    // The demo build has no backend and no friends to react with.
    sendReaction: () => {},
    sendRoomMessage: () => {},
    selectSession: () => {},
    setUserMuted: () => {},
    recordJoin: () => {},
    reportExposure: () => {},

    signIn: () => setState({ status: 'signed_in', identity: DEMO_IDENTITY }),
    signOut: () => setState({ status: 'signed_out', identity: null, friends: [] }),
    // The demo build has no account and must never look like it deleted one.
    deleteAccount: () =>
      Promise.resolve({ ok: false, error: 'The demo build has no account to delete.' }),
    retry: () => {},

    // Friend management is a real-backend feature. Demo mode exists to work on
    // the presence UI offline, so these refuse rather than pretend.
    searchUsers: () => Promise.resolve([]),
    sendFriendRequest: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    respondToFriendRequest: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    acceptFriendRequestFrom: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    cancelFriendRequest: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    removeFriend: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    blockUser: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    unblockUser: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    submitFeedback: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
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
    cancelGroupInvite: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    respondToGroupInvite: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    leaveGroup: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    removeGroupMember: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    sendGroupMessage: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),
    markGroupRead: () => {},
    setGroupMuted: () => Promise.resolve(),
    searchEmotes: () => Promise.resolve([]),
    setPresenceVisibility: () => Promise.reject(new Error(DEMO_UNAVAILABLE)),

  // The growth loop is a live-backend feature; the demo and the lab render the
  // panel without one, so these resolve empty rather than pretending.
  reportInvite: () => {},
  suggestFriends: async () => [],
  inviteCode: async () => '0123456789ABCDEFGHJKMN',
  claimInvite: async () => 'unknown',
  referralSummary: async () => ({ successful: 0, pending: 0 }),
  badges: async () => [],
  setDisplayedBadge: async () => {},
  }
}
