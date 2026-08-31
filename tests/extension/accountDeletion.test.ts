import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAuthService } from '../../src/background/auth'
import type { AuthBackend, BackendResult, SessionLike } from '../../src/background/auth'
import type { KickbackIdentity } from '../../src/client/types'

/**
 * Deleting an account, and the three events that are not the same thing.
 *
 *   sign-out            ends a session. Deletes NOTHING, anywhere.
 *   Twitch deauth       deletes the Twitch layer, keeps Watchside's analytics.
 *   account deletion    deletes everything the user owns.
 *
 * The first and third are exercised here; the second lives in the database
 * suite, because that is where it happens.
 *
 * This file also carries the release-blocking invariant for phase 1: NO
 * production path may send a Twitch credential to Watchside's server. The
 * destruction paths exist now; custody does not, and nothing shipped is allowed
 * to quietly start it.
 */

const IDENTITY: KickbackIdentity = {
  userId: 'kb-user-1',
  displayName: 'Sk8bo',
  avatarUrl: null,
  twitchLogin: 'sk8bo',
  friendCode: 'KB-7QX4-M2P9',
  presenceVisibility: 'visible',
}

const LIVE: SessionLike = { expiresAt: Math.floor(Date.now() / 1000) + 3600 }

class FakeBackend implements AuthBackend {
  session: SessionLike | null = LIVE
  identity: KickbackIdentity | null = IDENTITY
  deleteResult: BackendResult<true> = { value: true }
  calls: string[] = []

  async getSession() {
    this.calls.push('getSession')
    return { value: this.session }
  }
  async refreshSession() {
    this.calls.push('refreshSession')
    return { value: this.session }
  }
  async startOAuth() {
    this.calls.push('startOAuth')
    return { value: 'https://id.twitch.test/authorize' }
  }
  async exchangeCode() {
    this.calls.push('exchangeCode')
    return { value: LIVE }
  }
  async signOut() {
    this.calls.push('signOut')
    this.session = null
  }
  async deleteAccount() {
    this.calls.push('deleteAccount')
    if (this.deleteResult.value) {
      this.session = null
      this.identity = null
    }
    return this.deleteResult
  }
  async fetchIdentity() {
    this.calls.push('fetchIdentity')
    return this.identity ? { value: this.identity } : { value: null, error: 'no identity' }
  }
}

function service(backend: FakeBackend) {
  return createAuthService({
    backend,
    launchWebAuthFlow: () => Promise.resolve('https://redirect.test?code=x'),
    redirectUrl: 'https://redirect.test',
  })
}

describe('account deletion', () => {
  it('deletes and then clears the local session', async () => {
    const backend = new FakeBackend()
    const auth = service(backend)
    await auth.initialize()

    const result = await auth.deleteAccount()

    expect(result).toEqual({ ok: true, error: null })
    expect(backend.calls).toContain('deleteAccount')
    expect(auth.getState().status).toBe('signed_out')
    expect(auth.getState().identity).toBeNull()
  })

  /** The order matters: confirm, then clear. Never the reverse. */
  it('asks the server before it touches local state', async () => {
    const backend = new FakeBackend()
    const auth = service(backend)
    await auth.initialize()

    await auth.deleteAccount()

    const deleteAt = backend.calls.indexOf('deleteAccount')
    const signOutAt = backend.calls.lastIndexOf('signOut')
    expect(deleteAt).toBeGreaterThanOrEqual(0)
    expect(signOutAt).toBeGreaterThan(deleteAt)
  })

  /**
   * A failure must not look like success.
   *
   * If the account still exists, signing them out would leave them unable to
   * retry the thing they asked for, and believing it had worked.
   */
  it('reports failure and keeps the user signed in', async () => {
    const backend = new FakeBackend()
    backend.deleteResult = { value: null, error: 'server exploded' }
    const auth = service(backend)
    await auth.initialize()

    const result = await auth.deleteAccount()

    expect(result.ok).toBe(false)
    expect(result.error).toBe('server exploded')
    expect(auth.getState().status).toBe('signed_in')
    expect(auth.getState().identity).not.toBeNull()
  })

  it('still reports success if only the local cleanup fails', async () => {
    const backend = new FakeBackend()
    backend.signOut = async () => {
      throw new Error('storage gone')
    }
    const auth = service(backend)
    await auth.initialize()

    // The account IS deleted. A failure to tidy up locally must not be
    // reported as a failure to delete.
    await expect(auth.deleteAccount()).resolves.toEqual({ ok: true, error: null })
    expect(auth.getState().status).toBe('signed_out')
  })

  it('is safe to retry after a failure', async () => {
    const backend = new FakeBackend()
    backend.deleteResult = { value: null, error: 'temporary' }
    const auth = service(backend)
    await auth.initialize()

    expect((await auth.deleteAccount()).ok).toBe(false)

    backend.deleteResult = { value: true }
    expect((await auth.deleteAccount()).ok).toBe(true)
    expect(auth.getState().status).toBe('signed_out')
  })
})

describe('sign-out is not deletion', () => {
  /** The invariant. Sign-out must never reach a destruction path. */
  it('never calls deleteAccount', async () => {
    const backend = new FakeBackend()
    const auth = service(backend)
    await auth.initialize()

    await auth.signOut()

    expect(backend.calls).toContain('signOut')
    expect(backend.calls).not.toContain('deleteAccount')
  })

  it('leaves the account intact', async () => {
    const backend = new FakeBackend()
    const auth = service(backend)
    await auth.initialize()

    await auth.signOut()

    // The fake's identity survives, standing in for the server row that is
    // still there after somebody merely signs out.
    expect(backend.identity).not.toBeNull()
    expect(auth.getState().status).toBe('signed_out')
  })
})

