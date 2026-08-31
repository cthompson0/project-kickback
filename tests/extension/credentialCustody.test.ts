import { describe, expect, it } from 'vitest'
import {
  CredentialCryptoError,
  FORMAT_VERSION,
  currentKeyVersion,
  keyRingFrom,
  keyVersionOf,
  open,
  seal,
} from '../../supabase/functions/twitch-credential/crypto'
import type { KeyRing } from '../../supabase/functions/twitch-credential/crypto'
import {
  EXPIRY_SKEW_SECONDS,
  expiryFrom,
  isSpent,
  parseRefresh,
  parseValidation,
  decideCapture,
  refreshTokens,
  validateToken,
} from '../../supabase/functions/twitch-credential/twitch'

/**
 * Holding somebody's Twitch credential.
 *
 * Watchside now stores a credential that can act on a user's Twitch account.
 * The whole justification for that is the boundary around it: the database
 * holds ciphertext, the key lives somewhere the database cannot reach, and the
 * plaintext exists only inside one function invocation.
 *
 * These tests are the boundary's proof. They are deliberately unforgiving,
 * because the failure they guard against is silent - a credential stored in a
 * way that looks fine and is readable by anyone who gets a database dump.
 *
 * Every key and token here is synthetic. No real Twitch credential appears in
 * this repository, in a fixture, or in a log.
 */

// 32 bytes, base64. Test material only - production keys live in Function
// secrets and are never committed, printed or shared with a dev environment.
const KEY_V1 = Buffer.alloc(32, 1).toString('base64')
const KEY_V2 = Buffer.alloc(32, 2).toString('base64')
const OTHER = Buffer.alloc(32, 9).toString('base64')

const KEYS: KeyRing = { 1: KEY_V1 }
const ROTATED: KeyRing = { 1: KEY_V1, 2: KEY_V2 }

const ACTOR = '11111111-1111-4111-8111-111111111111'
const OTHER_ACTOR = '22222222-2222-4222-8222-222222222222'

const SECRET = { accessToken: 'twitch-access-abc', refreshToken: 'twitch-refresh-xyz' }

const decoder = new TextDecoder()

describe('a stored credential is not readable', () => {
  it('round-trips for the actor it was sealed for', async () => {
    const envelope = await seal(SECRET, ACTOR, KEYS, 1)
    await expect(open(envelope, ACTOR, KEYS)).resolves.toEqual(SECRET)
  })

  /** The point of all of it: the bytes that reach Postgres are not the token. */
  it('never puts the plaintext in the stored bytes', async () => {
    const envelope = await seal(SECRET, ACTOR, KEYS, 1)
    const asText = decoder.decode(envelope)

    expect(asText).not.toContain(SECRET.accessToken)
    expect(asText).not.toContain(SECRET.refreshToken)
    expect(asText).not.toContain('twitch-access')
    expect(asText).not.toContain('twitch-refresh')
    // Nor the JSON shape that wraps them.
    expect(asText).not.toContain('"a"')
  })

  it('is self-describing about format and key version', async () => {
    const envelope = await seal(SECRET, ACTOR, KEYS, 1)
    expect(envelope[0]).toBe(FORMAT_VERSION)
    expect(keyVersionOf(envelope)).toBe(1)
  })

  /**
   * Nonce reuse is catastrophic for GCM, so this asserts the thing that
   * prevents it: every seal draws fresh randomness, and no caller ever supplies
   * a nonce.
   */
  it('uses a fresh nonce every time', async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 25; i += 1) {
      const envelope = await seal(SECRET, ACTOR, KEYS, 1)
      seen.add([...envelope.subarray(2, 14)].join(','))
    }
    expect(seen.size).toBe(25)
  })

  it('produces different ciphertext for the same input', async () => {
    const a = await seal(SECRET, ACTOR, KEYS, 1)
    const b = await seal(SECRET, ACTOR, KEYS, 1)
    expect([...a].join(',')).not.toBe([...b].join(','))
  })
})

