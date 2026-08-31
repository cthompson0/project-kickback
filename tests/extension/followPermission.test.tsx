import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountCard } from '../../src/ui/components/AuthStates'
import { MeasurementInvitation } from '../../src/ui/components/MeasurementInvitation'
import { REQUESTED_SCOPES, createAuthService, scopeRequest } from '../../src/background/auth'
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
 * THE PRODUCT SHAPE THIS FILE ENCODES
 *
 * A new user meets `user:read:follows` exactly once, on the ordinary Twitch
 * consent screen they were always going to see. There is no second trip, no
 * hunting through settings, and nothing to discover later.
 *
 * The people who signed in BEFORE that was true are a migration cohort, and a
 * shrinking one. They resolve to `needs_follow_permission`, they are invited
 * once somewhere they will actually see it, and if they say "not now" that is
 * the end of the asking.
 *
 * WHAT WAS REJECTED, AND WHY IT IS WORTH RECORDING
 *
 * The first implementation made the account panel the ONLY place this could be
 * found. That was designed around a handful of beta accounts rather than around
 * the steady state, and it failed the most basic test there is: the owner
 * signed in, looked at Watchside, and saw nothing. A permission nobody
 * encounters is not an optional permission - it is an absent one.
 *
 * The two failure modes still pull in opposite directions:
 *
 *   tell them they are broken   -> untrue, and pushes them through repair UX
 *   never mention it at all     -> no coverage, and no measurement
 *
 * Above all, none of this may appear between a JOIN click and arriving on
 * Twitch, which would both annoy people and contaminate the measurement it
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

const CLIENT = { badges: async () => [] } as unknown as KickbackClient

