import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthService, isSessionExpiring, readCallback } from '../../src/background/auth'
import type { AuthBackend, BackendResult, SessionLike } from '../../src/background/auth'
import type { KickbackIdentity, KickbackState } from '../../src/client/types'

/**
 * The authentication state machine, exercised without a browser or a network.
 *
 * The rule these tests exist to protect: no failure path may ever end with the
 * panel showing people who are not really there.
 */

const IDENTITY: KickbackIdentity = {
  userId: 'kb-user-1',
  displayName: 'Sk8bo',
  avatarUrl: 'https://cdn.twitch.test/sk8bo.png',
  twitchLogin: 'sk8bo',
  friendCode: 'KB-7QX4-M2P9',
  presenceVisibility: 'visible',
}

const LIVE_SESSION: SessionLike = { expiresAt: Math.floor(Date.now() / 1000) + 3600 }
const STALE_SESSION: SessionLike = { expiresAt: Math.floor(Date.now() / 1000) + 10 }

class FakeBackend implements AuthBackend {
  session: SessionLike | null = null
  identity: KickbackIdentity | null = IDENTITY
  sessionError?: string
  identityError?: string
  refreshResult: BackendResult<SessionLike> = { value: LIVE_SESSION }
  exchangeResult: BackendResult<SessionLike> = { value: LIVE_SESSION }
  oauthResult: BackendResult<string> = { value: 'https://id.twitch.test/authorize?x=1' }
  signOutError: Error | null = null
  deleteError: string | undefined
  readiness: 'ready' | 'needs_follow_permission' | 'needs_reauthorization' | 'temporarily_unavailable' | null = null
  calls: string[] = []

  async getSession(): Promise<BackendResult<SessionLike>> {
    this.calls.push('getSession')
    if (this.sessionError) return { value: null, error: this.sessionError }
    return { value: this.session }
  }
  async refreshSession(): Promise<BackendResult<SessionLike>> {
    this.calls.push('refreshSession')
    if (this.refreshResult.value) this.session = this.refreshResult.value
    return this.refreshResult
  }
  async startOAuth(redirectTo: string): Promise<BackendResult<string>> {
    this.calls.push(`startOAuth:${redirectTo}`)
    return this.oauthResult
  }
  async exchangeCode(code: string): Promise<BackendResult<SessionLike>> {
    this.calls.push(`exchangeCode:${code}`)
    if (this.exchangeResult.value) this.session = this.exchangeResult.value
    return this.exchangeResult
  }
  async measurementReadiness() {
    this.calls.push('measurementReadiness')
    return { value: this.readiness }
  }
  async signOut(): Promise<void> {
    this.calls.push('signOut')
    if (this.signOutError) throw this.signOutError
    this.session = null
  }
  async deleteAccount(): Promise<BackendResult<true>> {
    this.calls.push('deleteAccount')
    if (this.deleteError) return { value: null, error: this.deleteError }
    this.session = null
    this.identity = null
    return { value: true }
  }
  async fetchIdentity(): Promise<BackendResult<KickbackIdentity>> {
    this.calls.push('fetchIdentity')
    if (this.identityError) return { value: null, error: this.identityError }
    return { value: this.identity }
  }
}

const REDIRECT = 'https://ngfopkeokddfnncdhfkhnffilbdhkkip.chromiumapp.org/'

let backend: FakeBackend

function makeService(launch: (url: string) => Promise<string>) {
  return createAuthService({
    backend,
    launchWebAuthFlow: launch,
    redirectUrl: REDIRECT,
  })
}

const succeedingLaunch = () => Promise.resolve(`${REDIRECT}?code=auth-code-123`)

beforeEach(() => {
  backend = new FakeBackend()
})

