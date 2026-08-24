/**
 * Kickback's Twitch metadata endpoint.
 *
 * POST { "logins": ["lirik", "xqc"] }  ->  { "channels": [ ... ] }
 *
 * WHY THIS EXISTS AT ALL
 *
 * Everything it returns is public, but getting it requires the app's client
 * secret, and a browser extension is not a place a secret can live. So the
 * secret stays here and the extension asks us.
 *
 * WHAT IT IS NOT
 *
 * It is not a Twitch proxy. It takes a list of LOGINS - validated against
 * Twitch's own login grammar - and calls two fixed endpoints. There is no
 * parameter that is a URL, no parameter that is a path, and no way to reach a
 * third Helix endpoint through it. That is deliberate: the useful version of
 * this function and the dangerous version differ only by how much of the
 * request is allowed to become the request.
 *
 * WHO MAY CALL IT
 *
 * Signed-in Kickback users. Supabase verifies the JWT before this code runs
 * (the function is deployed WITHOUT --no-verify-jwt), and the caller's id is
 * read from it rather than from the body, so there is nothing to forge. It is
 * also rate limited per caller.
 *
 * THE APP TOKEN NEVER LEAVES
 *
 * The client-credentials token is held in this isolate's memory and used only
 * to call Helix. It is not returned, not logged, and not stored anywhere a
 * client could read. The extension never sees a Twitch credential of any kind.
 *
 * Deployment, secrets and the cache table: see docs/TWITCH_METADATA.md.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'
import type { ChannelMetadata } from '../../../src/core/twitchMetadata.ts'
import {
  HELIX_BATCH_LIMIT,
  HELIX_STREAMS,
  HELIX_USERS,
  MAX_LOGINS_PER_REQUEST,
  TOKEN_URL,
  buildMetadata,
  chunk,
  helixQuery,
  normalizeLogins,
  parseAppToken,
  parseStreams,
  parseUsers,
  tokenIsUsable,
} from './twitch.ts'
import type { AppToken } from './twitch.ts'

declare const Deno: { env: { get(key: string): string | undefined } }

const CLIENT_ID = Deno.env.get('TWITCH_CLIENT_ID') ?? ''
const CLIENT_SECRET = Deno.env.get('TWITCH_CLIENT_SECRET') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

/** How long a cached row may be served without refetching Twitch. */
const CACHE_TTL_MS = 2 * 60_000
/** Outbound calls that hang must not hold a caller's request open. */
const TWITCH_TIMEOUT_MS = 6_000

/**
 * The app token, for the life of this isolate.
 *
 * Deliberately not persisted. Storing a bearer token in Postgres would add a
 * credential at rest for the sake of avoiding one token request per cold
 * start - and a cold start already costs more than that request does. Twitch
 * app tokens last weeks, so a warm isolate reuses one indefinitely, which is
 * the property that actually matters.
 */
let appToken: AppToken | null = null

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

async function timed(url: string, init: RequestInit): Promise<Response> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TWITCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: abort.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Fetch a client-credentials token, or reuse the one we have. */
async function getAppToken(now: number, force = false): Promise<string | null> {
  if (!force && tokenIsUsable(appToken, now)) return appToken.accessToken
  if (!CLIENT_ID || !CLIENT_SECRET) return null

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'client_credentials',
  })

  const response = await timed(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!response.ok) return null

  const token = parseAppToken(await response.json(), now)
  if (!token) return null
  appToken = token
  return token.accessToken
}

/**
 * One Helix GET, with a single bounded retry on 401.
 *
 * A 401 means the token died early - revoked, or invalidated by a secret
 * rotation. Exactly one forced refresh follows, and if that fails the caller
 * degrades to whatever the cache holds. Retrying further would turn a Twitch
 * outage into a request storm against the token endpoint.
 *
 * 429 and 5xx are NOT retried here. They are transient, the cache already
 * covers them, and the honest answer to "Twitch is rate limiting us" is to ask
 * for less, not to ask again immediately.
 */