describe('opening it fails closed', () => {
  /** The AAD binding. A row copied into another actor's row is useless. */
  it('refuses the wrong actor', async () => {
    const envelope = await seal(SECRET, ACTOR, KEYS, 1)
    await expect(open(envelope, OTHER_ACTOR, KEYS)).rejects.toThrow(CredentialCryptoError)
  })

  it('refuses the wrong key', async () => {
    const envelope = await seal(SECRET, ACTOR, KEYS, 1)
    await expect(open(envelope, ACTOR, { 1: OTHER })).rejects.toThrow(CredentialCryptoError)
  })

  it('refuses a key version it does not have', async () => {
    const envelope = await seal(SECRET, ACTOR, ROTATED, 2)
    // Only v1 configured: the row cannot be opened, and nothing is guessed.
    await expect(open(envelope, ACTOR, KEYS)).rejects.toMatchObject({ code: 'key_unavailable' })
  })

  it('refuses an unknown envelope format', async () => {
    const envelope = await seal(SECRET, ACTOR, KEYS, 1)
    envelope[0] = 99
    await expect(open(envelope, ACTOR, KEYS)).rejects.toMatchObject({
      code: 'format_unsupported',
    })
  })

  it('refuses a truncated envelope', async () => {
    const envelope = await seal(SECRET, ACTOR, KEYS, 1)
    await expect(open(envelope.subarray(0, 10), ACTOR, KEYS)).rejects.toMatchObject({
      code: 'ciphertext_malformed',
    })
  })

  /** A single flipped bit anywhere must fail the tag, not decrypt to garbage. */
  it('refuses modified ciphertext', async () => {
    const envelope = await seal(SECRET, ACTOR, KEYS, 1)
    envelope[envelope.length - 1] ^= 0x01
    await expect(open(envelope, ACTOR, KEYS)).rejects.toMatchObject({ code: 'decrypt_failed' })
  })

  it('refuses a modified nonce', async () => {
    const envelope = await seal(SECRET, ACTOR, KEYS, 1)
    envelope[5] ^= 0x01
    await expect(open(envelope, ACTOR, KEYS)).rejects.toMatchObject({ code: 'decrypt_failed' })
  })

  it('refuses a key of the wrong length', async () => {
    await expect(seal(SECRET, ACTOR, { 1: Buffer.alloc(16, 1).toString('base64') }, 1)).rejects.toMatchObject(
      { code: 'key_wrong_length' },
    )
  })

  it('refuses to seal with no key at all', async () => {
    await expect(seal(SECRET, ACTOR, {}, 1)).rejects.toMatchObject({ code: 'key_unavailable' })
    expect(() => currentKeyVersion({})).toThrow(CredentialCryptoError)
  })
})

describe('key rotation is additive', () => {
  it('writes new rows with the newest key', () => {
    expect(currentKeyVersion(KEYS)).toBe(1)
    expect(currentKeyVersion(ROTATED)).toBe(2)
  })

  /** A row sealed before rotation still opens afterwards, with no migration. */
  it('still opens rows sealed with the previous key', async () => {
    const old = await seal(SECRET, ACTOR, KEYS, 1)
    await expect(open(old, ACTOR, ROTATED)).resolves.toEqual(SECRET)
  })

  it('reads the ring from the environment by version', () => {
    const ring = keyRingFrom((name) =>
      name === 'TWITCH_CREDENTIAL_KEY_V1' ? KEY_V1 : name === 'TWITCH_CREDENTIAL_KEY_V3' ? KEY_V2 : undefined,
    )
    expect(Object.keys(ring).sort()).toEqual(['1', '3'])
    expect(currentKeyVersion(ring)).toBe(3)
  })

  it('is empty when nothing is configured, so the caller fails closed', () => {
    expect(keyRingFrom(() => undefined)).toEqual({})
  })
})