describe('callback parsing', () => {
  it('reads the PKCE authorization code from the query string', () => {
    expect(readCallback(`${REDIRECT}?code=abc123`)).toEqual({ code: 'abc123' })
  })

  it('reads a code delivered in the fragment', () => {
    expect(readCallback(`${REDIRECT}#code=abc123`)).toEqual({ code: 'abc123' })
  })

  it('surfaces a provider error instead of a code', () => {
    const result = readCallback(`${REDIRECT}?error=access_denied&error_description=Nope`)
    expect(result.code).toBeUndefined()
    expect(result.error).toBe('Nope')
  })

  it('rejects a callback with neither code nor error', () => {
    expect(readCallback(`${REDIRECT}?state=xyz`).error).toMatch(/did not complete/i)
  })

  it('rejects a malformed address', () => {
    expect(readCallback('not a url at all').error).toMatch(/could not read/i)
  })
})

describe('session expiry', () => {
  const now = 1_700_000_000_000
  it('treats a token expiring inside the skew window as expiring', () => {
    expect(isSessionExpiring({ expiresAt: now / 1000 + 60 }, now)).toBe(true)
  })
  it('leaves a healthy token alone', () => {
    expect(isSessionExpiring({ expiresAt: now / 1000 + 3600 }, now)).toBe(false)
  })
  it('treats an already-expired token as expiring', () => {
    expect(isSessionExpiring({ expiresAt: now / 1000 - 10 }, now)).toBe(true)
  })
  it('says nothing about a missing session', () => {
    expect(isSessionExpiring(null, now)).toBe(false)
  })
})