async function helix(url: string, now: number): Promise<unknown | null> {
  for (const force of [false, true]) {
    const token = await getAppToken(now, force)
    if (!token) return null

    const response = await timed(url, {
      headers: { 'client-id': CLIENT_ID, authorization: `Bearer ${token}` },
    })

    if (response.status === 401) {
      appToken = null
      continue
    }
    if (!response.ok) return null
    try {
      return await response.json()
    } catch {
      return null
    }
  }
  return null
}

/** Ask Twitch about a set of logins, in Helix-sized batches. */
async function fetchFromTwitch(logins: string[], now: number): Promise<ChannelMetadata[]> {
  const out: ChannelMetadata[] = []

  for (const batch of chunk(logins, HELIX_BATCH_LIMIT)) {
    const [usersPayload, streamsPayload] = await Promise.all([
      helix(`${HELIX_USERS}?${helixQuery('login', batch)}`, now),
      helix(`${HELIX_STREAMS}?${helixQuery('user_login', batch)}`, now),
    ])

    // Neither call landed: say nothing rather than reporting every channel in
    // this batch as offline. `unknown` is the honest answer and the caller
    // renders it as today's plain card.
    if (usersPayload === null && streamsPayload === null) continue

    out.push(...buildMetadata(batch, parseUsers(usersPayload), parseStreams(streamsPayload), now))
  }

  return out
}

// ------------------------------------------------------------------- cache

const admin =
  SUPABASE_URL && SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null

async function readCache(logins: string[], now: number): Promise<Map<string, ChannelMetadata>> {
  const fresh = new Map<string, ChannelMetadata>()
  if (!admin) return fresh

  const { data, error } = await admin
    .from('twitch_metadata_cache')
    .select('login, payload, fetched_at')
    .in('login', logins)
  if (error || !Array.isArray(data)) return fresh

  for (const row of data) {
    const fetchedAt = Date.parse(String(row.fetched_at))
    if (!Number.isFinite(fetchedAt) || now - fetchedAt > CACHE_TTL_MS) continue
    const payload = row.payload as ChannelMetadata | null
    if (payload && typeof payload === 'object') fresh.set(String(row.login), { ...payload, fetchedAt })
  }
  return fresh
}

async function writeCache(records: ChannelMetadata[]): Promise<void> {
  if (!admin || records.length === 0) return
  await admin.from('twitch_metadata_cache').upsert(
    records.map((record) => ({
      login: record.login,
      payload: record,
      fetched_at: new Date(record.fetchedAt).toISOString(),
    })),
    { onConflict: 'login' },
  )
}

// ----------------------------------------------------------------- handler

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const authorization = request.headers.get('authorization') ?? ''
  if (!authorization.toLowerCase().startsWith('bearer ')) {
    return json({ error: 'unauthorized' }, 401)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'bad_request' }, 400)
  }

  const logins = normalizeLogins(
    (body as Record<string, unknown> | null)?.logins,
    MAX_LOGINS_PER_REQUEST,
  )
  if (logins.length === 0) return json({ channels: [] })

  /*
   * Rate limited as the caller, not as the service.
   *
   * The client is built with the caller's own JWT, so consume_rate_budget_n
   * charges auth.uid() - there is no actor id in the request for anyone to
   * put someone else's id into. A caller over budget still gets an answer,
   * from cache only, because the panel degrading is worse than Twitch being
   * asked slightly less often.
   */
  let mayFetch = true
  if (SUPABASE_URL) {
    try {
      const caller = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
        auth: { persistSession: false },
        global: { headers: { authorization } },
      })
      const { data, error } = await caller.rpc('consume_rate_budget_n', {
        p_bucket: 'twitch_metadata',
        p_amount: logins.length,
        p_limit: 600,
        p_window: '00:05:00',
      })
      if (error) return json({ error: 'unauthorized' }, 401)
      mayFetch = data !== false
    } catch {
      mayFetch = false
    }
  }

  const now = Date.now()
  const cached = await readCache(logins, now)
  const missing = logins.filter((login) => !cached.has(login))

  let fetched: ChannelMetadata[] = []
  if (missing.length > 0 && mayFetch) {
    try {
      fetched = await fetchFromTwitch(missing, now)
      await writeCache(fetched)
    } catch {
      // Twitch unreachable. Whatever the cache had still goes back.
      fetched = []
    }
  }

  return json({ channels: [...cached.values(), ...fetched] })
})
