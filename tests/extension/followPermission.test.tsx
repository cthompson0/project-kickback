import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountCard } from '../../src/ui/components/AuthStates'
import { createAuthService } from '../../src/background/auth'
import type { AuthBackend, BackendResult, SessionLike } from '../../src/background/auth'
import type {
  KickbackClient,
  KickbackIdentity,
  KickbackPreferences,
  MeasurementReadiness,
} from '../../src/client/types'

/**
 * Asking for an optional permission without making it feel required.
 *
 * Everybody who signed in before M3D has a perfectly good Twitch credential
 * that simply predates this permission. Nothing about their account is broken,
 * and the two failure modes to avoid pull in opposite directions:
 *
 *   tell them they are broken   -> untrue, and pushes them through repair UX
 *   never mention it at all     -> no coverage, and no measurement
 *
 * The resolution is one control in the account panel - somewhere people go
 * deliberately - that explains itself, can be waved away, and never appears
 * anywhere else. Above all it never appears between a JOIN click and arriving
 * on Twitch, which would both annoy people and contaminate the measurement it
 * exists to enable.
 */

const IDENTITY: KickbackIdentity = {
  userId: 'kb-user-1',
  displayName: 'Sk8bo',
  avatarUrl: null,
  twitchLogin: 'sk8bo',
  friendCode: 'KB-7QX4-M2P9',
  presenceVisibility: 'visible',
}

const PREFS: KickbackPreferences = {
  gatheringNotifications: true,
  followPermissionDismissed: false,
}

function installWindow(): void {
  if (typeof globalThis.window === 'undefined') {
    ;(globalThis as { window?: unknown }).window = { matchMedia: () => ({ matches: false }) }
  }
}

function account(
  readiness: MeasurementReadiness | null,
  preferences: KickbackPreferences = PREFS,
): string {
  installWindow()
  return renderToStaticMarkup(
    <AccountCard
      client={{ badges: async () => [] } as unknown as KickbackClient}
      identity={IDENTITY}
      onSignOut={() => {}}
      onDeleted={() => {}}
      measurementReadiness={readiness}
      onVisibilityChange={() => {}}
      preferences={preferences}
      onPreferencesChange={() => {}}
      mutedUserIds={[]}
      knownPeople={[]}
      onUnmute={() => {}}
      blocked={[]}
      onUnblock={() => {}}
      onFeedback={() => {}}
      onClose={() => {}}
      onResetLayout={() => {}}
    />,
  )
}

describe('who is offered the permission', () => {
  it('offers it to somebody whose credential predates it', () => {
    const markup = account('needs_follow_permission')
    expect(markup).toContain('Allow on Twitch')
    expect(markup).toContain('kb-permission')
  })

  it('offers nothing to somebody already measured', () => {
    expect(account('ready')).not.toContain('Allow on Twitch')
  })

  /**
   * Somebody whose authorization is genuinely broken must not be told a story
   * about an optional permission - that would send them down the wrong path
   * entirely.
   */
  it('offers nothing when the authorization is actually broken', () => {
    expect(account('needs_reauthorization')).not.toContain('Allow on Twitch')
    expect(account('temporarily_unavailable')).not.toContain('Allow on Twitch')
  })

  /** Unknown is not the same as "not permitted". A blip must not prompt. */
  it('offers nothing when readiness could not be established', () => {
    expect(account(null)).not.toContain('Allow on Twitch')
  })
})

describe('what it says, and what it refuses to say', () => {
  const markup = account('needs_follow_permission')

  it('explains what is checked and why, in plain terms', () => {
    expect(markup).toContain('already follow')
    expect(markup).toContain('through a friend')
  })

  it('says plainly that it is optional', () => {
    expect(markup).toContain('Optional')
    expect(markup).toContain('works without it')
  })

  it('promises it will not change who they follow', () => {
    expect(markup).toContain('never changes')
  })

  /** The claims that would be untrue, or would read as coercion. */
  it('never implies Watchside needs it', () => {
    for (const forbidden of ['required', 'must grant', 'you need to', 'in order to use']) {
      expect(markup.toLowerCase()).not.toContain(forbidden)
    }
  })

  it('never mentions subscriptions or purchases', () => {
    for (const forbidden of ['subscription', 'purchase', 'payment', 'bits']) {
      expect(markup.toLowerCase()).not.toContain(forbidden)
    }
  })
})

