import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createExtensionStorage,
  createMemoryStorageArea,
  stripProviderCredentials,
} from '../../src/background/storage'
import type { AsyncStorageArea } from '../../src/background/storage'

/**
 * Twitch credentials must never reach the disk.
 *
 * WHAT THIS PROTECTS
 *
 * Signing in to Watchside signs you in to Supabase, and Supabase hands back
 * Twitch's own OAuth credentials alongside its own: `provider_token` and
 * `provider_refresh_token`. Watchside has never wanted them. `toSession()`
 * discards them the moment they arrive, and nothing in the product reads them.
 *
 * They reached chrome.storage.local anyway. supabase-js serialises the entire
 * session object and hands the string to this adapter, which used to write
 * whatever it was given. So a live Twitch access token and a live Twitch refresh
 * token sat on disk after every sign-in - a credential Watchside neither asked
 * for nor used.
 *
 * The reason it went unnoticed is worth keeping: it is invisible from
 * Watchside's source. Grepping the repository for `provider_token` returns
 * nothing, because the write happens inside a dependency, below Watchside's own
 * boundary. Only a real sign-in showed it. Reasoning about what a codebase
 * stores by reading only that codebase is what missed this.
 *
 * THE DISTINCTION THESE TESTS DEFEND
 *
 * `access_token` and `refresh_token` are SUPABASE's, and they are what keeps
 * somebody signed in. They must survive untouched. `provider_token` and
 * `provider_refresh_token` are TWITCH's, and they must never be written.
 *
 * A sanitiser that confuses the two either signs everybody out or keeps storing
 * the credential. Both directions are covered below.
 *
 * IF A TEST HERE FAILS, DO NOT LOOSEN THE ASSERTION.
 *
 * A failure means either a Twitch credential is being persisted again, or
 * Watchside's own session is being damaged.
 */

/** The shape supabase-js persists after a Twitch sign-in, provider fields and all. */
const SIGN_IN_SESSION = {
  access_token: 'supabase-access-token',
  refresh_token: 'supabase-refresh-token',
  expires_at: 1_900_000_000,
  expires_in: 3600,
  token_type: 'bearer',
  provider_token: 'twitch-access-token',
  provider_refresh_token: 'twitch-refresh-token',
  user: { id: 'kb-user-1', email: 'someone@example.test' },
}

/** What a Supabase refresh returns: the same session, minus anything from Twitch. */
const REFRESHED_SESSION = {
  access_token: 'supabase-access-token-2',
  refresh_token: 'supabase-refresh-token-2',
  expires_at: 1_900_003_600,
  expires_in: 3600,
  token_type: 'bearer',
  user: { id: 'kb-user-1', email: 'someone@example.test' },
}

const KEY = 'sb-project-auth-token'

/** Reads what actually landed in the area, without going back through the adapter. */
async function raw(area: AsyncStorageArea, key = KEY): Promise<string | null> {
  const result = await area.get(key)
  const value = result[key]
  return typeof value === 'string' ? value : null
}

