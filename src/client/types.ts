/**
 * The seam between Kickback's UI and whatever is supplying its data.
 *
 * The panel talks only to a KickbackClient. In production that is a thin proxy
 * to the extension's service worker, which owns the Supabase session; in demo
 * mode it is the Phase 0 mock. Neither the UI nor `core/` knows Supabase exists.
 */

import type { Presence, User } from '../core/types'

export type AuthStatus =
  /** Still working out whether there is a session. Show nothing social yet. */
  | 'loading'
  /** No session. Show Continue with Twitch. */
  | 'signed_out'
  | 'signed_in'
  /** Signed in or not, we could not reach the backend. Never show mock data. */
  | 'error'

/**
 * Kickback's own identity. `userId` is the Kickback user id, deliberately not
 * the Twitch user id: the Twitch account is a connected account hanging off it.
 */
export interface KickbackIdentity {
  userId: string
  displayName: string
  avatarUrl: string | null
  twitchLogin: string | null
  friendCode: string
  presenceVisibility: 'visible' | 'hide_activity' | 'invisible'
}

export interface Friend {
  user: User
  /**
   * null means "Kickback has no presence information for this person", which is
   * NOT the same as offline. Real presence arrives in Checkpoint 5; until then
   * every real friend carries null and the UI must stay silent about activity.
   */
  presence: Presence | null
}

/** How the signed-in user stands with someone a search turned up. */
export type Relationship = 'self' | 'friend' | 'request_sent' | 'request_received' | 'none'

export interface SearchResult {
  userId: string
  displayName: string
  avatarUrl: string | null
  twitchLogin: string | null
  relationship: Relationship
  /** Whether they matched on their Twitch login or on an exact friend code. */
  matchedBy: 'twitch_login' | 'friend_code'
}

export interface FriendRequest {
  requestId: string
  direction: 'incoming' | 'outgoing'
  /** The other person - never the signed-in user. */
  user: User
  twitchLogin: string | null
  createdAt: string
}

/** What the backend decided when a request was sent. */
export type SendRequestOutcome =
  | 'requested'
  | 'friends' // reciprocal request auto-accepted
  | 'already_friends'
  | 'already_requested'

export interface KickbackState {
  status: AuthStatus
  identity: KickbackIdentity | null
  /** Human-readable auth failure, shown in the panel. Never contains a token. */
  error: string | null
  /** Real friends only. Never populated with mock people in production. */
  friends: Friend[]
  incomingRequests: FriendRequest[]
  outgoingRequests: FriendRequest[]
  friendsLoading: boolean
  /** Friend-list failure, kept separate so it cannot blank the whole panel. */
  friendsError: string | null
  /** True while a sign-in flow is open. */
  signingIn: boolean
  /** Demo builds set this so the UI can label itself honestly. */
  demo: boolean

  // --- attention -----------------------------------------------------------

  /** Things currently worth noticing, seen or not. */
  attention: AttentionItem[]
  /** Of those, the ones not yet seen. Drives the collapsed launcher badge. */
  unread: AttentionItem[]
  preferences: KickbackPreferences

  // --- groups --------------------------------------------------------------

  groups: GroupSummary[]
  groupInvites: GroupInvite[]
  groupMembers: Record<string, GroupMember[]>
  groupMessages: Record<string, ChatMessage[]>
  groupUnread: Record<string, number>
  mutedGroupIds: string[]
  groupsLoading: boolean
  groupsError: string | null
}

export const INITIAL_STATE: KickbackState = {
  status: 'loading',
  identity: null,
  error: null,
  friends: [],
  incomingRequests: [],
  outgoingRequests: [],
  friendsLoading: false,
  friendsError: null,
  signingIn: false,
  demo: false,
  attention: [],
  unread: [],
  preferences: { gatheringNotifications: true },
  groups: [],
  groupInvites: [],
  groupMembers: {},
  groupMessages: {},
  groupUnread: {},
  mutedGroupIds: [],
  groupsLoading: false,
  groupsError: null,
}

export interface KickbackClient {
  getState(): KickbackState
  /** Returns an unsubscribe function. Fires immediately with current state. */
  subscribe(listener: (state: KickbackState) => void): () => void
  signIn(): void
  signOut(): void
  /** Re-attempt after a backend failure. */
  retry(): void

  // --- friends -------------------------------------------------------------
  // These reject with a human-readable Error on failure; the UI decides how
  // loudly to complain. State-changing calls refresh the broadcast state, so
  // callers do not have to re-fetch the friends list themselves.

  searchUsers(query: string): Promise<SearchResult[]>
  sendFriendRequest(userId: string): Promise<SendRequestOutcome>
  respondToFriendRequest(requestId: string, accept: boolean): Promise<'accepted' | 'declined'>
  /**
   * Accept the pending request from this person. The UI knows who asked; the
   * worker owns the request id, so it resolves it rather than making callers
   * carry it around.
   */
  acceptFriendRequestFrom(userId: string): Promise<'accepted'>
  cancelFriendRequest(requestId: string): Promise<void>
  removeFriend(userId: string): Promise<void>
  refreshFriends(): Promise<void>

  // --- presence ------------------------------------------------------------

  /** Report what this Twitch tab is showing. Fire-and-forget. */
  reportActivity(channel: string | null, visible: boolean): void
  /** Change who can see what. Enforced server-side, not here. */
  setPresenceVisibility(mode: PresenceVisibility): Promise<void>

  // --- attention -----------------------------------------------------------

  /** Mark specific things seen, clearing their unread state. */
  markSeen(keys: string[]): void
  /** Mark everything of a kind seen - "the user looked at the requests". */
  markKindSeen(kind: AttentionKind): void
  setPreferences(patch: Partial<KickbackPreferences>): Promise<void>

  // --- groups --------------------------------------------------------------

  createGroup(name: string): Promise<string>
  renameGroup(groupId: string, name: string): Promise<void>
  deleteGroup(groupId: string): Promise<void>
  inviteToGroup(groupId: string, userId: string): Promise<string>
  respondToGroupInvite(inviteId: string, accept: boolean): Promise<string>
  leaveGroup(groupId: string): Promise<void>
  removeGroupMember(groupId: string, userId: string): Promise<void>
  sendGroupMessage(groupId: string, body: string): Promise<void>
  /** The user is looking at this group; clear its unread. */
  markGroupRead(groupId: string): void
  setGroupMuted(groupId: string, muted: boolean): Promise<void>
}

export type PresenceVisibility = 'visible' | 'hide_activity' | 'invisible'

export type AttentionKind = 'friend_request' | 'gathering' | 'group_invite' | 'group_unread'

// --- groups ----------------------------------------------------------------

export interface GroupSummary {
  groupId: string
  name: string
  ownerId: string
  isOwner: boolean
  memberCount: number
}

export interface GroupMember {
  user: User
  role: 'owner' | 'member'
  /** null when Kickback has no presence for them. */
  presence: Presence | null
}

export interface GroupInvite {
  inviteId: string
  groupId: string
  groupName: string
  fromUserId: string
  fromName: string
  createdAt: string
}

export interface ChatMessage {
  id: string
  groupId: string
  userId: string
  displayName: string
  avatarUrl: string | null
  body: string
  /** ISO timestamp; ordering key alongside id. */
  createdAt: string
}

export interface AttentionItem {
  key: string
  kind: AttentionKind
  count: number
}

export interface KickbackPreferences {
  gatheringNotifications: boolean
}