describe('initialisation', () => {
  it('reports signed out when there is no stored session', async () => {
    const auth = makeService(succeedingLaunch)
    await auth.initialize()

    expect(auth.getState()).toMatchObject({ status: 'signed_out', identity: null, friends: [] })
  })

  it('restores an existing session and loads the real identity', async () => {
    backend.session = LIVE_SESSION
    const auth = makeService(succeedingLaunch)
    await auth.initialize()

    expect(auth.getState().status).toBe('signed_in')
    expect(auth.getState().identity).toEqual(IDENTITY)
  })

  it('refreshes a session that is about to expire', async () => {
    backend.session = STALE_SESSION
    const auth = makeService(succeedingLaunch)
    await auth.initialize()

    expect(backend.calls).toContain('refreshSession')
    expect(auth.getState().status).toBe('signed_in')
  })

  it('signs out cleanly when the refresh token is no longer valid', async () => {
    backend.session = STALE_SESSION
    backend.refreshResult = { value: null, error: 'invalid refresh token' }
    const auth = makeService(succeedingLaunch)
    await auth.initialize()

    expect(backend.calls).toContain('signOut')
    expect(auth.getState()).toMatchObject({ status: 'signed_out', identity: null })
  })

  it('surfaces an outage as an error, never as a signed-out or fake state', async () => {
    backend.session = LIVE_SESSION
    backend.identityError = 'fetch failed'
    const auth = makeService(succeedingLaunch)
    await auth.initialize()

    const state = auth.getState()
    expect(state.status).toBe('error')
    expect(state.error).toMatch(/can't reach/i)
    expect(state.friends).toEqual([])
    expect(state.identity).toBeNull()
  })

  it('flags a missing Watchside profile distinctly from an outage', async () => {
    backend.session = LIVE_SESSION
    backend.identity = null
    const auth = makeService(succeedingLaunch)
    await auth.initialize()

    expect(auth.getState().error).toMatch(/profile is missing/i)
  })
})

describe('sign in', () => {
  it('completes the OAuth round trip and lands on the real identity', async () => {
    const auth = makeService(succeedingLaunch)
    await auth.initialize()
    await auth.signIn()

    expect(backend.calls).toContain(`startOAuth:${REDIRECT}`)
    expect(backend.calls).toContain('exchangeCode:auth-code-123')
    expect(auth.getState()).toMatchObject({
      status: 'signed_in',
      identity: IDENTITY,
      signingIn: false,
    })
  })

  it('treats the user closing the Twitch window as a non-event', async () => {
    const auth = makeService(() => Promise.reject(new Error('The user did not approve access.')))
    await auth.initialize()
    await auth.signIn()

    const state = auth.getState()
    expect(state.status).toBe('signed_out')
    expect(state.error).toBeNull() // backing out is not an error to apologise for
    expect(state.signingIn).toBe(false)
  })

  it('reports a callback that carries no authorization code', async () => {
    const auth = makeService(() => Promise.resolve(`${REDIRECT}?state=only`))
    await auth.initialize()
    await auth.signIn()

    expect(auth.getState()).toMatchObject({ status: 'signed_out', signingIn: false })
    expect(auth.getState().error).toMatch(/did not complete/i)
    expect(backend.calls.some((call) => call.startsWith('exchangeCode'))).toBe(false)
  })

  it('reports a provider refusal', async () => {
    const auth = makeService(() =>
      Promise.resolve(`${REDIRECT}?error=access_denied&error_description=You%20said%20no`),
    )
    await auth.initialize()
    await auth.signIn()

    expect(auth.getState().error).toBe('You said no')
  })

  it('errors when the code exchange fails', async () => {
    backend.exchangeResult = { value: null, error: 'bad verifier' }
    const auth = makeService(succeedingLaunch)
    await auth.initialize()
    await auth.signIn()

    expect(auth.getState().status).toBe('error')
    expect(auth.getState().friends).toEqual([])
  })

  it('errors when the provider URL cannot be built', async () => {
    backend.oauthResult = { value: null, error: 'provider disabled' }
    const auth = makeService(succeedingLaunch)
    await auth.initialize()
    await auth.signIn()

    expect(auth.getState().status).toBe('error')
  })

  it('ignores a second sign-in while one is already open', async () => {
    let release: (url: string) => void = () => {}
    const auth = makeService(() => new Promise<string>((resolve) => (release = resolve)))
    await auth.initialize()

    const first = auth.signIn()
    await auth.signIn() // should be a no-op
    release(`${REDIRECT}?code=auth-code-123`)
    await first

    const starts = backend.calls.filter((call) => call.startsWith('startOAuth'))
    expect(starts).toHaveLength(1)
  })
})

describe('sign out', () => {
  it('clears identity and returns to the signed-out state', async () => {
    backend.session = LIVE_SESSION
    const auth = makeService(succeedingLaunch)
    await auth.initialize()
    expect(auth.getState().status).toBe('signed_in')

    await auth.signOut()

    expect(auth.getState()).toMatchObject({
      status: 'signed_out',
      identity: null,
      friends: [],
      error: null,
    })
  })

  it('still clears the local session when the server cannot be reached', async () => {
    backend.session = LIVE_SESSION
    backend.signOutError = new Error('network down')
    const auth = makeService(succeedingLaunch)
    await auth.initialize()

    await auth.signOut()

    expect(auth.getState().status).toBe('signed_out')
    expect(auth.getState().identity).toBeNull()
  })

  it('allows signing back in afterwards', async () => {
    backend.session = LIVE_SESSION
    const auth = makeService(succeedingLaunch)
    await auth.initialize()
    await auth.signOut()
    await auth.signIn()

    expect(auth.getState().status).toBe('signed_in')
    expect(auth.getState().identity).toEqual(IDENTITY)
  })
})

describe('never invents data', () => {
  it('keeps the friends list empty in every reachable state', async () => {
    const observed: KickbackState[] = []
    backend.session = LIVE_SESSION
    const auth = makeService(succeedingLaunch)
    auth.subscribe((state) => observed.push(state))

    await auth.initialize()
    await auth.signOut()
    await auth.signIn()
    backend.identityError = 'boom'
    await auth.retry()

    expect(observed.length).toBeGreaterThan(4)
    for (const state of observed) {
      expect(state.friends).toEqual([])
      expect(state.demo).toBe(false)
    }
  })

  it('does not leak the underlying error text to the panel', async () => {
    backend.session = LIVE_SESSION
    backend.identityError = 'JWT eyJhbGciOiJIUzI1NiJ9.leaked.token'
    const auth = makeService(succeedingLaunch)
    const onError = vi.fn()

    const service = createAuthService({
      backend,
      launchWebAuthFlow: succeedingLaunch,
      redirectUrl: REDIRECT,
      onError,
    })
    await service.initialize()
    await auth.initialize()

    expect(service.getState().error).not.toMatch(/eyJ/)
    expect(service.getState().error).toMatch(/can't reach/i)
  })
})
