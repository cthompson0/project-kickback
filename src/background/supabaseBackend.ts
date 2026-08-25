import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuthBackend, BackendResult, SessionLike } from './auth'
import type { FriendsBackend } from './friends'
import type { PresenceBackend } from './presence'
import type { GroupsBackend } from './groups'
import type { AnalyticsBackend } from './analytics'
import type { MetadataFetcher } from './metadata'
import type { ReactionBackend } from './togetherReactions'
import type { RoomBackend } from './streamRoom'
import type { RoomMessageBackend } from './roomMessages'
import { MAX_MESSAGES } from '../core/roomMessages'
import type { Reaction } from '../core/together'
import type { AnalyticsEvent } from '../core/analytics'
import { IDLE } from '../core/types'
import type { Presence } from '../core/types'
import type {
  ChatMessage,
  Friend,
  FriendRequest,
  GroupInvite,
  GroupMember,
  GroupSummary,
  KickbackIdentity,
  Relationship,
  SearchResult,
  SendRequestOutcome,
} from '../client/types'
import type { KeyValueStorage } from './storage'

/**
 * The only file that knows Kickback's backend is Supabase. Everything above it
 * sees the AuthBackend interface, which is what keeps the UI and the auth state
 * machine free of vendor detail.
 */

export function createSupabaseClient(
  url: string,
  publishableKey: string,
  storage: KeyValueStorage,
): SupabaseClient {
  return createClient(url, publishableKey, {
    auth: {
      // PKCE: the extension holds no client secret, so the code exchange is
      // bound to a verifier this client generated.
      flowType: 'pkce',
      storage,
      persistSession: true,
      autoRefreshToken: false, // driven by chrome.alarms instead; see index.ts
      detectSessionInUrl: false, // there is no URL bar in a service worker
    },
    realtime: {
      // Chrome resets a service worker's 30s idle timer on WebSocket traffic,
      // so the heartbeat must land comfortably inside that window or the
      // worker is torn down between beats and the subscription dies with it.
      heartbeatIntervalMs: 20_000,
    },
  })
}

/** Supabase errors can carry request detail; keep only a short, tokenless string. */
function describe(error: unknown): string {
  if (!error) return 'unknown error'
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 200)
}

function toSession(session: { expires_at?: number | null } | null): SessionLike | null {
  if (!session) return null
  return { expiresAt: session.expires_at ?? null }
}

interface MeRow {
  user_id: string
  display_name: string
  avatar_url: string | null
  twitch_login: string | null
  friend_code: string
  presence_visibility: string
}

function toIdentity(row: MeRow): KickbackIdentity {
  const visibility = row.presence_visibility
  return {
    userId: row.user_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    twitchLogin: row.twitch_login,
    friendCode: row.friend_code,
    presenceVisibility:
      visibility === 'hide_activity' || visibility === 'invisible' ? visibility : 'visible',
  }
}

export function createSupabaseBackend(supabase: SupabaseClient): AuthBackend {
  return {
    async getSession(): Promise<BackendResult<SessionLike>> {
      try {
        const { data, error } = await supabase.auth.getSession()
        if (error) return { value: null, error: describe(error) }
        return { value: toSession(data.session) }
      } catch (error) {
        return { value: null, error: describe(error) }
      }
    },

    async refreshSession(): Promise<BackendResult<SessionLike>> {
      try {
        const { data, error } = await supabase.auth.refreshSession()
        if (error) return { value: null, error: describe(error) }
        return { value: toSession(data.session) }
      } catch (error) {
        return { value: null, error: describe(error) }
      }
    },

    async startOAuth(redirectTo: string): Promise<BackendResult<string>> {
      try {
        const { data, error } = await supabase.auth.signInWithOAuth({
          provider: 'twitch',
          options: {
            redirectTo,
            // A service worker cannot navigate; we hand the URL to
            // chrome.identity.launchWebAuthFlow ourselves.
            skipBrowserRedirect: true,
          },
        })
        if (error) return { value: null, error: describe(error) }
        return { value: data.url ?? null }
      } catch (error) {
        return { value: null, error: describe(error) }
      }
    },

    async exchangeCode(code: string): Promise<BackendResult<SessionLike>> {
      try {
        const { data, error } = await supabase.auth.exchangeCodeForSession(code)
        if (error) return { value: null, error: describe(error) }
        return { value: toSession(data.session) }
      } catch (error) {
        return { value: null, error: describe(error) }
      }
    },

    async signOut(): Promise<void> {
      // 'global' also revokes the refresh token server-side; fall back to a
      // local wipe so that being offline can never trap someone signed in.
      const { error } = await supabase.auth.signOut({ scope: 'global' })
      if (error) await supabase.auth.signOut({ scope: 'local' })
    },

    async fetchIdentity(): Promise<BackendResult<KickbackIdentity>> {
      try {
        const { data, error } = await supabase.rpc('me')
        if (error) return { value: null, error: describe(error) }
        const rows = (data ?? []) as MeRow[]
        if (rows.length === 0) return { value: null }
        return { value: toIdentity(rows[0]) }
      } catch (error) {
        return { value: null, error: describe(error) }
      }
    },
  }
}