describe('the client cannot name whose account to delete', () => {
  it('takes no argument at all', () => {
    const backend = new FakeBackend()
    const auth = service(backend)
    // Zero declared parameters: there is no id to pass, so a compromised tab
    // has nothing to put somebody else's account into. The server reads the
    // actor from the JWT.
    expect(auth.deleteAccount.length).toBe(0)
  })

  it('sends no identifier over the wire', () => {
    const source = readFileSync('src/background/supabaseBackend.ts', 'utf8')
    const call = source.slice(source.indexOf('deleteAccount'), source.indexOf('async signOut'))
    expect(call).toContain("body: { confirm: 'DELETE' }")
    expect(call).not.toMatch(/user_id|userId|actor_id|actorId/)
  })
})

// ------------------------------------------------------------ no custody yet

/**
 * PHASE 1 RELEASE BLOCKER.
 *
 * The destruction paths exist. Custody does not, and must not begin by
 * accident. These assert that nothing in the shipped product can send a Twitch
 * credential to a server or store one there.
 *
 * They are written to fail LOUDLY when custody is implemented deliberately, so
 * that turning them off is a decision somebody makes on purpose at the custody
 * gate rather than a line that quietly stopped being true.
 */
describe('no production path can store a Twitch credential', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path, out)
      else out.push(path)
    }
    return out
  }

  /*
   * UPDATED AT THE PHASE 2 CUSTODY GATE.
   *
   * This used to permit exactly one file. It was written to fail loudly the
   * moment custody was implemented, so widening it would be a deliberate act
   * rather than a line that quietly stopped being true - and it did fail, which
   * is the only reason this comment exists.
   *
   * Two files may now name a provider credential, and their roles are opposite:
   *
   *   storage.ts          REMOVES them from anything persisted (O7)
   *   supabaseBackend.ts  reads them once, in memory, to hand to the server
   *
   * A third would mean somebody started handling a Twitch credential somewhere
   * new, and should have to change this list on purpose.
   */
  it('names a provider credential in exactly two source files, with known roles', () => {
    const offenders = walk('src')
      .filter((path) => path.endsWith('.ts') || path.endsWith('.tsx'))
      .filter((path) => /provider_token|provider_refresh_token/.test(readFileSync(path, 'utf8')))
      .map((path) => path.split(sep).join('/'))
      .sort()

    expect(offenders).toEqual([
      'src/background/storage.ts',
      'src/background/supabaseBackend.ts',
    ])
  })

  /** The capture path may READ them. It may not keep them. */
  it('never persists, caches or logs the credential it hands off', () => {
    const source = readFileSync('src/background/supabaseBackend.ts', 'utf8')
    const handoff = source.slice(
      source.indexOf('async function handOffTwitchCredential'),
      source.indexOf('export function createSupabaseBackend'),
    )

    expect(handoff).toContain("action: 'capture'")
    for (const forbidden of ['setItem', 'localStorage', 'chrome.', 'storage']) {
      expect(handoff).not.toContain(forbidden)
    }
    // No log line anywhere near a token value.
    const NEWLINE = String.fromCharCode(10)
    for (const logged of handoff.split(NEWLINE).filter((l) => l.includes('console.'))) {
      expect(logged).not.toContain('accessToken')
      expect(logged).not.toContain('refreshToken')
    }
    // Declared Promise<void>: the tokens cannot travel back upward.
    expect(handoff).toContain('Promise<void>')
  })

  /** A retry loop is a reason to keep a plaintext credential alive. */
  it('does not retry the handoff', () => {
    const source = readFileSync('src/background/supabaseBackend.ts', 'utf8')
    const handoff = source.slice(
      source.indexOf('async function handOffTwitchCredential'),
      source.indexOf('export function createSupabaseBackend'),
    )
    for (const looping of ['for (', 'while (', 'setTimeout']) {
      expect(handoff).not.toContain(looping)
    }
  })

  it('has no Edge Function that reads or writes a provider credential', () => {
    const offenders = walk('supabase/functions')
      .filter((path) => /\.ts$/.test(path))
      .filter((path) => /provider_token|provider_refresh_token/.test(readFileSync(path, 'utf8')))

    expect(offenders).toEqual([])
  })

  it('has no server-side credential writer, only the destruction primitive', () => {
    const sql = readdirSync('supabase/migrations')
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readFileSync(join('supabase/migrations', name), 'utf8'))
      .join('\n')

    // The table exists so its deletion can be proven. Nothing inserts into it.
    expect(sql).toContain('create table if not exists public.twitch_credentials')
    expect(sql).not.toMatch(/insert\s+into\s+public\.twitch_credentials/i)
    expect(sql).toContain('delete from public.twitch_credentials')
  })

  it('never asks Twitch for a scope beyond the default', () => {
    const source = readFileSync('src/background/supabaseBackend.ts', 'utf8')
    expect(source).not.toContain('user:read:follows')
    expect(source).not.toContain('user:read:subscriptions')
    expect(source).not.toMatch(/scopes\s*:/)
  })

  it('keeps O7 stripping in place', () => {
    const storage = readFileSync('src/background/storage.ts', 'utf8')
    expect(storage).toContain('stripProviderCredentials(value)')
    expect(storage).toContain("'provider_token', 'provider_refresh_token'")
  })
})