function account(
  readiness: MeasurementReadiness | null,
  preferences: KickbackPreferences = PREFS,
): string {
  installWindow()
  return renderToStaticMarkup(
    <AccountCard
      client={CLIENT}
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

/** The migration invitation, as it renders on the main panel surface. */
function invitation(readiness: MeasurementReadiness | null, dismissed = false): string {
  installWindow()
  return renderToStaticMarkup(
    <MeasurementInvitation
      client={CLIENT}
      readiness={readiness}
      dismissed={dismissed}
      onDismissedChange={() => {}}
    />,
  )
}

// ------------------------------------------------- what a NEW user is asked

describe('a new user is asked once, on the consent screen they already expected', () => {
  /**
   * The correction. Requesting the scope up front is what makes the account
   * control a fallback rather than the product.
   */
  it('includes the measurement scope in the initial authorization', () => {
    expect(REQUESTED_SCOPES).toContain('user:read:follows')
    expect(scopeRequest()).toBe('user:read:follows')
  })

  it('asks for nothing beyond that one scope', () => {
    expect(REQUESTED_SCOPES).toEqual(['user:read:follows'])
    // Not a scope Watchside has any business holding, in any list, ever.
    expect(scopeRequest()).not.toContain('subscriptions')
  })

  /**
   * `user:read:email` is Supabase's own Twitch provider scope. It is absent
   * here on purpose: repeating it would make this list look like the complete
   * request when it is only Watchside's addition to it.
   */
  it('does not restate scopes that are not Watchside’s to ask for', () => {
    expect(REQUESTED_SCOPES).not.toContain('user:read:email')
  })

  it('builds both authorizations from the same list, so they cannot drift', () => {
    const source = readFileSync('src/background/auth.ts', 'utf8')
    // Two call sites, one construction. A scope added for new users is by
    // construction the same scope offered to existing ones.
    expect(source.match(/startOAuth\(deps\.redirectUrl, scopeRequest\(\)\)/g)).toHaveLength(2)
    expect(source).not.toMatch(/startOAuth\(deps\.redirectUrl\)/)
  })
})

// ------------------------------------------------ who sees the invitation

describe('who is invited', () => {
  /** The migration cohort: a perfectly good credential that simply predates this. */
  it('invites somebody whose credential predates the permission', () => {
    const markup = invitation('needs_follow_permission')
    expect(markup).toContain('Continue with Twitch')
    expect(markup).toContain('kb-invite')
  })

  it('invites nobody who is already measured', () => {
    expect(invitation('ready')).toBe('')
  })

  /**
   * Somebody whose authorization is genuinely broken must not be told a story
   * about an optional permission - that would send them down the wrong path
   * entirely, and the thing they actually need is to sign in again.
   */
  it('invites nobody whose authorization is actually broken', () => {
    expect(invitation('needs_reauthorization')).toBe('')
    expect(invitation('temporarily_unavailable')).toBe('')
  })

  /** Unknown is not the same as "not permitted". A blip must not prompt. */
  it('invites nobody when readiness could not be established', () => {
    expect(invitation(null)).toBe('')
  })
})

describe('what the invitation says, and what it refuses to say', () => {
  const markup = invitation('needs_follow_permission')

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

describe('"Not now" ends the asking', () => {
  it('offers a way to decline that is not a dead end', () => {
    expect(invitation('needs_follow_permission')).toContain('Not now')
  })

  /**
   * The anti-nag guarantee. Not "shows less often" - stops. The prompt is
   * one-time, and the only thing that brings the subject back is the person
   * going looking for it.
   */
  it('stops appearing once it has been waved away', () => {
    expect(invitation('needs_follow_permission', true)).toBe('')
  })

  it('is remembered, so a restart does not start the conversation again', () => {
    const source = readFileSync('src/background/preferences.ts', 'utf8')
    expect(source).toContain('followPermissionDismissed')
    // Persisted, and defaulted false: nothing is dismissed until somebody
    // dismisses it, and a dismissal survives the worker being torn down.
    expect(source).toMatch(/followPermissionDismissed: false/)
    expect(source).toContain('storage.set')
  })

  it('nothing re-raises it on a schedule or a page change', () => {
    const source = readFileSync('src/ui/components/MeasurementInvitation.tsx', 'utf8')
    for (const forbidden of ['setTimeout', 'setInterval', 'useEffect']) {
      expect(source).not.toContain(forbidden)
    }
  })
})

describe('declining does not remove the way back', () => {
  /**
   * Dismissal is not refusal. Somebody who said "not now" and later changed
   * their mind needs somewhere stable to go - stable precisely BECAUSE the
   * prompt deliberately never returns on its own.
   */
  it('keeps a one-line grant control in the account panel', () => {
    const markup = account('needs_follow_permission', {
      ...PREFS,
      followPermissionDismissed: true,
    })
    // The explanation is gone; the way to grant it later is not.
    expect(markup).not.toContain('kb-permission')
    expect(markup).toContain('Help measure discovery')
  })

  it('is not recorded anywhere as a refusal', () => {
    const source = readFileSync('src/ui/components/AuthStates.tsx', 'utf8')
    const section = source.slice(
      source.indexOf('The optional permission that lets Watchside'),
      source.indexOf('function DeleteAccountSection'),
    )
    expect(section).toContain('not a refusal')
    const dismissed = section.slice(section.indexOf('if (dismissed)'))
    expect(dismissed).toContain('onClick={grant}')
  })

  it('answers "not now" once and honours it in both places', () => {
    // One flag. Dismissing on the main surface must not leave the account
    // panel still telling the same story at full length.
    const panel = readFileSync('src/ui/KickbackPanel.tsx', 'utf8')
    expect(panel).toContain('followPermissionDismissed')
    expect(invitation('needs_follow_permission', true)).toBe('')
    expect(account('needs_follow_permission', { ...PREFS, followPermissionDismissed: true }))
      .not.toContain('kb-permission')
  })
})

describe('nothing interrupts a JOIN', () => {
  /**
   * The invitation is visible, which is the whole point of the correction - so
   * "visible" has to be pinned down as ordinary panel content and nothing more.
   * A modal, an overlay or anything that intercepts a click could land between
   * a JOIN and arriving on Twitch, which would delay the social moment AND
   * contaminate the baseline it is meant to measure.
   */
  it('is ordinary panel content, not an overlay that can catch a click', () => {
    const source = readFileSync('src/ui/components/MeasurementInvitation.tsx', 'utf8')
    for (const forbidden of ['position: fixed', 'kb-modal', 'kb-overlay', 'createPortal']) {
      expect(source).not.toContain(forbidden)
    }
    const css = readFileSync('src/ui/kickback.css', 'utf8')
    const block = css.slice(css.indexOf('.kb-invite {'), css.indexOf('.kb-invite-title'))
    expect(block).not.toContain('position')
    expect(block).not.toContain('z-index')
  })

  it('renders in exactly one place, and it is not the JOIN path', () => {
    const panel = readFileSync('src/ui/KickbackPanel.tsx', 'utf8')
    expect(panel.match(/<MeasurementInvitation/g)).toHaveLength(1)

    // The account control is still the only MeasurementPermission, and it is
    // still only in the account panel.
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
      expect(around).not.toContain('MeasurementInvitation')
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

describe('signing in for the first time', () => {
  it('asks Twitch for the measurement scope during the initial authorization', async () => {
    const backend = new FakeBackend()
    const auth = service(backend, succeeds)
    await auth.signIn()

    expect(backend.scopesAsked).toEqual(['user:read:follows'])
    expect(backend.scopesAsked.join(' ')).not.toContain('subscriptions')
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
    expect(invitation(auth.getState().measurementReadiness)).toBe('')
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

describe('an existing user whose credential predates this', () => {
  it('resolves to needs_follow_permission, not to broken', async () => {
    const backend = new FakeBackend()
    backend.readiness = 'needs_follow_permission'
    const auth = service(backend, succeeds)
    await auth.initialize()
    await settle()

    expect(auth.getState().status).toBe('signed_in')
    expect(auth.getState().measurementReadiness).toBe('needs_follow_permission')
  })

  it('is invited on the surface they are already looking at', async () => {
    const backend = new FakeBackend()
    const auth = service(backend, succeeds)
    await auth.initialize()
    await settle()

    expect(invitation(auth.getState().measurementReadiness)).toContain('Continue with Twitch')
  })

  it('can grant it later, and the server is what says so', async () => {
    const backend = new FakeBackend()
    const auth = service(backend, succeeds)
    await auth.initialize()

    backend.readiness = 'ready'
    const result = await auth.grantFollowPermission()

    expect(result).toEqual({ ok: true, error: null })
    expect(auth.getState().measurementReadiness).toBe('ready')
    expect(invitation(auth.getState().measurementReadiness)).toBe('')
  })
})

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
  it('requests user:read:follows and nothing else, anywhere', () => {
    const auth = readFileSync('src/background/auth.ts', 'utf8')
    expect(auth).toContain("export const FOLLOWS_SCOPE = 'user:read:follows'")
    expect(auth).not.toContain('user:read:subscriptions')

    const backend = readFileSync('src/background/supabaseBackend.ts', 'utf8')
    expect(backend).not.toContain('user:read:subscriptions')
  })

  /** Nowhere in the shipped extension, not merely nowhere in these two files. */
  it('never asks for a subscription scope anywhere in the source', () => {
    const files = [
      'src/background/auth.ts',
      'src/background/supabaseBackend.ts',
      'src/ui/components/MeasurementInvitation.tsx',
      'src/ui/components/AuthStates.tsx',
      'supabase/functions/twitch-credential/twitch.ts',
      'supabase/functions/twitch-credential/index.ts',
    ]
    for (const file of files) {
      expect(readFileSync(file, 'utf8')).not.toContain('user:read:subscriptions')
    }
  })

  /** The server's idea of the scope must be the same string as the client's. */
  it('is the same scope the server checks for', () => {
    const server = readFileSync('supabase/functions/twitch-credential/twitch.ts', 'utf8')
    expect(server).toContain("'user:read:follows'")
  })
})

describe('no production caller records anything yet', () => {
  /**
   * The permission being grantable does not make the measurement live. Nothing
   * in the shipped extension calls the relationship action, so no observation
   * can exist before the JOIN trigger and its public disclosure ship together.
   */
  it('nothing in the extension invokes the relationship action', () => {
    for (const file of [
      'src/background/auth.ts',
      'src/background/supabaseBackend.ts',
      'src/background/index.ts',
      'src/ui/components/MeasurementInvitation.tsx',
      'src/ui/KickbackPanel.tsx',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain("action: 'relationship'")
    }
  })
})
