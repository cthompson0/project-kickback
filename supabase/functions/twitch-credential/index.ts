/**
 * Watchside's Twitch credential custody.
 *
 * POST { action: "capture", access_token, refresh_token }  -> { status }
 * POST { action: "status" }                                -> safe shape only
 * POST { action: "ensure_fresh" }                          -> { state }
 *
 * WHAT THIS IS FOR
 *
 * Supabase hands back Twitch's own OAuth credentials once, at sign-in, and
 * never again - they do not survive its first session refresh. Measuring
 * whether Watchside causes creator discovery needs a Twitch call at an
 * arbitrary later moment, so the credential has to be captured deliberately at
 * sign-in and held server-side. That is custody, and it was approved knowing
 * exactly what it costs.
 *
 * WHAT IT NEVER DOES
 *
 * It never returns a Twitch token to anyone. Not to the extension, not to the
 * user it belongs to, not in an error, not in a log. `status` and
 * `ensure_fresh` return shapes and states; the tokens stay below this line.
 *
 * IDENTITY BINDING
 *
 * A credential arriving from actor A is not assumed to be A's. Twitch is asked
 * whose token it is, and the answer must match the Twitch identity already
 * connected to A. Otherwise anybody could park their own Twitch credential
 * under somebody else's Watchside account - or somebody else's under theirs.
 *
 * PHASE 2 SCOPE
 *
 * No follow or subscription scope is requested, and nothing here reads a
 * relationship. This proves custody works; M3D consumes it later.
 *
 * Deployment:
 *   supabase functions deploy twitch-credential
 *   supabase secrets set TWITCH_CREDENTIAL_KEY_V1=<32 random bytes, base64>
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { CredentialCryptoError, currentKeyVersion, keyRingFrom, open, seal } from './crypto.ts'
import type { KeyRing } from './crypto.ts'
import { decideCapture, expiryFrom, isSpent, refreshTokens, validateToken } from './twitch.ts'

declare const Deno: { env: { get(key: string): string | undefined } }

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const CLIENT_ID = Deno.env.get('TWITCH_CLIENT_ID') ?? ''
const CLIENT_SECRET = Deno.env.get('TWITCH_CLIENT_SECRET') ?? ''

const KEYS: KeyRing = keyRingFrom((name) => Deno.env.get(name))
/** Owner-only, for operational inspection. Never the extension's. */
const ADMIN_TOKEN = Deno.env.get('TWITCH_EVENTSUB_ADMIN_TOKEN') ?? ''

/**
 * The project's public signing keys, fetched once per isolate.
 *
 * getClaims() can fetch these itself, and on this project that fetch returns an
 * HTML error page instead of JSON - which surfaces as "unauthorized" for a
 * perfectly valid caller and took four attempts to see. A plain fetch of the
 * same URL from the same runtime returns JSON reliably, so the keys are
 * fetched here and handed in. The library still does the verification; only
 * its key retrieval is bypassed.
 */
let cachedJwks: { keys: unknown[] } | null = null

async function signingKeys(): Promise<{ keys: unknown[] }> {
  if (cachedJwks) return cachedJwks
  const response = await fetch(SUPABASE_URL + '/auth/v1/.well-known/jwks.json', {
    headers: { apikey: ANON_KEY },
  })
  if (!response.ok) throw new Error('jwks_unavailable')
  const body = (await response.json()) as { keys?: unknown[] }
  if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error('jwks_unavailable')
  cachedJwks = { keys: body.keys }
  return cachedJwks
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** Fixed codes. Never a token, never a header, never a row. */
function note(code: string, extra: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({ at: 'twitch-credential', code, ...extra }))
}

