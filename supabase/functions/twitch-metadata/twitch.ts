/**
 * Helix, as pure functions.
 *
 * Everything in this file is ordinary TypeScript with no Deno APIs, no
 * `fetch`, no environment and no clock it did not receive - so the project's
 * ordinary vitest suite imports and tests it directly. `index.ts` next door is
 * the thin Deno shell that supplies those things.
 *
 * That split exists because this is the part that can be wrong in ways nobody
 * notices: a missing field, an unvalidated login, an off-by-one in batching.
 * Deno-only code cannot be covered by the checkpoint gate, so there is as
 * little of it as possible.
 *
 * The `ChannelMetadata` shape is imported as a TYPE from the extension's own
 * core module, so there is exactly one definition of it in the repository.
 * Type-only, so it is erased at build time and the deployed function carries
 * no dependency on `src/`.
 */
import type { ChannelMetadata, LiveState } from '../../../src/core/twitchMetadata.ts'

export const HELIX_BATCH_LIMIT = 100
export const TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
export const HELIX_USERS = 'https://api.twitch.tv/helix/users'
export const HELIX_STREAMS = 'https://api.twitch.tv/helix/streams'

/** The most channels one request may ask for. Bounds work and response size. */
export const MAX_LOGINS_PER_REQUEST = 100

const LOGIN_PATTERN = /^[a-z0-9_]{3,25}$/

export function isValidLogin(value: unknown): value is string {
  return typeof value === 'string' && LOGIN_PATTERN.test(value)
}

/**
 * The requested channels, canonicalised, de-duplicated and bounded.
 *
 * This is the SSRF gate. Logins are interpolated into Helix query strings, and
 * they arrive from a browser, so nothing that is not exactly a Twitch login
 * gets past here. There is no path in this function that fetches a
 * caller-supplied URL - the endpoints are the three constants above and
 * nothing else.
 */
export function normalizeLogins(values: unknown, limit = MAX_LOGINS_PER_REQUEST): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const login = value.trim().toLowerCase()
    if (isValidLogin(login)) seen.add(login)
    if (seen.size >= limit) break
  }
  return [...seen]
}

export function chunk<T>(values: readonly T[], size = HELIX_BATCH_LIMIT): T[][] {
  if (size < 1) return [[...values]]
  const out: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size))
  }
  return out
}

/** `?login=a&login=b`. Repeated params, which is how Helix takes a batch. */
export function helixQuery(param: 'login' | 'user_login', logins: readonly string[]): string {
  const query = new URLSearchParams()
  for (const login of logins) query.append(param, login)
  return query.toString()
}

// --------------------------------------------------------------- app token

export interface AppToken {
  accessToken: string
  /** Epoch ms after which this token must not be used. */
  expiresAt: number
}

/**
 * How early to replace a token.
 *
 * Twitch app tokens last weeks, so this is not about churn - it is about never
 * being the request that discovers the token died mid-flight. Five minutes is
 * far longer than any request takes and far shorter than any token lives.
 */
export const TOKEN_MARGIN_MS = 5 * 60_000

export function tokenIsUsable(token: AppToken | null, now: number): token is AppToken {
  return token !== null && token.expiresAt - TOKEN_MARGIN_MS > now
}

/**
 * Read a client-credentials response.
 *
 * App access tokens have no refresh token and no scopes by design; when one
 * expires you ask for another. So there is nothing to persist and nothing to
 * rotate - which is precisely why this flow was chosen over a user token.
 */
export function parseAppToken(payload: unknown, now: number): AppToken | null {
  if (!payload || typeof payload !== 'object') return null
  const raw = payload as Record<string, unknown>
  const accessToken = raw.access_token
  const expiresIn = raw.expires_in

  if (typeof accessToken !== 'string' || accessToken.length < 8) return null
  // A token with no stated lifetime is treated as short-lived rather than
  // trusted forever.
  const lifetimeMs =
    typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
      ? expiresIn * 1_000
      : 60 * 60_000

  return { accessToken, expiresAt: now + lifetimeMs }
}

// ------------------------------------------------------------ helix parsing

interface HelixUser {
  id?: unknown
  login?: unknown
  display_name?: unknown
  profile_image_url?: unknown
}

interface HelixStream {
  user_login?: unknown
  game_name?: unknown
  title?: unknown
  viewer_count?: unknown
  started_at?: unknown
  type?: unknown
}

function list(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object') return []
  const data = (payload as Record<string, unknown>).data
  return Array.isArray(data) ? data : []
}

const str = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

/** login -> identity, from a Get Users response. */
export function parseUsers(payload: unknown): Map<string, HelixUser> {
  const users = new Map<string, HelixUser>()
  for (const entry of list(payload)) {
    const user = entry as HelixUser
    const login = typeof user.login === 'string' ? user.login.toLowerCase() : null
    if (login && isValidLogin(login)) users.set(login, user)
  }
  return users
}

/**
 * login -> live stream, from a Get Streams response.
 *
 * Only `type: "live"` counts. Twitch documents the field as "live" or an empty
 * string when there is an error, and a row we cannot positively read as live
 * must not become a LIVE badge.
 */
export function parseStreams(payload: unknown): Map<string, HelixStream> {
  const streams = new Map<string, HelixStream>()
  for (const entry of list(payload)) {
    const stream = entry as HelixStream
    const login = typeof stream.user_login === 'string' ? stream.user_login.toLowerCase() : null
    if (!login || !isValidLogin(login)) continue
    if (stream.type !== 'live') continue
    streams.set(login, stream)
  }
  return streams
}

/**
 * Fold identity and stream into one record per REQUESTED login.
 *
 * Keyed on what was asked for rather than on what came back, so a channel
 * missing from either batch still produces a record - it just says less. A
 * login Helix does not resolve at all is `unknown`, not `offline`: a channel
 * that does not exist and a channel that is not streaming are different
 * answers, and only one of them is safe to render.
 */
export function buildMetadata(
  logins: readonly string[],
  users: Map<string, HelixUser>,
  streams: Map<string, HelixStream>,
  now: number,
): ChannelMetadata[] {
  return logins.map((login) => {
    const user = users.get(login)
    const stream = streams.get(login)

    // Helix answered for this channel, so "no stream row" is a fact about it.
    // No user row means Helix said nothing we can interpret.
    const live: LiveState = stream ? 'live' : user ? 'offline' : 'unknown'

    const displayName = str(user?.display_name, 64)
    const startedAt = typeof stream?.started_at === 'string' ? Date.parse(stream.started_at) : NaN

    return {
      login,
      userId: typeof user?.id === 'string' && /^\d{1,20}$/.test(user.id) ? user.id : null,
      // Casing only. A "display name" that is a different word is a rename,
      // and identity never comes from display text.
      displayName: displayName && displayName.toLowerCase() === login ? displayName : null,
      profileImageUrl: typeof user?.profile_image_url === 'string' ? user.profile_image_url : null,
      live,
      gameName: live === 'live' ? str(stream?.game_name, 64) : null,
      title: live === 'live' ? str(stream?.title, 140) : null,
      viewerCount:
        live === 'live' &&
        typeof stream?.viewer_count === 'number' &&
        Number.isFinite(stream.viewer_count) &&
        stream.viewer_count >= 0
          ? Math.floor(stream.viewer_count)
          : null,
      startedAt: live === 'live' && Number.isFinite(startedAt) ? startedAt : null,
      fetchedAt: now,
    }
  })
}