// ------------------------------------------------------------------ friends
//
// Every call below is an existing Checkpoint 2 RPC. None of them take an actor
// id: the database derives it from auth.uid(), so a client cannot act as anyone
// else. Nothing here touches a table directly.

interface FriendRow {
  user_id: string
  display_name: string
  avatar_url: string | null
  twitch_login: string | null
  status: string | null
  platform: string | null
  channel: string | null
  last_seen_at: string | null
  updated_at?: string | null
}

interface RequestRow {
  request_id: string
  direction: string
  user_id: string
  display_name: string
  avatar_url: string | null
  twitch_login: string | null
  created_at: string
}

interface SearchRow {
  user_id: string
  display_name: string
  avatar_url: string | null
  twitch_login: string | null
  relationship: string
  matched_by: string
}

const RELATIONSHIPS: Relationship[] = [
  'self',
  'friend',
  'request_sent',
  'request_received',
  'none',
]

/**
 * Maps a presence row into the domain model.
 *
 * The database has already applied the owner's privacy setting, so a hidden
 * channel simply is not here. Nothing is re-derived client-side.
 */
export function toPresence(row: {
  user_id: string
  status: string | null
  platform: string | null
  channel: string | null
  updated_at?: string | null
  last_seen_at?: string | null
}): Presence {
  const online = row.status === 'online'
  const since = row.updated_at ? Date.parse(row.updated_at) : Date.now()
  const lastSeenAt = row.last_seen_at ? Date.parse(row.last_seen_at) : undefined

  const activity: Presence['activity'] = !online
    ? IDLE
    : row.channel && row.platform === 'twitch'
      ? { type: 'watching', platform: 'twitch', channel: row.channel }
      : { type: 'browsing', platform: 'twitch' }

  return {
    userId: row.user_id,
    status: online ? 'online' : 'offline',
    activity,
    since: Number.isNaN(since) ? Date.now() : since,
    lastSeenAt: lastSeenAt !== undefined && !Number.isNaN(lastSeenAt) ? lastSeenAt : undefined,
  }
}

function toFriend(row: FriendRow): Friend {
  return {
    user: {
      id: row.user_id,
      username: row.twitch_login ?? row.display_name,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
    },
    // A friend who has never reported presence still has a row saying
    // 'offline', so there is always something real to map - never a guess.
    presence: toPresence({
      user_id: row.user_id,
      status: row.status,
      platform: row.platform,
      channel: row.channel,
      updated_at: row.updated_at,
      last_seen_at: row.last_seen_at,
    }),
  }
}

function toRequest(row: RequestRow): FriendRequest {
  return {
    requestId: row.request_id,
    direction: row.direction === 'incoming' ? 'incoming' : 'outgoing',
    user: {
      id: row.user_id,
      username: row.twitch_login ?? row.display_name,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
    },
    twitchLogin: row.twitch_login,
    createdAt: row.created_at,
  }
}

function toSearchResult(row: SearchRow): SearchResult {
  const relationship = RELATIONSHIPS.find((value) => value === row.relationship) ?? 'none'
  return {
    userId: row.user_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    twitchLogin: row.twitch_login,
    relationship,
    matchedBy: row.matched_by === 'friend_code' ? 'friend_code' : 'twitch_login',
  }
}

