import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuthBackend, BackendResult, SessionLike } from './auth'
import type { KickbackIdentity } from '../client/types'
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