// PostgREST renders bytea as a `\x…` hex string and accepts the same on the
// way in, so the envelope crosses that boundary as hex rather than as bytes.
function bytesToHex(bytes: Uint8Array): string {
  let out = '\\x'
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

function hexToBytes(value: string): Uint8Array {
  const hex = value.startsWith('\\x') ? value.slice(2) : value
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  return bytes
}

interface CredentialRow {
  actor_id: string
  secret: string
  key_version: number
  scopes: string[]
  status: string
  version: number
  access_expires_at: string | null
}

async function readCredential(
  admin: SupabaseClient,
  actorId: string,
): Promise<CredentialRow | null> {
  const { data, error } = await admin
    .from('twitch_credentials')
    .select('actor_id, secret, key_version, scopes, status, version, access_expires_at')
    .eq('actor_id', actorId)
    .maybeSingle()
  if (error) throw new Error('db_unavailable')
  return (data as CredentialRow | null) ?? null
}

/**
 * Refreshes if the access token is spent, and serialises without a lock.
 *
 * The approved architecture proposed a transaction-scoped advisory lock held
 * across the Twitch call. That is not reachable from here: PostgREST runs each
 * statement on a pooled connection, so a lock taken in one request is not held
 * for the next call in the same logical operation.
 *
 * The smallest equivalent that genuinely serialises is a CLAIM. Bumping the
 * version with a compare-and-swap is atomic, so exactly one caller wins the
 * right to talk to Twitch; everyone else sees the claim and stands down rather
 * than starting a second rotation. The final write is conditioned on the
 * claimed version, so a stale generation can never overwrite a newer one.
 */
async function ensureFresh(
  admin: SupabaseClient,
  actorId: string,
  now: number,
): Promise<{ state: string; reason?: string }> {
  const row = await readCredential(admin, actorId)
  if (!row) return { state: 'unavailable', reason: 'no_credential' }
  if (row.status !== 'active') return { state: 'unavailable', reason: row.status }

  if (!isSpent(row.access_expires_at, now)) return { state: 'fresh' }

  // Claim the refresh. One winner.
  const claimed = row.version + 1
  const { data: claim, error: claimError } = await admin
    .from('twitch_credentials')
    .update({ version: claimed, updated_at: new Date(now).toISOString() })
    .eq('actor_id', actorId)
    .eq('version', row.version)
    .select('version')
  if (claimError) throw new Error('db_unavailable')
  if (!claim || claim.length === 0) {
    // Somebody else is already refreshing this actor. Standing down is correct:
    // a second rotation from the same parent token is exactly what must not
    // happen.
    note('refresh_claim_lost')
    return { state: 'refreshing' }
  }

  let secret
  try {
    secret = await open(hexToBytes(row.secret), actorId, KEYS)
  } catch (error) {
    const code = error instanceof CredentialCryptoError ? error.code : 'decrypt_failed'
    note('decrypt_failed', { reason: code })
    return { state: 'unavailable', reason: code }
  }

  const refreshed = await refreshTokens(secret.refreshToken, CLIENT_ID, CLIENT_SECRET)
  if (!refreshed.ok) {
    if (refreshed.reason === 'invalid_grant') {
      /*
       * The user changed their password or disconnected the app. The stored
       * credential is dead; say so rather than retrying it forever. The row is
       * kept, marked, so the account surface can offer re-authorisation - it
       * carries no usable secret once this happens because the next capture
       * replaces it.
       */
      await admin
        .from('twitch_credentials')
        .update({ status: 'needs_reauthorization', updated_at: new Date(now).toISOString() })
        .eq('actor_id', actorId)
      note('refresh_rejected')
      return { state: 'unavailable', reason: 'needs_reauthorization' }
    }
    note('refresh_failed', { reason: refreshed.reason })
    return { state: 'unavailable', reason: refreshed.reason }
  }

  const keyVersion = currentKeyVersion(KEYS)
  const envelope = await seal(
    { accessToken: refreshed.tokens.accessToken, refreshToken: refreshed.tokens.refreshToken },
    actorId,
    KEYS,
    keyVersion,
  )

  const { error: writeError } = await admin
    .from('twitch_credentials')
    .update({
      secret: bytesToHex(envelope),
      key_version: keyVersion,
      scopes: refreshed.tokens.scopes,
      access_expires_at: expiryFrom(refreshed.tokens.expiresIn, now),
      updated_at: new Date(now).toISOString(),
    })
    .eq('actor_id', actorId)
    .eq('version', claimed)

  if (writeError) {
    /*
     * Twitch rotated and we could not store the replacement.
     *
     * The old refresh token may or may not still work - Twitch does not say.
     * Marking the row is the one write that must land, so the next use stops
     * rather than looping on a token we know is at best doubtful.
     */
    await admin
      .from('twitch_credentials')
      .update({ status: 'needs_reauthorization' })
      .eq('actor_id', actorId)
    note('rotation_write_failed')
    return { state: 'unavailable', reason: 'rotation_lost' }
  }

  note('refreshed', { key_version: keyVersion })
  return { state: 'refreshed' }
}

/**
 * What is actually sitting in the row, described rather than revealed.
 *
 * Operational, and owner-only. It exists because "the column holds ciphertext"
 * is the single claim this whole design rests on, and a claim that can only be
 * checked by reasoning about code is weaker than one that can be checked
 * against the database. It returns a length, a format byte and a key version -
 * never a byte of the envelope, and certainly never a token.
 */
async function credentialShape(admin: SupabaseClient): Promise<Record<string, unknown>> {
  const { data, error } = await admin
    .from('twitch_credentials')
    .select('actor_id, secret, key_version, status, scopes, access_expires_at, version')
  if (error) return { error: 'db_unavailable' }

  const rows = (data ?? []) as { secret: string; key_version: number; status: string; scopes: string[] }[]
  return {
    rows: rows.length,
    shapes: rows.map((row) => {
      const hex = row.secret.startsWith('\\x') ? row.secret.slice(2) : row.secret
      const bytes = hex.length / 2
      const formatByte = parseInt(hex.slice(0, 2), 16)
      // Is there any long printable ASCII run? A stored plaintext token would
      // show one; AES-GCM output effectively never does.
      let longestPrintable = 0
      let run = 0
      for (let i = 0; i < hex.length; i += 2) {
        const byte = parseInt(hex.substr(i, 2), 16)
        run = byte >= 0x20 && byte <= 0x7e ? run + 1 : 0
        if (run > longestPrintable) longestPrintable = run
      }
      return {
        bytes,
        format_version: formatByte,
        key_version: row.key_version,
        status: row.status,
        scope_count: row.scopes?.length ?? 0,
        longest_printable_run: longestPrintable,
      }
    }),
  }
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY || !CLIENT_ID || !CLIENT_SECRET) {
    note('not_configured')
    return json({ error: 'not_configured' }, 500)
  }
  if (Object.keys(KEYS).length === 0) {
    // Fail closed. No key means no custody - never a plaintext fallback.
    note('key_unavailable')
    return json({ error: 'not_configured' }, 500)
  }

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return json({ error: 'bad_request' }, 400)
  }

  // Owner-only inspection, in its own header, checked before anything else.
  const presentedAdmin = request.headers.get('x-watchside-admin') ?? ''
  if (ADMIN_TOKEN && presentedAdmin && presentedAdmin === ADMIN_TOKEN) {
    if (body.action === 'credential_shape') {
      const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
      return json(await credentialShape(admin))
    }
    return json({ error: 'bad_request' }, 400)
  }

  const authorization = request.headers.get('authorization') ?? ''
  if (!authorization.toLowerCase().startsWith('bearer ')) {
    return json({ error: 'unauthorized' }, 401)
  }

  // The actor comes from the token. There is no id in the body, for any action.
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { authorization } },
  })
  // The JWT is passed EXPLICITLY.
  //
  // getUser() with no argument reads the client's own session, and a function
  // has none - the global Authorization header is not used for this call. Bare
  // getUser() therefore returns "unauthorized" for a perfectly valid caller,
  // which is exactly what it did the first time this ran against production.
  /*
   * The actor, established by VERIFYING the token rather than asking about it.
   *
   * getClaims() checks the JWT's signature locally against the project's
   * asymmetric signing keys. Supabase's own guidance is to prefer it: "Always
   * verify the JWT using getClaims() ... to securely establish the user's
   * identity and access."
   *
   * getUser() was tried first and is the wrong tool here. It makes a network
   * call to the auth server, and on this project that call came back HTML
   * rather than JSON - so a perfectly valid caller was rejected with
   * "unauthorized" for a reason that had nothing to do with their token. Local
   * verification has no such failure mode, and is strictly stronger: it proves
   * the signature instead of trusting a lookup.
   */
  const presentedJwt = authorization.slice('Bearer '.length)
  const { data: claimsData, error: userError } = await caller.auth.getClaims(presentedJwt, {
    jwks: await signingKeys(),
  } as unknown as undefined)
  const actorId = claimsData?.claims?.sub
  if (userError || !actorId) {
    /*
     * Shape only, never the token.
     *
     * WHICH credential actually arrived is the whole question when this returns
     * 401, and guessing at it from outside costs a real sign-in every time. A
     * length, a three-character prefix and a segment count separate a user JWT
     * from a publishable key without revealing either.
     */
    note('unauthorized')
    return json({ error: 'unauthorized' }, 401)
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })
  const now = Date.now()

  try {
    if (body.action === 'status') {
      const row = await readCredential(admin, actorId)
      // Shape only. Never the secret, never its bytes.
      return json({
        has_credential: row !== null,
        status: row?.status ?? null,
        key_version: row?.key_version ?? null,
        scope_count: row?.scopes?.length ?? 0,
        access_expires_at: row?.access_expires_at ?? null,
        version: row?.version ?? null,
      })
    }

    if (body.action === 'ensure_fresh') {
      return json(await ensureFresh(admin, actorId, now))
    }

    if (body.action !== 'capture') return json({ error: 'bad_request' }, 400)

    const accessToken = body.access_token
    const refreshToken = body.refresh_token
    if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
      return json({ error: 'bad_request' }, 400)
    }
    if (accessToken.length === 0 || refreshToken.length === 0) {
      return json({ error: 'bad_request' }, 400)
    }

    /*
     * Ask Twitch whose token this is.
     *
     * The client says it is theirs; that is not evidence. Validation also
     * supplies the real expiry, so nothing here has to assume a lifetime.
     */
    const validated = await validateToken(accessToken)
    if (!validated.ok) {
      note('validation_failed', { reason: validated.reason })
      return json({ error: 'invalid_credential', reason: validated.reason }, 400)
    }

    // THE BINDING. Twitch says whose token this is; that answer must match the
    // Twitch identity already connected to this Watchside actor.
    const { data: boundActor, error: bindError } = await admin.rpc('actor_for_twitch_user', {
      p_twitch_user_id: validated.token.userId,
    })
    if (bindError) throw new Error('db_unavailable')

    const decision = decideCapture({
      tokenClientId: validated.token.clientId,
      expectedClientId: CLIENT_ID,
      boundActor: (boundActor as string | null) ?? null,
      actorId,
    })
    if (!decision.ok) {
      note('capture_refused', { reason: decision.reason })
      return json(
        { error: 'invalid_credential', reason: decision.reason },
        decision.reason === 'identity_mismatch' ? 403 : 400,
      )
    }

    const keyVersion = currentKeyVersion(KEYS)
    const envelope = await seal(
      { accessToken, refreshToken },
      actorId,
      KEYS,
      keyVersion,
    )

    /*
     * Upsert on the primary key, so a second capture replaces rather than
     * duplicates. Re-signing in is an ordinary thing to do and must not
     * accumulate credentials.
     */
    const { error: writeError } = await admin.from('twitch_credentials').upsert(
      {
        actor_id: actorId,
        secret: bytesToHex(envelope),
        key_version: keyVersion,
        scopes: validated.token.scopes,
        status: 'active',
        access_expires_at: expiryFrom(validated.token.expiresIn, now),
        updated_at: new Date(now).toISOString(),
      },
      { onConflict: 'actor_id' },
    )
    if (writeError) throw new Error('db_unavailable')

    note('captured', { key_version: keyVersion, scope_count: validated.token.scopes.length })
    return json({ status: 'stored' })
  } catch (error) {
    // Nothing derived from a credential ever reaches this message.
    const code = error instanceof Error ? error.message : 'error'
    note('failed', { reason: code === 'db_unavailable' ? code : 'internal' })
    return json({ error: 'unavailable' }, 503)
  }
})
