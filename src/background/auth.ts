import { INITIAL_STATE } from '../client/types'
import type { KickbackIdentity, KickbackState } from '../client/types'

/**
 * The authentication state machine.
 *
 * Deliberately free of Supabase and Chrome APIs: it talks to an AuthBackend and
 * a launchWebAuthFlow function, both injected. That keeps every branch here -
 * cancellation, malformed callbacks, expiry, backend outages - testable without
 * a browser or a network, and keeps the rule that matters easy to see:
 *
 *   a failure NEVER degrades into demo data. It degrades into an honest error.
 */

export interface SessionLike {
  /** Unix seconds, or null if the backend did not say. */
  expiresAt: number | null
}

export interface BackendResult<T> {
  value: T | null
  error?: string
}

export interface AuthBackend {
  getSession(): Promise<BackendResult<SessionLike>>
  refreshSession(): Promise<BackendResult<SessionLike>>
  /** Returns the provider URL the user must visit. */
  startOAuth(redirectTo: string): Promise<BackendResult<string>>
  exchangeCode(code: string): Promise<BackendResult<SessionLike>>
  signOut(): Promise<void>
  /** Reads the Watchside profile for the current session. */
  fetchIdentity(): Promise<BackendResult<KickbackIdentity>>
}

export interface AuthDeps {
  backend: AuthBackend
  launchWebAuthFlow(url: string): Promise<string>
  redirectUrl: string
  now?: () => number
  onError?: (context: string, error: unknown) => void
}

/** Refresh this many seconds before the token actually expires. */
const EXPIRY_SKEW_SECONDS = 120

export function isSessionExpiring(
  session: SessionLike | null,
  nowMs: number,
  skewSeconds = EXPIRY_SKEW_SECONDS,
): boolean {
  if (!session) return false
  if (session.expiresAt === null) return false
  return session.expiresAt * 1000 - nowMs <= skewSeconds * 1000
}

/**
 * Pulls the authorization code out of the URL the OAuth flow landed on.
 * Supabase uses PKCE, so the code arrives as a query parameter; a provider
 * error arrives as `error` / `error_description`.
 */
export function readCallback(redirectedTo: string): { code?: string; error?: string } {
  let url: URL
  try {
    url = new URL(redirectedTo)
  } catch {
    return { error: 'Sign-in returned an address Watchside could not read.' }
  }

  const params = url.searchParams
  // Some providers put things in the fragment; check both rather than assume.
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''))

  const providerError = params.get('error_description') ?? params.get('error') ?? hash.get('error')
  if (providerError) return { error: providerError }

  const code = params.get('code') ?? hash.get('code')
  if (!code) return { error: 'Sign-in did not complete.' }

  return { code }
}

/** Chrome rejects launchWebAuthFlow with this when the user closes the window. */
function isUserCancellation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /did not approve|user (cancel|close)|canceled|cancelled/i.test(message)
}

export interface AuthService {
  getState(): KickbackState
  subscribe(listener: (state: KickbackState) => void): () => void
  initialize(): Promise<void>
  signIn(): Promise<void>
  signOut(): Promise<void>
  retry(): Promise<void>
  /** Refreshes if the token is close to expiry. Returns false if signed out. */
  ensureFreshSession(): Promise<boolean>
  /**
   * Re-read the Watchside profile without touching the session. Used when
   * something the profile carries has changed server-side - the presence
   * visibility setting, for instance.
   */
  reloadIdentity(): Promise<void>
}

export function createAuthService(deps: AuthDeps): AuthService {
  const now = deps.now ?? (() => Date.now())
  const listeners = new Set<(state: KickbackState) => void>()
  let state: KickbackState = { ...INITIAL_STATE }

  const setState = (patch: Partial<KickbackState>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }

  const fail = (context: string, message: string, error?: unknown) => {
    deps.onError?.(context, error)
    // Signed-out-ness is not knowable when the backend is unreachable, so we
    // keep whatever identity we had and surface the problem instead of
    // pretending the user is logged out - or, worse, showing fake friends.
    setState({ status: 'error', error: message, signingIn: false, friends: [] })
  }

  async function loadIdentity(): Promise<void> {
    const result = await deps.backend.fetchIdentity()
    if (result.error) {
      fail('fetchIdentity', "Watchside can't reach its server right now.", result.error)
      return
    }
    if (!result.value) {
      fail(
        'fetchIdentity',
        'Your Watchside profile is missing. Try signing out and back in.',
      )
      return
    }
    setState({
      status: 'signed_in',
      identity: result.value,
      error: null,
      signingIn: false,
      friends: [],
    })
  }

  async function ensureFreshSession(): Promise<boolean> {
    const current = await deps.backend.getSession()
    if (current.error) {
      fail('getSession', "Watchside can't reach its server right now.", current.error)
      return false
    }
    if (!current.value) return false

    if (!isSessionExpiring(current.value, now())) return true

    const refreshed = await deps.backend.refreshSession()
    if (refreshed.error || !refreshed.value) {
      // A refresh token that no longer works means the session is genuinely
      // over: sign out cleanly rather than leaving a half-authenticated UI.
      deps.onError?.('refreshSession', refreshed.error)
      await deps.backend.signOut().catch(() => {})
      setState({ status: 'signed_out', identity: null, error: null, friends: [], signingIn: false })
      return false
    }
    return true
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener)
      listener(state)
      return () => {
        listeners.delete(listener)
      }
    },

    ensureFreshSession,

    async reloadIdentity() {
      if (state.status !== 'signed_in') return
      await loadIdentity()
    },

    async initialize() {
      setState({ status: 'loading', error: null })
      const hasSession = await ensureFreshSession()
      if (state.status === 'error') return
      if (!hasSession) {
        setState({ status: 'signed_out', identity: null, friends: [], signingIn: false })
        return
      }
      await loadIdentity()
    },

    async signIn() {
      if (state.signingIn) return
      setState({ signingIn: true, error: null })

      const started = await deps.backend.startOAuth(deps.redirectUrl)
      if (started.error || !started.value) {
        fail('startOAuth', 'Watchside could not start the Twitch sign-in.', started.error)
        return
      }

      let redirectedTo: string
      try {
        redirectedTo = await deps.launchWebAuthFlow(started.value)
      } catch (error) {
        if (isUserCancellation(error)) {
          // Backing out is a normal thing to do, not a failure to report.
          setState({ status: 'signed_out', signingIn: false, error: null })
          return
        }
        fail('launchWebAuthFlow', 'Twitch sign-in did not complete.', error)
        return
      }

      const callback = readCallback(redirectedTo)
      if (callback.error || !callback.code) {
        setState({ status: 'signed_out', signingIn: false, error: callback.error ?? null })
        return
      }

      const exchanged = await deps.backend.exchangeCode(callback.code)
      if (exchanged.error || !exchanged.value) {
        fail('exchangeCode', 'Watchside could not finish signing you in.', exchanged.error)
        return
      }

      await loadIdentity()
    },

    async signOut() {
      try {
        await deps.backend.signOut()
      } catch (error) {
        // Losing the network must still clear the local session.
        deps.onError?.('signOut', error)
      }
      setState({
        status: 'signed_out',
        identity: null,
        error: null,
        friends: [],
        signingIn: false,
      })
    },

    async retry() {
      await this.initialize()
    },
  }
}