export function createSupabaseFriendsBackend(supabase: SupabaseClient): FriendsBackend {
  /** Calls an RPC and maps its rows, turning any throw into a result. */
  async function call<Row, Value>(
    fn: string,
    args: Record<string, unknown>,
    map: (rows: Row[]) => Value,
  ): Promise<BackendResult<Value>> {
    try {
      const { data, error } = await supabase.rpc(fn, args)
      if (error) return { value: null, error: describe(error) }
      const rows = (Array.isArray(data) ? data : data == null ? [] : [data]) as Row[]
      return { value: map(rows) }
    } catch (error) {
      return { value: null, error: describe(error) }
    }
  }

  return {
    listFriends: () => call<FriendRow, Friend[]>('list_friends', {}, (rows) => rows.map(toFriend)),

    listFriendRequests: () =>
      call<RequestRow, FriendRequest[]>('list_friend_requests', {}, (rows) =>
        rows.map(toRequest),
      ),

    searchUsers: (query) =>
      call<SearchRow, SearchResult[]>('search_users', { p_query: query }, (rows) =>
        rows.map(toSearchResult),
      ),

    sendFriendRequest: (userId) =>
      call<string, SendRequestOutcome>(
        'send_friend_request',
        { p_target: userId },
        (rows) => (rows[0] ?? 'requested') as SendRequestOutcome,
      ),

    respondToFriendRequest: (requestId, accept) =>
      call<string, 'accepted' | 'declined'>(
        'respond_to_friend_request',
        { p_request_id: requestId, p_accept: accept },
        (rows) => (rows[0] === 'declined' ? 'declined' : 'accepted'),
      ),

    cancelFriendRequest: (requestId) =>
      call<string, 'cancelled'>(
        'cancel_friend_request',
        { p_request_id: requestId },
        () => 'cancelled',
      ),

    removeFriend: (userId) =>
      call<boolean, boolean>('remove_friend', { p_other: userId }, (rows) => rows[0] === true),
  }
}

// ----------------------------------------------------------------- presence
//
// All four are existing RPCs. As everywhere else, none of them take an actor:
// the database uses auth.uid(), and applies the caller's privacy setting at
// write time so a hidden channel is never stored in the first place.

export function createSupabasePresenceBackend(supabase: SupabaseClient): PresenceBackend {
  async function call(fn: string, args: Record<string, unknown> = {}) {
    try {
      const { error } = await supabase.rpc(fn, args)
      if (error) return { value: null, error: describe(error) }
      return { value: true as const }
    } catch (error) {
      return { value: null, error: describe(error) }
    }
  }

  return {
    reportPresence: (platform, channel) =>
      call('report_presence', { p_platform: platform, p_channel: channel }),
    heartbeat: () => call('heartbeat'),
    reportOffline: () => call('report_offline'),
  }
}

export async function setPresenceVisibility(
  supabase: SupabaseClient,
  mode: string,
): Promise<BackendResult<string>> {
  try {
    const { data, error } = await supabase.rpc('set_presence_visibility', { p_mode: mode })
    if (error) return { value: null, error: describe(error) }
    return { value: typeof data === 'string' ? data : mode }
  } catch (error) {
    return { value: null, error: describe(error) }
  }
}

// ------------------------------------------------------------------- groups

interface GroupRow {
  group_id: string
  name: string
  icon: string | null
  owner_id: string
  is_owner: boolean
  member_count: number
}

interface MemberRow {
  user_id: string
  display_name: string
  avatar_url: string | null
  twitch_login: string | null
  role: string
  status: string | null
  platform: string | null
  channel: string | null
  last_seen_at: string | null
  updated_at: string | null
}

interface InviteRow {
  invite_id: string
  group_id: string
  group_name: string
  from_user: string
  from_name: string
  created_at: string
}

export interface MessageRow {
  message_id: string
  group_id: string
  user_id: string
  display_name: string
  avatar_url: string | null
  body: string
  created_at: string
}

export function toChatMessage(row: MessageRow): ChatMessage {
  return {
    id: row.message_id,
    groupId: row.group_id,
    userId: row.user_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    body: row.body,
    createdAt: row.created_at,
  }
}