// ------------------------------------------------------------------- Twitch

describe('token validation is how identity is established', () => {
  const VALID = {
    client_id: 'watchside-client',
    login: 'sk8bo',
    user_id: '19477018',
    scopes: ['user:read:email'],
    expires_in: 14_124,
  }

  const respond = (status: number, body: unknown): typeof fetch =>
    (() =>
      Promise.resolve({
        status,
        ok: status >= 200 && status < 300,
        json: () => Promise.resolve(body),
      } as unknown as Response)) as unknown as typeof fetch

  it('reads the identity, scopes and real expiry', async () => {
    const result = await validateToken('token', respond(200, VALID))
    expect(result).toEqual({
      ok: true,
      token: {
        clientId: 'watchside-client',
        userId: '19477018',
        login: 'sk8bo',
        scopes: ['user:read:email'],
        expiresIn: 14_124,
      },
    })
  })

  it('treats 401 as an invalid token rather than an outage', async () => {
    const result = await validateToken('token', respond(401, { status: 401 }))
    expect(result).toEqual({ ok: false, reason: 'invalid_token' })
  })

  it('treats a server error as an outage', async () => {
    const result = await validateToken('token', respond(503, {}))
    expect(result).toEqual({ ok: false, reason: 'twitch_unavailable' })
  })

  it('treats a network failure as an outage', async () => {
    const boom = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch
    await expect(validateToken('token', boom)).resolves.toEqual({
      ok: false,
      reason: 'twitch_unavailable',
    })
  })

  /** A response missing what identity binding needs is not a partial success. */
  it('refuses a response with no user_id', () => {
    expect(parseValidation({ ...VALID, user_id: undefined })).toBeNull()
    expect(parseValidation({ ...VALID, client_id: undefined })).toBeNull()
    expect(parseValidation({ ...VALID, expires_in: 'soon' })).toBeNull()
    expect(parseValidation(null)).toBeNull()
  })

  it('tolerates a missing scope list as simply empty', () => {
    expect(parseValidation({ ...VALID, scopes: undefined })?.scopes).toEqual([])
  })
})

describe('refresh and rotation', () => {
  const REFRESHED = {
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    scope: ['user:read:email'],
    expires_in: 14_000,
    token_type: 'bearer',
  }

  const respond = (status: number, body: unknown): typeof fetch =>
    (() =>
      Promise.resolve({
        status,
        ok: status >= 200 && status < 300,
        json: () => Promise.resolve(body),
      } as unknown as Response)) as unknown as typeof fetch

  it('returns the replacement refresh token, not just a new access token', async () => {
    const result = await refreshTokens('old-refresh', 'id', 'secret', respond(200, REFRESHED))
    expect(result).toEqual({
      ok: true,
      tokens: {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        scopes: ['user:read:email'],
        expiresIn: 14_000,
      },
    })
  })

  /**
   * Twitch rotates. A response without a replacement is one we do not
   * understand, and storing half of it would leave custody in a state nobody
   * designed - so it is refused rather than partially applied.
   */
  it('refuses a response with no replacement refresh token', () => {
    expect(parseRefresh({ ...REFRESHED, refresh_token: undefined })).toBeNull()
    expect(parseRefresh({ ...REFRESHED, access_token: '' })).toBeNull()
    expect(parseRefresh({ ...REFRESHED, expires_in: null })).toBeNull()
  })

  it('treats 400 as a dead grant rather than an outage', async () => {
    const result = await refreshTokens('old', 'id', 'secret', respond(400, {}))
    expect(result).toEqual({ ok: false, reason: 'invalid_grant' })
  })

  it('treats 401 as a dead grant too', async () => {
    const result = await refreshTokens('old', 'id', 'secret', respond(401, {}))
    expect(result).toEqual({ ok: false, reason: 'invalid_grant' })
  })

  it('treats a 500 as an outage, which is recoverable', async () => {
    const result = await refreshTokens('old', 'id', 'secret', respond(500, {}))
    expect(result).toEqual({ ok: false, reason: 'twitch_unavailable' })
  })

  it('sends the client secret, because a confidential client must', async () => {
    let sentBody = ''
    const capture = ((_url: string, init: RequestInit) => {
      sentBody = String(init.body)
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () => Promise.resolve(REFRESHED),
      } as unknown as Response)
    }) as unknown as typeof fetch

    await refreshTokens('old-refresh', 'the-id', 'the-secret', capture)

    expect(sentBody).toContain('grant_type=refresh_token')
    expect(sentBody).toContain('client_id=the-id')
    expect(sentBody).toContain('client_secret=the-secret')
    expect(sentBody).toContain('refresh_token=old-refresh')
  })
})

