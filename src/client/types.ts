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
  presence: Presence
}

export interface KickbackState {
  status: AuthStatus
  identity: KickbackIdentity | null
  /** Human-readable failure, shown in the panel. Never contains a token. */
  error: string | null
  /** Empty until real friendships land. Never populated with mock people. */
  friends: Friend[]
  /** True while a sign-in flow is open. */
  signingIn: boolean
  /** Demo builds set this so the UI can label itself honestly. */
  demo: boolean
}

export const INITIAL_STATE: KickbackState = {
  status: 'loading',
  identity: null,
  error: null,
  friends: [],
  signingIn: false,
  demo: false,
}

export interface KickbackClient {
  getState(): KickbackState
  /** Returns an unsubscribe function. Fires immediately with current state. */
  subscribe(listener: (state: KickbackState) => void): () => void
  signIn(): void
  signOut(): void
  /** Re-attempt after a backend failure. */
  retry(): void
}
