import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuthBackend, BackendResult, SessionLike } from './auth'
import type { FriendsBackend } from './friends'
import type {
  Friend,
  FriendRequest,
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

function toFriend(row: FriendRow): Friend {
  return {
    user: {
      id: row.user_id,
      username: row.twitch_login ?? row.display_name,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
    },
    // Checkpoint 4 deliberately reports no presence at all rather than
    // guessing "offline", which would be a claim we cannot currently make.
    // Checkpoint 5 fills this in from the presence row.
    presence: null,
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