describe('access-token expiry comes from Twitch, never from a constant', () => {
  const NOW = Date.parse('2026-08-31T12:00:00.000Z')

  it('derives the expiry from the actual expires_in', () => {
    expect(expiryFrom(3600, NOW)).toBe('2026-08-31T13:00:00.000Z')
    // A different lifetime gives a different answer - nothing is hard-coded.
    expect(expiryFrom(14_124, NOW)).toBe('2026-08-31T15:55:24.000Z')
  })

  it('treats a token inside the skew as already spent', () => {
    const soon = new Date(NOW + (EXPIRY_SKEW_SECONDS - 10) * 1000).toISOString()
    expect(isSpent(soon, NOW)).toBe(true)
  })

  it('treats a comfortably live token as fresh', () => {
    const later = new Date(NOW + 3600 * 1000).toISOString()
    expect(isSpent(later, NOW)).toBe(false)
  })

  /** Unknown expiry must mean "refresh", never "assume it is fine". */
  it('treats a missing or unparseable expiry as spent', () => {
    expect(isSpent(null, NOW)).toBe(true)
    expect(isSpent('whenever', NOW)).toBe(true)
  })

  it('does not hard-code a four-hour lifetime anywhere', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('supabase/functions/twitch-credential/twitch.ts', 'utf8')
    expect(source).toContain('expiresIn')
    expect(source).not.toMatch(/14400|4 \* 60 \* 60/)
  })
})

describe('identity binding decides whose credential this is', () => {
  const BASE = {
    tokenClientId: 'watchside-client',
    expectedClientId: 'watchside-client',
    boundActor: ACTOR,
    actorId: ACTOR,
  }

  it('accepts the actor’s own credential', () => {
    expect(decideCapture(BASE)).toEqual({ ok: true })
  })

  /** Somebody else's Twitch account, parked under this Watchside account. */
  it('refuses a credential belonging to a different Twitch identity', () => {
    expect(decideCapture({ ...BASE, boundActor: OTHER_ACTOR })).toEqual({
      ok: false,
      reason: 'identity_mismatch',
    })
  })

  /**
   * Absence of a mapping must never read as permission.
   *
   * A Twitch account Watchside has never seen resolves to null, and the
   * tempting shape - "no conflict, so allow it" - would let anybody store any
   * Twitch credential under their own account.
   */
  it('refuses an unknown Twitch identity rather than treating it as unclaimed', () => {
    expect(decideCapture({ ...BASE, boundActor: null })).toEqual({
      ok: false,
      reason: 'identity_mismatch',
    })
  })

  it('refuses a token minted for another application', () => {
    expect(decideCapture({ ...BASE, tokenClientId: 'someone-elses-app' })).toEqual({
      ok: false,
      reason: 'foreign_client',
    })
  })

  it('checks the client before it checks the identity', () => {
    // A foreign token that happens to match the actor is still refused, and
    // refused as the more fundamental problem.
    expect(decideCapture({ ...BASE, tokenClientId: 'other', boundActor: ACTOR })).toEqual({
      ok: false,
      reason: 'foreign_client',
    })
  })
})