describe('waving it away', () => {
  it('collapses to a single line rather than disappearing', () => {
    const markup = account('needs_follow_permission', {
      ...PREFS,
      followPermissionDismissed: true,
    })
    // The explanation is gone; the way to grant it later is not.
    expect(markup).not.toContain('kb-permission')
    expect(markup).toContain('Help measure discovery')
  })

  it('is remembered, so nothing asks again on its own', () => {
    const source = readFileSync('src/background/preferences.ts', 'utf8')
    expect(source).toContain('followPermissionDismissed')
    // Default false: nothing is dismissed until somebody dismisses it.
    expect(source).toMatch(/followPermissionDismissed: false/)
  })

  /**
   * Dismissal is not refusal. Nothing anywhere treats it as a permanent
   * decision, and the control that grants the permission survives it.
   */
  it('is not recorded as a refusal', () => {
    const source = readFileSync('src/ui/components/AuthStates.tsx', 'utf8')
    const section = source.slice(
      // From the doc comment, which is where the intent is written down.
      source.indexOf('The optional permission that lets Watchside'),
      source.indexOf('function DeleteAccountSection'),
    )
    expect(section).toContain('not a refusal')
    // The dismissed branch still offers the grant.
    const dismissed = section.slice(section.indexOf('if (dismissed)'))
    expect(dismissed).toContain('onClick={grant}')
  })
})

describe('nothing interrupts a JOIN', () => {
  /**
   * The prompt lives in exactly one place. A JOIN, a Twitch page or a startup
   * must never be able to raise it - a consent window between the click and the
   * arrival would delay the social moment AND contaminate the baseline it is
   * meant to measure.
   */
  it('is rendered only by the account panel', () => {
    const panel = readFileSync('src/ui/KickbackPanel.tsx', 'utf8')
    expect(panel).not.toContain('MeasurementPermission')

    const auth = readFileSync('src/ui/components/AuthStates.tsx', 'utf8')
    expect(auth.match(/<MeasurementPermission/g)).toHaveLength(1)
  })

  it('is never triggered by anything automatic', () => {
    const worker = readFileSync('src/background/index.ts', 'utf8')
    // Present as an RPC somebody can call; called by nothing on a schedule.
    expect(worker).toContain('grantFollowPermission')
    expect(worker).not.toMatch(/setInterval[^)]*grantFollowPermission/)
    expect(worker).not.toMatch(/alarms[^)]*grantFollowPermission/)
  })
})

// ------------------------------------------------------------- the auth flow

const LIVE: SessionLike = { expiresAt: Math.floor(Date.now() / 1000) + 3600 }

class FakeBackend implements AuthBackend {
  session: SessionLike | null = LIVE
  identity: KickbackIdentity | null = IDENTITY
  readiness: MeasurementReadiness | null = 'needs_follow_permission'
  oauthUrl: BackendResult<string> = { value: 'https://id.twitch.test/authorize' }
  calls: string[] = []
  scopesAsked: (string | undefined)[] = []

  async getSession() {
    return { value: this.session }
  }
  async refreshSession() {
    return { value: this.session }
  }
  async startOAuth(_redirectTo: string, scopes?: string) {
    this.calls.push('startOAuth')
    this.scopesAsked.push(scopes)
    return this.oauthUrl
  }
  async exchangeCode() {
    this.calls.push('exchangeCode')
    return { value: LIVE }
  }
  async measurementReadiness() {
    this.calls.push('measurementReadiness')
    return { value: this.readiness }
  }
  async signOut() {
    this.calls.push('signOut')
    this.session = null
  }
  async deleteAccount(): Promise<BackendResult<true>> {
    this.calls.push('deleteAccount')
    return { value: true }
  }
  async fetchIdentity() {
    return this.identity ? { value: this.identity } : { value: null, error: 'no identity' }
  }
}

function service(backend: FakeBackend, launch: () => Promise<string>) {
  return createAuthService({
    backend,
    launchWebAuthFlow: launch,
    redirectUrl: 'https://redirect.test',
  })
}

const succeeds = () => Promise.resolve('https://redirect.test?code=abc')