describe('a Twitch credential never reaches storage', () => {
  it('strips provider_token on the way in', async () => {
    const area = createMemoryStorageArea()
    const storage = createExtensionStorage(area)

    await storage.setItem(KEY, JSON.stringify({ ...SIGN_IN_SESSION, provider_refresh_token: undefined }))

    const stored = await raw(area)
    expect(stored).not.toContain('provider_token')
    expect(stored).not.toContain('twitch-access-token')
  })

  it('strips provider_refresh_token on the way in', async () => {
    const area = createMemoryStorageArea()
    const storage = createExtensionStorage(area)

    await storage.setItem(KEY, JSON.stringify({ ...SIGN_IN_SESSION, provider_token: undefined }))

    const stored = await raw(area)
    expect(stored).not.toContain('provider_refresh_token')
    expect(stored).not.toContain('twitch-refresh-token')
  })

  it('strips both when a real sign-in carries both', async () => {
    const area = createMemoryStorageArea()
    const storage = createExtensionStorage(area)

    await storage.setItem(KEY, JSON.stringify(SIGN_IN_SESSION))

    const stored = await raw(area)
    expect(stored).not.toContain('provider_token')
    expect(stored).not.toContain('provider_refresh_token')
    expect(stored).not.toContain('twitch-access-token')
    expect(stored).not.toContain('twitch-refresh-token')

    // And nothing else was invented or lost.
    expect(JSON.parse(stored ?? '{}')).toEqual({
      access_token: 'supabase-access-token',
      refresh_token: 'supabase-refresh-token',
      expires_at: 1_900_000_000,
      expires_in: 3600,
      token_type: 'bearer',
      user: { id: 'kb-user-1', email: 'someone@example.test' },
    })
  })

  /**
   * The direction that would sign everybody out.
   *
   * `refresh_token` and `provider_refresh_token` differ by a prefix. A
   * substring-based sanitiser would take both and lock every user out of
   * Watchside, so this asserts on the exact values, not just the key names.
   */
  it("leaves Supabase's own tokens completely alone", async () => {
    const area = createMemoryStorageArea()
    const storage = createExtensionStorage(area)

    await storage.setItem(KEY, JSON.stringify(SIGN_IN_SESSION))
    const stored = JSON.parse((await raw(area)) ?? '{}')

    expect(stored.access_token).toBe('supabase-access-token')
    expect(stored.refresh_token).toBe('supabase-refresh-token')
    expect(stored.expires_at).toBe(1_900_000_000)
    expect(stored.token_type).toBe('bearer')
    expect(stored.user).toEqual({ id: 'kb-user-1', email: 'someone@example.test' })
  })

  /** supabase-js has moved the session around inside its stored blob before. */
  it('finds them however deeply the session is wrapped', () => {
    const wrapped = JSON.stringify({
      currentSession: { ...SIGN_IN_SESSION },
      expiresAt: 1_900_000_000,
    })

    const cleaned = JSON.parse(stripProviderCredentials(wrapped))

    expect(cleaned.currentSession.provider_token).toBeUndefined()
    expect(cleaned.currentSession.provider_refresh_token).toBeUndefined()
    expect(cleaned.currentSession.access_token).toBe('supabase-access-token')
  })

  it('passes through values that are not JSON at all', () => {
    expect(stripProviderCredentials('not json')).toBe('not json')
    expect(stripProviderCredentials('')).toBe('')
  })

  /** A clean write must keep its exact bytes rather than being re-serialised. */
  it('does not rewrite a session that never had them', () => {
    const clean = JSON.stringify(REFRESHED_SESSION)
    expect(stripProviderCredentials(clean)).toBe(clean)
  })
})

describe('the Watchside session still works', () => {
  it('restores a sanitised session on read', async () => {
    const storage = createExtensionStorage(createMemoryStorageArea())

    await storage.setItem(KEY, JSON.stringify(SIGN_IN_SESSION))
    const restored = JSON.parse((await storage.getItem(KEY)) ?? '{}')

    expect(restored.access_token).toBe('supabase-access-token')
    expect(restored.refresh_token).toBe('supabase-refresh-token')
    expect(restored.user.id).toBe('kb-user-1')
    expect(restored.provider_token).toBeUndefined()
  })

  /** Supabase refresh writes a new session; it must round-trip untouched. */
  it('keeps a refreshed session byte-identical', async () => {
    const area = createMemoryStorageArea()
    const storage = createExtensionStorage(area)
    const refreshed = JSON.stringify(REFRESHED_SESSION)

    await storage.setItem(KEY, JSON.stringify(SIGN_IN_SESSION))
    await storage.setItem(KEY, refreshed)

    expect(await raw(area)).toBe(refreshed)
    expect(await storage.getItem(KEY)).toBe(refreshed)
  })

  it('still signs out', async () => {
    const area = createMemoryStorageArea()
    const storage = createExtensionStorage(area)

    await storage.setItem(KEY, JSON.stringify(SIGN_IN_SESSION))
    await storage.removeItem(KEY)

    expect(await storage.getItem(KEY)).toBeNull()
    expect(await raw(area)).toBeNull()
  })

  it('reports a missing session as null rather than a string', async () => {
    const storage = createExtensionStorage(createMemoryStorageArea())
    expect(await storage.getItem(KEY)).toBeNull()
  })
})