export function createSupabaseGroupsBackend(supabase: SupabaseClient): GroupsBackend {
  async function call<Row, Value>(
    fn: string,
    args: Record<string, unknown>,
    map: (rows: Row[]) => Value,
  ): Promise<BackendResult<Value>> {
    try {
      const { data, error } = await supabase.rpc(fn, args)
      if (error) return { value: null, error: describe(error) }
      const rows = (Array.isArray(data) ? data : data == null ? [] : [data]) as Row[]
      return { value: map(rows) }
    } catch (error) {
      return { value: null, error: describe(error) }
    }
  }

  return {
    listGroups: () =>
      call<GroupRow, GroupSummary[]>('list_groups', {}, (rows) =>
        rows.map((row) => ({
          groupId: row.group_id,
          name: row.name,
          icon: row.icon ?? null,
          ownerId: row.owner_id,
          isOwner: row.is_owner,
          memberCount: row.member_count,
        })),
      ),

    listInvites: () =>
      call<InviteRow, GroupInvite[]>('list_group_invites', {}, (rows) =>
        rows.map((row) => ({
          inviteId: row.invite_id,
          groupId: row.group_id,
          groupName: row.group_name,
          fromUserId: row.from_user,
          fromName: row.from_name,
          createdAt: row.created_at,
        })),
      ),

    listMembers: (groupId) =>
      call<MemberRow, GroupMember[]>(
        'list_group_members',
        { p_group: groupId },
        (rows) =>
          rows.map((row) => ({
            user: {
              id: row.user_id,
              username: row.twitch_login ?? row.display_name,
              displayName: row.display_name,
              avatarUrl: row.avatar_url,
            },
            role: row.role === 'owner' ? ('owner' as const) : ('member' as const),
            presence: toPresence({
              user_id: row.user_id,
              status: row.status,
              platform: row.platform,
              channel: row.channel,
              updated_at: row.updated_at,
              last_seen_at: row.last_seen_at,
            }),
          })),
      ),

    cancelGroupInvite: (groupId, userId) =>
      call<string, string>(
        'cancel_group_invite',
        { p_group: groupId, p_target: userId },
        (rows) => rows[0] ?? 'not_pending',
      ),

    listSentInvites: (groupId) =>
      call<{ to_user: string }, string[]>(
        'list_group_sent_invites',
        { p_group: groupId },
        (rows) => rows.map((row) => row.to_user),
      ),

    listMessages: (groupId, limit) =>
      call<MessageRow, ChatMessage[]>(
        'list_group_messages',
        { p_group: groupId, p_limit: limit },
        (rows) => rows.map(toChatMessage),
      ),

    createGroup: (name, icon) =>
      call<string, string>('create_group', { p_name: name, p_icon: icon }, (rows) => rows[0]),
    setGroupIcon: (groupId, icon) =>
      call<string, string>('set_group_icon', { p_group: groupId, p_icon: icon }, () => groupId),
    renameGroup: (groupId, name) =>
      call<string, string>('rename_group', { p_group: groupId, p_name: name }, (rows) => rows[0]),
    deleteGroup: (groupId) =>
      call<boolean, boolean>('delete_group', { p_group: groupId }, () => true),
    inviteToGroup: (groupId, userId) =>
      call<string, string>(
        'invite_to_group',
        { p_group: groupId, p_target: userId },
        (rows) => rows[0] ?? 'invited',
      ),
    respondToInvite: (inviteId, accept) =>
      call<string, string>(
        'respond_to_group_invite',
        { p_invite: inviteId, p_accept: accept },
        (rows) => rows[0] ?? 'accepted',
      ),
    leaveGroup: (groupId) =>
      call<boolean, boolean>('leave_group', { p_group: groupId }, () => true),
    removeMember: (groupId, userId) =>
      call<boolean, boolean>(
        'remove_group_member',
        { p_group: groupId, p_user: userId },
        () => true,
      ),
    sendMessage: (groupId, body) =>
      call<string, string>(
        'send_group_message',
        { p_group: groupId, p_body: body },
        (rows) => rows[0] ?? '',
      ),
  }
}