describe('granting the permission', () => {
  it('asks Twitch for exactly one extra scope', async () => {
    const backend = new FakeBackend()
    const auth = service(backend, succeeds)
    await auth.initialize()

    backend.readiness = 'ready'
    await auth.grantFollowPermission()

    expect(backend.scopesAsked).toContain('user:read:follows')
    expect(backend.scopesAsked.join(' ')).not.toContain('subscriptions')
  })

  /**
   * THE ONE THAT MATTERS MOST.
   *
   * Twitch will complete a flow having granted less than was asked for, so a
   * successful redirect is not evidence of permission. Readiness is re-read
   * from the server, which knows what the stored credential actually carries.
   */
  it('does not call itself ready just because OAuth came back', async () => {
    const backend = new FakeBackend()
    const auth = service(backend, succeeds)
    await auth.initialize()

    // OAuth "succeeds" but the server still reports the scope is absent.
    backend.readiness = 'needs_follow_permission'
    const result = await auth.grantFollowPermission()

    expect(result.ok).toBe(false)
    expect(backend.calls).toContain('measurementReadiness')
    expect(auth.getState().measurementReadiness).toBe('needs_follow_permission')
  })

  it('reports ready only when the server says the scope is stored', async () => {
    const backend = new FakeBackend()
    const auth = service(backend, succeeds)
    await auth.initialize()

    backend.readiness = 'ready'
    const result = await auth.grantFollowPermission()

    expect(result).toEqual({ ok: true, error: null })
    expect(auth.getState().measurementReadiness).toBe('ready')
  })

  it('uses the existing custody path rather than a second writer', () => {
    const source = readFileSync('src/background/auth.ts', 'utf8')
    const section = source.slice(source.indexOf('async grantFollowPermission()'))
    // The upgraded credential reaches custody through exchangeCode, exactly as
    // an ordinary sign-in does.
    expect(section).toContain('deps.backend.exchangeCode')
    expect(section).not.toContain('capture')
  })
})

describe('declining costs nothing', () => {
  const cancelled = () => Promise.reject(new Error('The user did not approve access.'))

  it('leaves the person signed in when they back out', async () => {
    const backend = new FakeBackend()
    const auth = service(backend, cancelled)
    await auth.initialize()
    expect(auth.getState().status).toBe('signed_in')

    const result = await auth.grantFollowPermission()

    expect(result.ok).toBe(false)
    // Nothing went wrong, so nothing is reported as an error.
    expect(result.error).toBeNull()
    expect(auth.getState().status).toBe('signed_in')
    expect(auth.getState().identity).not.toBeNull()
  })

  it('does not sign them out, and does not touch their credential', async () => {
    const backend = new FakeBackend()
    const auth = service(backend, cancelled)
    await auth.initialize()

    await auth.grantFollowPermission()

    expect(backend.calls).not.toContain('signOut')
    expect(backend.calls).not.toContain('deleteAccount')
    expect(backend.session).not.toBeNull()
  })

  it('survives Twitch failing to start the flow at all', async () => {
    const backend = new FakeBackend()
    backend.oauthUrl = { value: null, error: 'twitch down' }
    const auth = service(backend, succeeds)
    await auth.initialize()

    const result = await auth.grantFollowPermission()

    expect(result.ok).toBe(false)
    expect(auth.getState().status).toBe('signed_in')
  })

  it('can be tried again later after any failure', async () => {
    const backend = new FakeBackend()
    const auth = service(backend, cancelled)
    await auth.initialize()
    expect((await auth.grantFollowPermission()).ok).toBe(false)

    const retry = service(backend, succeeds)
    await retry.initialize()
    backend.readiness = 'ready'
    expect((await retry.grantFollowPermission()).ok).toBe(true)
  })
})

describe('ordinary sign-in is unchanged', () => {
  it('asks for no extra scope', async () => {
    const backend = new FakeBackend()
    const auth = service(backend, succeeds)
    await auth.signIn()

    // The permission is optional, so nobody is asked for it merely to use
    // Watchside.
    expect(backend.scopesAsked).toEqual([undefined])
  })
})

describe('the scope delta is exactly one', () => {
  it('requests user:read:follows and nothing else, anywhere', () => {
    const auth = readFileSync('src/background/auth.ts', 'utf8')
    expect(auth).toContain("const FOLLOWS_SCOPE = 'user:read:follows'")
    expect(auth).not.toContain('user:read:subscriptions')

    const backend = readFileSync('src/background/supabaseBackend.ts', 'utf8')
    expect(backend).not.toContain('user:read:subscriptions')
  })
})