describe('somebody who signed in before this shipped', () => {
  /**
   * Stripping on write does nothing for a credential that is already on disk.
   * Reading is the first opportunity to remove it, so it is taken.
   */
  it('has the credential purged the first time the session is read', async () => {
    const area = createMemoryStorageArea()
    await area.set({ [KEY]: JSON.stringify(SIGN_IN_SESSION) })
    const storage = createExtensionStorage(area)

    expect(await raw(area)).toContain('twitch-refresh-token')

    await storage.getItem(KEY)

    const stored = await raw(area)
    expect(stored).not.toContain('provider_token')
    expect(stored).not.toContain('twitch-refresh-token')
    expect(JSON.parse(stored ?? '{}').access_token).toBe('supabase-access-token')
  })

  /** A cleanup that cannot be written must not become a failure to sign in. */
  it('is still signed in even if the purge write fails', async () => {
    const area = createMemoryStorageArea()
    await area.set({ [KEY]: JSON.stringify(SIGN_IN_SESSION) })
    const failing: AsyncStorageArea = {
      get: (keys) => area.get(keys),
      set: () => Promise.reject(new Error('storage full')),
      remove: (keys) => area.remove(keys),
    }

    const restored = JSON.parse((await createExtensionStorage(failing).getItem(KEY)) ?? '{}')

    expect(restored.access_token).toBe('supabase-access-token')
    expect(restored.provider_token).toBeUndefined()
  })
})

describe('the boundary is the only place this happens', () => {
  /**
   * Chrome and Firefox both hand `createExtensionStorage` an AsyncStorageArea
   * and differ only in which browser API backs it. The sanitiser therefore sits
   * ABOVE the browser split, and neither platform can opt out of it.
   */
  it('behaves identically whichever browser area backs it', async () => {
    const results: string[] = []
    for (const area of [createMemoryStorageArea(), createMemoryStorageArea()]) {
      const storage = createExtensionStorage(area)
      await storage.setItem(KEY, JSON.stringify(SIGN_IN_SESSION))
      results.push((await raw(area)) ?? '')
    }

    expect(results[0]).toBe(results[1])
    expect(results[0]).not.toContain('provider_token')
  })

  it('is not bypassed by a second storage adapter somewhere else', () => {
    const source = readFileSync('src/background/storage.ts', 'utf8')
    // The Supabase adapter is the one seam supabase-js writes through.
    expect(source).toContain('stripProviderCredentials(value)')
    expect(source.match(/await area\.set\(\{ \[key\]: value \}\)/g)).toBeNull()
  })

  /**
   * Nothing else in Watchside may read, copy or store a provider credential.
   * If some future code starts handling one, it should have to change this
   * test deliberately rather than inherit an exemption by accident.
   *
   * WIDENED AT THE PHASE 2 CUSTODY GATE, ON PURPOSE.
   *
   * It listed one file until Watchside began deliberately handing the
   * credential to its own server. Two files may name one now, and their roles
   * are opposite: storage.ts REMOVES them from anything persisted, and
   * supabaseBackend.ts reads them once, in memory, to hand off. The persistence
   * guarantee above is unchanged - custody made the credential go somewhere
   * new, not stay somewhere new.
   *
   * A third file would mean somebody started handling a Twitch credential
   * somewhere nobody has thought about.
   */
  it('is one of only two files in the product that mention a provider credential', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`
        if (entry.isDirectory()) walk(path)
        else if (/\.tsx?$/.test(entry.name)) {
          if (/provider_token|provider_refresh_token/.test(readFileSync(path, 'utf8'))) {
            offenders.push(path)
          }
        }
      }
    }
    walk('src')

    expect(offenders.sort()).toEqual([
      'src/background/storage.ts',
      'src/background/supabaseBackend.ts',
    ])
  })
})
