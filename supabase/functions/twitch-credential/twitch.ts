/**
 * The two Twitch calls custody needs, and their parsers.
 *
 * Kept apart from index.ts so the parsing - which is where a malformed or
 * hostile response becomes a stored value - can be exercised directly by tests
 * without a network or a deployed function.
 *
 * Both take a `fetch` so tests drive them with fixtures rather than mocking a
 * global.
 */

export const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate'
export const TOKEN_URL = 'https://id.twitch.tv/oauth2/token'

/**
 * What validation tells us.
 *
 * This is the identity-binding primitive. Twitch says who a token belongs to,
 * which is the only trustworthy answer - the client sending it certainly is
 * not.
 */
export interface ValidatedToken {
  clientId: string
  userId: string
  login: string
  scopes: string[]
  /** Seconds remaining. Twitch's own number, never a guess of ours. */
  expiresIn: number
}

export type ValidateResult =
  | { ok: true; token: ValidatedToken }
  | { ok: false; reason: 'invalid_token' | 'twitch_unavailable' | 'malformed_response' }

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

export function parseValidation(body: unknown): ValidatedToken | null {
  const record = (body ?? {}) as Record<string, unknown>
  const clientId = record.client_id
  const userId = record.user_id
  const login = record.login
  const expiresIn = record.expires_in

  if (typeof clientId !== 'string' || clientId.length === 0) return null
  if (typeof userId !== 'string' || userId.length === 0) return null
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) return null

  return {
    clientId,
    userId,
    login: typeof login === 'string' ? login : '',
    scopes: asStringArray(record.scopes),
    expiresIn,
  }
}

/**
 * Asks Twitch who a token belongs to.
 *
 * Twitch requires apps to validate on start and hourly thereafter, so this is
 * not an optional nicety - and it happens to answer the two questions custody
 * needs anyway: whose token is this, and how long is it good for.
 */
export async function validateToken(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ValidateResult> {
  let response: Response
  try {
    response = await fetchImpl(VALIDATE_URL, {
      headers: { authorization: `OAuth ${accessToken}` },
    })
  } catch {
    return { ok: false, reason: 'twitch_unavailable' }
  }

  if (response.status === 401) return { ok: false, reason: 'invalid_token' }
  if (!response.ok) return { ok: false, reason: 'twitch_unavailable' }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, reason: 'malformed_response' }
  }

  const token = parseValidation(body)
  return token ? { ok: true, token } : { ok: false, reason: 'malformed_response' }
}

export interface RefreshedTokens {
  accessToken: string
  refreshToken: string
  scopes: string[]
  expiresIn: number
}

export type RefreshResult =
  | { ok: true; tokens: RefreshedTokens }
  | { ok: false; reason: 'invalid_grant' | 'twitch_unavailable' | 'malformed_response' }

export function parseRefresh(body: unknown): RefreshedTokens | null {
  const record = (body ?? {}) as Record<string, unknown>
  const accessToken = record.access_token
  const refreshToken = record.refresh_token
  const expiresIn = record.expires_in

  // A refresh that does not return a replacement refresh token is not a
  // partial success - it is a response we do not understand, and storing half
  // of it would leave custody in a state nobody designed.
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) return null
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) return null

  return {
    accessToken,
    refreshToken,
    scopes: asStringArray(record.scope),
    expiresIn,
  }
}

/**
 * The confidential-client refresh.
 *
 * Requires the client secret, which is why this can only ever happen
 * server-side. Twitch rotates: the response carries a REPLACEMENT refresh
 * token, and the caller must store it or the grant is orphaned.
 */
export async function refreshTokens(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshResult> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })

  let response: Response
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
  } catch {
    return { ok: false, reason: 'twitch_unavailable' }
  }

  // 400/401 from the token endpoint means the refresh token is no longer
  // good - the user changed their password, or disconnected the app.
  if (response.status === 400 || response.status === 401) {
    return { ok: false, reason: 'invalid_grant' }
  }
  if (!response.ok) return { ok: false, reason: 'twitch_unavailable' }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { ok: false, reason: 'malformed_response' }
  }

  const tokens = parseRefresh(payload)
  return tokens ? { ok: true, tokens } : { ok: false, reason: 'malformed_response' }
}

/**
 * When a stored access token should be treated as spent.
 *
 * Twitch guarantees no fixed lifetime - "the expires_in field indicates how
 * long, in seconds, the token is valid for" - so this is derived from the
 * actual response and never from a constant. The skew means a token is
 * refreshed slightly before it dies rather than during a request that needed it.
 */
export const EXPIRY_SKEW_SECONDS = 300

export function expiryFrom(expiresIn: number, nowMs: number): string {
  return new Date(nowMs + expiresIn * 1000).toISOString()
}

export function isSpent(accessExpiresAt: string | null, nowMs: number): boolean {
  if (!accessExpiresAt) return true
  const expiry = Date.parse(accessExpiresAt)
  if (Number.isNaN(expiry)) return true
  return expiry - nowMs <= EXPIRY_SKEW_SECONDS * 1000
}

/**
 * Whether a credential may be stored under this actor.
 *
 * Extracted so it can be proven directly. This is the check that stops one
 * person's Twitch credential being parked under somebody else's Watchside
 * account - in either direction - and it is not the sort of thing that should
 * only be exercised through a deployed function.
 *
 * Two independent conditions, and both must hold:
 *
 *   the token was minted for OUR Twitch app, not some other client's
 *   the Twitch identity Twitch names is the one already connected to this actor
 *
 * The second is the important one. The client asserting "this is mine" is not
 * evidence of anything; Twitch's answer is.
 */
export type CaptureDecision =
  | { ok: true }
  | { ok: false; reason: 'foreign_client' | 'identity_mismatch' }

export function decideCapture(input: {
  tokenClientId: string
  expectedClientId: string
  /** The actor `connected_accounts` maps the validated Twitch user to. */
  boundActor: string | null
  /** The actor the JWT says is calling. */
  actorId: string
}): CaptureDecision {
  if (input.tokenClientId !== input.expectedClientId) {
    return { ok: false, reason: 'foreign_client' }
  }
  // An unknown Twitch identity is a mismatch, not a pass. Absence of a mapping
  // must never be read as permission.
  if (!input.boundActor || input.boundActor !== input.actorId) {
    return { ok: false, reason: 'identity_mismatch' }
  }
  return { ok: true }
}
