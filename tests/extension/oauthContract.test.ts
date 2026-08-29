import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSupabaseBackend } from '../../src/background/supabaseBackend'

/**
 * What Watchside asks of Twitch, and where it asks to be sent back.
 *
 * Written after F3, where the request was watched going out of a real Firefox
 * for the first time. Two properties held on the wire and neither was pinned by
 * anything:
 *
 *   scopes      -> null
 *   redirect_to -> exactly the value the browser adapter supplied
 *
 * Both deserve a test rather than a memory. A scope added here is not an
 * implementation detail: it changes the consent screen every user sees, and it
 * is a re-review event on the Chrome Web Store and on AMO simultaneously. A
 * redirect built locally instead of asked for would be wrong on at least one
 * engine, because Chromium and Gecko derive different URLs from the extension
 * id - and it would silently stop matching whatever is registered with
 * Supabase.
 *
 * Deliberately at this layer: this is the only place that talks to
 * supabase-js, and it is browser-neutral, so one test covers both engines.
 */

type OAuthCall = {
  provider?: string
  options?: { redirectTo?: string; skipBrowserRedirect?: boolean; scopes?: string }
}

/** Just enough Supabase to see what startOAuth asks for. */
function fakeSupabase(url = 'https://project.supabase.co/auth/v1/authorize?x=1') {
  const calls: OAuthCall[] = []
  const client = {
    auth: {
      signInWithOAuth: async (options: OAuthCall) => {
        calls.push(options)
        return { data: { url }, error: null }
      },
    },
  } as unknown as SupabaseClient
  return { client, calls }
}

describe('the OAuth request', () => {
  it('asks Twitch for no scopes at all', async () => {
    const { client, calls } = fakeSupabase()
    await createSupabaseBackend(client).startOAuth('https://redirect.example/')

    expect(calls).toHaveLength(1)
    // Not "scopes is empty" - the key must be ABSENT, so nothing downstream can
    // interpret an empty string as a request for defaults.
    expect(Object.hasOwn(calls[0].options ?? {}, 'scopes')).toBe(false)
    expect(calls[0].options?.scopes).toBeUndefined()
  })

  it('names Twitch as the provider', async () => {
    const { client, calls } = fakeSupabase()
    await createSupabaseBackend(client).startOAuth('https://redirect.example/')
    expect(calls[0].provider).toBe('twitch')
  })

  /**
   * The redirect is passed through, never constructed. Chromium returns
   * `https://<id>.chromiumapp.org/` and Gecko
   * `https://<hash>.extensions.allizom.org/`; both must be registered with
   * Supabase, and neither can be guessed.
   */
  it('sends back exactly the redirect it was given', async () => {
    const { client, calls } = fakeSupabase()
    const redirect = 'https://5af6f549.extensions.allizom.org/'
    await createSupabaseBackend(client).startOAuth(redirect)
    expect(calls[0].options?.redirectTo).toBe(redirect)
  })

  /** A background context cannot navigate; the extension opens the URL itself. */
  it('takes the URL rather than letting the browser follow it', async () => {
    const { client, calls } = fakeSupabase()
    await createSupabaseBackend(client).startOAuth('https://redirect.example/')
    expect(calls[0].options?.skipBrowserRedirect).toBe(true)
  })

  it('returns the authorize URL to the caller', async () => {
    const { client } = fakeSupabase('https://project.supabase.co/auth/v1/authorize?provider=twitch')
    const result = await createSupabaseBackend(client).startOAuth('https://redirect.example/')
    expect(result.value).toBe('https://project.supabase.co/auth/v1/authorize?provider=twitch')
    expect(result.error).toBeUndefined()
  })
})

describe('the composition root wires identity through the adapter', () => {
  const WORKER = readFileSync('src/background/index.ts', 'utf8')

  /**
   * Neither value may be hard-coded or rebuilt here. F1 moved both behind the
   * browser adapter precisely so the engine difference lives in one place.
   */
  it('asks the adapter for the redirect URL', () => {
    expect(WORKER).toContain('redirectUrl: ext.identity.getRedirectURL()')
    expect(WORKER).not.toContain('chromiumapp.org')
    expect(WORKER).not.toContain('allizom.org')
  })

  it('opens the sign-in window through the adapter', () => {
    expect(WORKER).toContain('launchWebAuthFlow: (url) => ext.identity.launchWebAuthFlow(url)')
  })

  /** auth.ts stays browser-neutral: it receives both, and reaches for neither. */
  it('leaves the auth service knowing nothing about the browser', () => {
    const auth = readFileSync('src/background/auth.ts', 'utf8')
    expect(auth).not.toContain('chrome.')
    expect(auth).not.toContain('browser.')
    expect(auth).toContain('launchWebAuthFlow(url: string): Promise<string>')
    expect(auth).toContain('redirectUrl: string')
  })
})
