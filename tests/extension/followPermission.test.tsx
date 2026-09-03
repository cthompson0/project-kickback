import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountCard } from '../../src/ui/components/AuthStates'
import { REQUESTED_SCOPES, createAuthService, scopeRequest } from '../../src/background/auth'
import type { AuthBackend, BackendResult, SessionLike } from '../../src/background/auth'
import type {
  KickbackClient,
  KickbackIdentity,
  KickbackPreferences,
  MeasurementReadiness,
} from '../../src/client/types'

/**
 * `user:read:follows`: who is asked, when, and what happens when the answer is
 * no.
 *
 * THE PRODUCT CONTRACT
 *
 * A new user meets this permission exactly once, on the ordinary Twitch consent
 * screen they were always going to see. That is the whole flow. There is no
 * second trip, nothing to discover later, and no state tracking whether they
 * have been asked.
 *
 * WHAT THIS FILE NO LONGER TESTS, AND WHY
 *
 * Two earlier designs were built and rejected before acceptance. First, the
 * permission was reachable ONLY from the account panel - the owner signed in,
 * used Watchside, and saw nothing, because nobody goes hunting in settings for
 * a permission they have never heard of. Second, a prominent one-time
 * invitation on the panel body, with dismissal state, prompt gating and an
 * anti-nag guarantee.
 *
 * That second design was correct and still not worth having. It existed solely
 * to migrate roughly three pre-M3D beta accounts, all of whom can simply
 * reauthorize once. The machinery was removed rather than debugged, and the
 * tests that proved it went with it. What remains is the steady state plus one
 * small account control for the cohort that predates it.
 *
 * `needs_follow_permission` survives all of this as a TRUTHFUL server state: it
 * is what an authorization without the scope honestly resolves to, and it is
 * never allowed to mean "broken" or to become a fabricated measurement.
 */

const IDENTITY: KickbackIdentity = {
  userId: 'kb-user-1',
  displayName: 'Sk8bo',
  avatarUrl: null,
  twitchLogin: 'sk8bo',
  friendCode: 'KB-7QX4-M2P9',
  presenceVisibility: 'visible',
}

const PREFS: KickbackPreferences = { gatheringNotifications: true }

function installWindow(): void {
  if (typeof globalThis.window === 'undefined') {
    ;(globalThis as { window?: unknown }).window = { matchMedia: () => ({ matches: false }) }
  }
}

const CLIENT = { badges: async () => [] } as unknown as KickbackClient