// ---------------------------------------------------------------- analytics
//
// One RPC, one batch. Like every other write here it takes no actor: the
// database uses auth.uid(), so a modified extension cannot record events
// against somebody else's account.
//
// This one REJECTS on failure rather than returning a BackendResult, because
// the recorder's whole design is retry-with-backoff and it needs to know the
// difference between "stored" and "did not store". Nothing above the recorder
// ever sees that rejection.

/**
 * Send one Automatic Together reaction.
 *
 * The RPC takes a channel and a reaction and nothing else: the sender is
 * `auth.uid()` inside the function, so there is no parameter to put somebody
 * else's id into, and the reaction is checked against a fixed list rather than
 * sanitised.
 */
export function createSupabaseTogetherBackend(supabase: SupabaseClient): ReactionBackend {
  return {
    async send(channel: string, reaction: Reaction): Promise<number> {
      const { data, error } = await supabase.rpc('send_together_reaction', {
        p_channel: channel,
        p_reaction: reaction,
      })
      if (error) throw new Error(describe(error))
      return typeof data === 'number' ? data : 0
    },
  }
}

/**
 * Who is in the viewer's room on a channel.
 *
 * The connected component containing the caller, computed server-side. There
 * is no user parameter: the walk is seeded at `auth.uid()`, so this cannot be
 * asked about anybody else, and it returns nothing at all unless the caller's
 * own presence says they are on that channel.
 */
export function createSupabaseRoomBackend(supabase: SupabaseClient): RoomBackend {
  return {
    async members(channel: string): Promise<unknown> {
      const { data, error } = await supabase.rpc('stream_room_members', { p_channel: channel })
      if (error) throw new Error(describe(error))
      return data
    },
  }
}

/**
 * Ephemeral room messages.
 *
 * Two calls and no third: send, which fans out server-side, and history,
 * which reads this viewer's own inbox. There is deliberately no way to ask
 * what was said on a channel - only what was said TO you - because the row
 * addressed to you IS the authorization decision, made when it was written.
 */
export function createSupabaseRoomMessageBackend(supabase: SupabaseClient): RoomMessageBackend {
  return {
    async send(channel: string, body: string): Promise<number> {
      const { data, error } = await supabase.rpc('send_room_message', {
        p_channel: channel,
        p_body: body,
      })
      if (error) throw new Error(describe(error))
      return typeof data === 'number' ? data : 0
    },

    async history(channel: string): Promise<unknown> {
      /*
       * RLS is recipient_id = auth.uid(), so this cannot return anybody
       * else's inbox however it is called. The channel filter is about
       * showing the right conversation, not about who may see it.
       *
       * Ordered newest-first and capped so a long session cannot return an
       * unbounded page; the client sorts back into reading order.
       */
      const { data, error } = await supabase
        .from('room_messages')
        .select('id, sender_id, channel, body, created_at')
        .eq('channel', channel)
        .order('created_at', { ascending: false })
        .limit(MAX_MESSAGES)
      if (error) throw new Error(describe(error))
      return data
    },
  }
}
/**
 * Kickback's Twitch metadata endpoint.
 *
 * An Edge Function rather than an RPC, because it needs the Twitch client
 * secret and outbound HTTP - neither of which belongs in Postgres. Invoked
 * with the caller's own session, so the function sees a verified user id and
 * there is no actor for a modified client to supply.
 *
 * Returns raw JSON. Validation happens in core/twitchMetadata.ts, against the
 * same parser the cache uses, because the values in it came from a third party
 * and passing through our server does not make them ours.
 */
export function createSupabaseMetadataBackend(supabase: SupabaseClient): MetadataFetcher {
  return {
    async fetch(logins: string[]): Promise<unknown> {
      const { data, error } = await supabase.functions.invoke('twitch-metadata', {
        body: { logins },
      })
      if (error) throw new Error(describe(error))
      return data
    },
  }
}

export function createSupabaseAnalyticsBackend(supabase: SupabaseClient): AnalyticsBackend {
  return {
    async send(events: AnalyticsEvent[]): Promise<number> {
      const { data, error } = await supabase.rpc('analytics_track', { p_events: events })
      if (error) throw new Error(describe(error))
      return typeof data === 'number' ? data : 0
    },
  }
}