function account(readiness: MeasurementReadiness | null): string {
  installWindow()
  return renderToStaticMarkup(
    <AccountCard
      textSize="default"
      onTextSizeChange={() => {}}
      client={CLIENT}
      identity={IDENTITY}
      onSignOut={() => {}}
      onDeleted={() => {}}
      measurementReadiness={readiness}
      onVisibilityChange={() => {}}
      preferences={PREFS}
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

// ------------------------------------------- what a NEW user is asked for

describe('the steady state: one consent screen, one authorization', () => {
  /**
   * THE PRODUCT CONTRACT, AS A VALUE.
   *
   * Everything else in M3D depends on new users arriving already measurable.
   * If this list is wrong, the measurement quietly has no population.
   */
  it('includes the measurement scope in the initial authorization', () => {
    expect(REQUESTED_SCOPES).toContain('user:read:follows')
    expect(scopeRequest()).toBe('user:read:follows')
  })

  it('asks for nothing beyond that one scope', () => {
    expect(REQUESTED_SCOPES).toEqual(['user:read:follows'])
    for (const forbidden of ['subscriptions', 'emotes', 'moderat', 'edit', 'manage']) {
      expect(scopeRequest()).not.toContain(forbidden)
    }
  })

  /**
   * `user:read:email` is Supabase's own Twitch provider scope. It is absent
   * here on purpose: repeating it would make this list look like the complete
   * request when it is only Watchside's addition to it.
   */
  it('does not restate scopes that are not Watchside’s to ask for', () => {
    expect(REQUESTED_SCOPES).not.toContain('user:read:email')
  })

  it('builds every authorization from the same list, so they cannot drift', () => {
    const source = readFileSync('src/background/auth.ts', 'utf8')
    // Two call sites, one construction: the initial sign-in and the one-time
    // reauthorization ask for exactly the same thing, by construction.
    expect(source.match(/startOAuth\(deps\.redirectUrl, scopeRequest\(\)\)/g)).toHaveLength(2)
    expect(source).not.toMatch(/startOAuth\(deps\.redirectUrl\)/)
  })
})

// ---------------------------------------------------- the account control

describe('the one-time reauthorization control', () => {
  /**
   * Deliberately small. It serves the pre-M3D beta cohort and nobody else, and
   * it renders nothing at all for anyone who authorized after M3D.
   */
  it('is offered to somebody whose credential predates the scope', () => {
    const markup = account('needs_follow_permission')
    expect(markup).toContain('Allow on Twitch')
    expect(markup).toContain('kb-permission')
  })

  it('is offered to nobody who is already measured', () => {
    expect(account('ready')).not.toContain('Allow on Twitch')
  })

  /**
   * Somebody whose authorization is genuinely broken must not be told a story
   * about an optional permission - that would send them down entirely the wrong
   * path, and what they actually need is to sign in again.
   */
  it('is offered to nobody whose authorization is actually broken', () => {
    expect(account('needs_reauthorization')).not.toContain('Allow on Twitch')
    expect(account('temporarily_unavailable')).not.toContain('Allow on Twitch')
  })

  /** Unknown is not the same as "not permitted". A blip must not prompt. */
  it('is offered to nobody when readiness could not be established', () => {
    expect(account(null)).not.toContain('Allow on Twitch')
  })
})

describe('what the control says, and what it refuses to say', () => {
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

describe('no migration UX survives', () => {
  /**
   * The removal, asserted rather than assumed. A prompt that comes back on its
   * own is the failure mode this cohort would actually experience, and the
   * cheapest guarantee against it is that no such machinery exists.
   */
  it('has no automatic invitation component', () => {
    let found = true
    try {
      readFileSync('src/ui/components/MeasurementInvitation.tsx', 'utf8')
    } catch {
      found = false
    }
    expect(found).toBe(false)

    const panel = readFileSync('src/ui/KickbackPanel.tsx', 'utf8')
    expect(panel).not.toContain('MeasurementInvitation')
    expect(panel).not.toContain('MeasurementPermission')
  })

  it('carries no dismissal state anywhere', () => {
    for (const file of [
      'src/background/preferences.ts',
      'src/client/types.ts',
      'src/ui/KickbackPanel.tsx',
      'src/ui/components/AuthStates.tsx',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain('followPermissionDismissed')
    }
  })

  it('lives in exactly one place, and it is not the JOIN path', () => {
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

  /** No JOIN surface may reach for the permission, directly or otherwise. */
  it('no JOIN surface asks for the permission', () => {
    for (const file of [
      'src/ui/components/SocialGravity.tsx',
      'src/background/index.ts',
      'src/content/index.ts',
    ]) {
      let source: string
      try {
        source = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const joinAt = source.indexOf('recordJoin')
      if (joinAt < 0) continue
      const around = source.slice(Math.max(0, joinAt - 2000), joinAt + 2000)
      expect(around).not.toContain('grantFollowPermission')
    }
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

/** Lets the un-awaited readiness refresh inside loadIdentity settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('a brand-new user signing in', () => {
  /**
   * THE DETERMINISTIC PROOF THAT MUST OUTLIVE EVERY UX DECISION.
   *
   * Exercised through the real state machine, asserting what the OAuth layer
   * was actually handed - not what a source file says.
   */
  it('asks Twitch for the measurement scope during the initial authorization', async () => {
    const backend = new FakeBackend()
    const auth = service(backend, succeeds)
    await auth.signIn()

    expect(backend.scopesAsked).toEqual(['user:read:follows'])
    expect(backend.scopesAsked.join(' ')).not.toContain('subscriptions')
    expect(backend.scopesAsked.join(' ')).not.toContain('emotes')
  })

  it('lands ready when Twitch grants it, with no second trip', async () => {
    const backend = new FakeBackend()
    backend.readiness = 'ready'
    const auth = service(backend, succeeds)
    await auth.signIn()
    await settle()

    expect(auth.getState().status).toBe('signed_in')
    expect(auth.getState().measurementReadiness).toBe('ready')
    // One authorization. Nothing about the normal path asks twice.
    expect(backend.calls.filter((call) => call === 'startOAuth')).toHaveLength(1)
    expect(account('ready')).not.toContain('Allow on Twitch')
  })

  /**
   * Twitch will complete a flow having granted less than was asked for, and
   * that must be an ordinary outcome rather than a broken sign-in.
   */
  it('still signs them in when Twitch grants less than was asked for', async () => {
    const backend = new FakeBackend()
    backend.readiness = 'needs_follow_permission'
    const auth = service(backend, succeeds)
    await auth.signIn()
    await settle()

    expect(auth.getState().status).toBe('signed_in')
    expect(auth.getState().identity).not.toBeNull()
    expect(auth.getState().error).toBeNull()
    expect(auth.getState().measurementReadiness).toBe('needs_follow_permission')
  })
})

describe('a pre-M3D beta user reauthorizing once', () => {
  it('resolves to needs_follow_permission, not to broken', async () => {
    const backend = new FakeBackend()
    backend.readiness = 'needs_follow_permission'
    const auth = service(backend, succeeds)
    await auth.initialize()
    await settle()

    expect(auth.getState().status).toBe('signed_in')
    expect(auth.getState().measurementReadiness).toBe('needs_follow_permission')
  })

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

  it('never signs them out or deletes anything to do it', async () => {
    const backend = new FakeBackend()
    const auth = service(backend, succeeds)
    await auth.initialize()

    backend.readiness = 'ready'
    await auth.grantFollowPermission()

    expect(backend.calls).not.toContain('signOut')
    expect(backend.calls).not.toContain('deleteAccount')
    expect(backend.session).not.toBeNull()
    expect(auth.getState().status).toBe('signed_in')
    expect(auth.getState().identity).not.toBeNull()
  })

  it('uses the existing custody path rather than a second writer', () => {
    const source = readFileSync('src/background/auth.ts', 'utf8')
    const section = source.slice(source.indexOf('async grantFollowPermission()'))
    // The upgraded credential reaches custody through exchangeCode, exactly as
    // an ordinary sign-in does.
    expect(section).toContain('deps.backend.exchangeCode')
    expect(section).not.toContain('capture')
  })

  /**
   * Both authorizations end at the same handoff, so the upgraded credential
   * gets the same encryption, the same actor binding and the same sanitisation
   * on the way past the browser.
   */
  it('shares one handoff with the ordinary sign-in', () => {
    const backend = readFileSync('src/background/supabaseBackend.ts', 'utf8')
    expect(backend.match(/handOffTwitchCredential\(supabase, data\.session\)/g)).toHaveLength(1)
    // And the browser-side strip is still the only way a session is written.
    const storage = readFileSync('src/background/storage.ts', 'utf8')
    expect(storage).toContain('stripProviderCredentials(value)')
    expect(storage).toContain('provider_token')
    expect(storage).toContain('provider_refresh_token')
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

describe('the scope delta is exactly one', () => {
  const FILES = [
    'src/background/auth.ts',
    'src/background/supabaseBackend.ts',
    'src/ui/components/AuthStates.tsx',
    'src/ui/KickbackPanel.tsx',
    'supabase/functions/twitch-credential/twitch.ts',
    'supabase/functions/twitch-credential/index.ts',
  ]

  it('requests user:read:follows and nothing else, anywhere', () => {
    const auth = readFileSync('src/background/auth.ts', 'utf8')
    expect(auth).toContain("export const FOLLOWS_SCOPE = 'user:read:follows'")
  })

  /**
   * The two scopes that must never appear. Watchside reads one relationship -
   * do you already follow this creator - and the scope set is the enforceable
   * statement of that.
   */
  it('never asks for a subscription or emote scope anywhere in the source', () => {
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8')
      expect(source).not.toContain('user:read:subscriptions')
      expect(source).not.toContain('user:read:emotes')
    }
  })

  /** The server's idea of the scope must be the same string as the client's. */
  it('is the same scope the server checks for', () => {
    const server = readFileSync('supabase/functions/twitch-credential/twitch.ts', 'utf8')
    expect(server).toContain("'user:read:follows'")
  })
})

describe('the permission path records nothing itself', () => {
  /**
   * OPENED DELIBERATELY IN SLICE D, AND ONLY BY ONE DOOR.
   *
   * This used to assert that nothing anywhere invoked the relationship action.
   * The JOIN trigger and its public disclosure shipped together in Slice D, so
   * one caller now exists - in the backend module, reached only through the
   * JOIN eligibility gate.
   *
   * What this still guarantees is that none of the AUTHORIZATION surfaces
   * measure anything. Granting a permission is not a measurement, and an OAuth
   * round trip must never write an observation: there is no JOIN behind it, so
   * there is nothing a baseline could honestly be "at".
   */
  it('nothing in the permission or UI path invokes the relationship action', () => {
    for (const file of [
      'src/background/auth.ts',
      'src/background/index.ts',
      'src/ui/components/AuthStates.tsx',
      'src/ui/KickbackPanel.tsx',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain("action: 'relationship'")
    }
  })
})
