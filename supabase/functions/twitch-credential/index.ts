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
import {
  broadcasterIdFor,
  decideCapture,
  expiryFrom,
  followsBroadcaster,
  isSpent,
  FOLLOWS_SCOPE,
  readinessFor,
  refreshTokens,
  validateToken,
} from './twitch.ts'
import { normalizeLogin, toClientResponse, validateAttribution } from './relationship.ts'
import type { RelationshipReason, RelationshipResult } from './relationship.ts'

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
 *
 * WHY IT ALSO ANSWERS SCOPE AND READINESS
 *
 * Slice C's acceptance question is "does the stored credential actually carry
 * user:read:follows", and a scope COUNT cannot answer it - two scopes could be
 * any two. So this reports the three scope facts that matter as booleans, and
 * the readiness the server would compute from them. A boolean about a scope is
 * not a credential: it says what Watchside is permitted to read, which is
 * exactly what the user was asked and exactly what a privacy claim must be
 * checkable against.
 *
 * The observation counts are here for the same reason. "Zero observations
 * exist" is a claim about production, and reading it from production is the
 * only honest way to make it.
 */
async function credentialShape(admin: SupabaseClient): Promise<Record<string, unknown>> {
  const { data, error } = await admin
    .from('twitch_credentials')
    .select('actor_id, secret, key_version, status, scopes, access_expires_at, version, created_at, updated_at')
  if (error) return { error: 'db_unavailable' }

  /*
   * Counted, never read.
   *
   * `head: true` asks PostgREST for the count and no rows, so this cannot
   * return anybody's follow state even by accident - which matters, because
   * that column is the one thing the whole boundary exists to keep server-side.
   */
  const { count: observations, error: observationsError } = await admin
    .from('creator_relationship_observations')
    .select('*', { count: 'exact', head: true })

  const rows = (data ?? []) as {
    actor_id: string
    secret: string
    key_version: number
    status: string
    scopes: string[]
    access_expires_at: string | null
    created_at: string
    updated_at: string
  }[]

  const { data: connectedRows } = await admin
    .from('connected_accounts')
    .select('user_id')
    .eq('platform', 'twitch')
  const connectedActors = new Set(
    ((connectedRows ?? []) as { user_id: string }[]).map((row) => row.user_id),
  )
  return {
    rows: rows.length,
    observations: observationsError ? 'unavailable' : (observations ?? 0),
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
      const scopes = row.scopes ?? []
      return {
        bytes,
        format_version: formatByte,
        key_version: row.key_version,
        status: row.status,
        scope_count: scopes.length,
        /*
         * The scope facts, as facts. A count cannot distinguish "email plus
         * follows" from "email plus something nobody agreed to".
         *
         * The second number is an ALLOWLIST rather than a list of scopes to be
         * suspicious of. Naming a forbidden scope here in order to check for
         * its absence would put that string in the source, where a test rightly
         * refuses to see it - and it would only ever catch the scopes somebody
         * thought to name. Counting everything outside the two Watchside asks
         * for catches any scope at all, including ones that do not exist yet.
         */
        has_follows_scope: scopes.includes(FOLLOWS_SCOPE),
        unexpected_scopes: scopes.filter(
          (scope) => scope !== FOLLOWS_SCOPE && scope !== 'user:read:email',
        ).length,
        // What the server would tell this actor's client, computed the same way
        // `status` computes it - so acceptance reads the real value rather than
        // a second implementation of it.
        readiness: readinessFor({ hasCredential: true, status: row.status, scopes }),
        // Upgraded in place, or replaced? A `created_at` that predates this
        // slice with a fresh `updated_at` is the same credential row for the
        // same actor, carrying more scope than it used to.
        created_at: row.created_at,
        updated_at: row.updated_at,
        /*
         * The viewer's Twitch id, as the follow lookup needs it.
         *
         * `connected_accounts` is read at exactly one place in this function -
         * step 5 of the relationship action - and nowhere else, so a credential
         * can be captured, refreshed and reported `ready` while this is absent.
         * A holder of a perfectly good credential would then be refused at the
         * last step before Twitch is asked, with nothing to show for it.
         */
        twitch_account_connected: connectedActors.has(row.actor_id),
        longest_printable_run: longestPrintable,
      }
    }),
  }
}

/**
 * Whether the first production baselines are what they claim to be, described
 * without being revealed.
 *
 * Owner-only, and built for one job: proving Slice D's acceptance against
 * production rather than against a reading of the code. Every field is a count,
 * a boolean or a timestamp.
 *
 * THE FIELD THAT IS NOT HERE
 *
 * `relationship_present`. Its VALUE is the one thing this whole boundary exists
 * to keep server-side, and an owner-only diagnostic is not an exception - a
 * value printed into a terminal, a report or a transcript has left the server.
 * What acceptance actually needs is whether a real answer was recorded, so this
 * returns `answered`: true when the column is non-null. That distinguishes "we
 * asked Twitch and got an answer" from "we wrote a row without one", which is
 * the failure that would matter, and it says nothing about which answer it was.
 *
 * The joins are checked HERE rather than trusted: an observation is matched back
 * to a `join_clicked` owned by the same actor, and the destination recorded on
 * that JOIN is compared to the creator the observation names.
 */
async function observationShape(admin: SupabaseClient): Promise<Record<string, unknown>> {
  const { data, error } = await admin
    .from('creator_relationship_observations')
    .select('actor_id, broadcaster_login, attribution_id, observed_at, relationship_present, relationship_type')
    .order('observed_at', { ascending: false })
    .limit(25)
  if (error) return { error: 'db_unavailable' }

  const rows = (data ?? []) as {
    actor_id: string
    broadcaster_login: string
    attribution_id: string | null
    observed_at: string
    relationship_present: boolean | null
    relationship_type: string
  }[]

  const shapes = []
  for (const row of rows) {
    /*
     * The JOIN behind it, read back the same way the writer had to.
     *
     * `join_context_for_attribution` is scoped to the actor in its own WHERE
     * clause, so an observation whose attribution belongs to somebody else
     * finds nothing here - which is exactly the forgery the binding prevents,
     * checked from the other end.
     */
    const { data: context } = await admin.rpc('join_context_for_attribution', {
      p_actor: row.actor_id,
      p_attribution: row.attribution_id,
    })
    const join = Array.isArray(context) ? context[0] : null

    const { count: siblings } = await admin
      .from('creator_relationship_observations')
      .select('*', { count: 'exact', head: true })
      .eq('actor_id', row.actor_id)
      .eq('attribution_id', row.attribution_id)

    shapes.push({
      // Whether a real Twitch answer was recorded. NEVER which answer.
      answered: row.relationship_present !== null,
      relationship_type: row.relationship_type,
      has_attribution: row.attribution_id !== null,
      // The JOIN exists, is this actor's, and was aimed at this creator.
      join_found: Boolean(join),
      destination_matches: join?.destination_channel === row.broadcaster_login,
      socially_initiated: (join?.social_count ?? 0) > 0,
      observations_for_this_attribution: siblings ?? 0,
      join_occurred_at: join?.occurred_at ?? null,
      observed_at: row.observed_at,
      // How long after the click the baseline was taken. The whole meaning of
      // the column "at join" rests on this being small.
      baseline_lag_ms: join?.occurred_at
        ? Date.parse(row.observed_at) - Date.parse(join.occurred_at)
        : null,
    })
  }

  /*
   * The JOINs themselves, so "no observation" can be told apart from "no JOIN".
   *
   * Without this, an empty observation table has at least four explanations -
   * the click never reached the server, it was not socially initiated, the
   * trigger declined, or the server refused - and they are indistinguishable
   * from outside. Each of these fields answers exactly one of them.
   *
   * Shape only: whether things are present, a count of people, a source name,
   * and timestamps. No channel, no ids, no properties.
   */
  const { data: joins } = await admin
    .from('analytics_events')
    .select('actor_id, occurred_at, destination_channel, attribution_id, source, properties')
    .eq('event_name', 'join_clicked')
    .order('occurred_at', { ascending: false })
    .limit(15)

  const { data: credRows } = await admin.from('twitch_credentials').select('actor_id')
  const credentialActors = new Set(((credRows ?? []) as { actor_id: string }[]).map((r) => r.actor_id))

  const recentJoins = []
  for (const join of (joins ?? []) as {
    actor_id: string
    occurred_at: string
    destination_channel: string | null
    attribution_id: string | null
    source: string | null
    properties: Record<string, unknown> | null
  }[]) {
    const socialCount = Number(join.properties?.social_count ?? 0)
    const { count: observed } = join.attribution_id
      ? await admin
          .from('creator_relationship_observations')
          .select('*', { count: 'exact', head: true })
          .eq('actor_id', join.actor_id)
          .eq('attribution_id', join.attribution_id)
      : { count: 0 }

    recentJoins.push({
      occurred_at: join.occurred_at,
      source: join.source,
      has_destination: join.destination_channel !== null,
      has_attribution: join.attribution_id !== null,
      social_count: Number.isFinite(socialCount) ? socialCount : 0,
      // Which account clicked. Not WHO - only whether that account is one
      // Watchside holds a Twitch credential for, which is the difference
      // between 'measurable' and 'nothing could ever have been recorded'.
      actor_has_credential: credentialActors.has(join.actor_id),
      // What the eligibility gate would have decided from the stored event.
      eligible: join.attribution_id !== null && join.destination_channel !== null && socialCount > 0,
      observations: observed ?? 0,
    })
  }

  return { rows: rows.length, shapes, recent_joins: recentJoins }
}

/**
 * Walks the relationship path read-only, and reports WHERE it stops.
 *
 * Owner-only. It exists because "no observation" is the same outcome for eight
 * different reasons, and the codes that distinguish them go to a log this
 * tooling cannot read. Rather than spend another of the owner's real JOINs
 * guessing, this runs the same steps against the same credential and names the
 * step that failed.
 *
 * WHAT IT WILL NOT SAY
 *
 * Whether the viewer follows the creator. It performs the real lookup, because
 * a probe that skipped the last step could not tell a working path from a
 * broken one - but it returns only whether the call SUCCEEDED. The answer stays
 * where every other part of this design keeps it.
 *
 * It writes nothing. No observation, no row, no state.
 */
async function relationshipProbe(admin: SupabaseClient, now: number): Promise<Record<string, unknown>> {
  const { data: creds } = await admin.from('twitch_credentials').select('actor_id').limit(1)
  const actorId = ((creds ?? []) as { actor_id: string }[])[0]?.actor_id
  if (!actorId) return { step: 'no_credential' }

  const { data: joins } = await admin
    .from('analytics_events')
    .select('destination_channel, attribution_id, occurred_at, properties')
    .eq('actor_id', actorId)
    .eq('event_name', 'join_clicked')
    .order('occurred_at', { ascending: false })
    .limit(1)
  const join = ((joins ?? []) as {
    destination_channel: string | null
    attribution_id: string | null
    occurred_at: string
    properties: Record<string, unknown> | null
  }[])[0]
  if (!join?.destination_channel) return { step: 'no_join' }

  const fresh = await ensureFresh(admin, actorId, now)
  if (fresh.state !== 'fresh' && fresh.state !== 'refreshed') {
    return { step: 'ensure_fresh', state: fresh.state, reason: fresh.reason ?? null }
  }

  const current = await readCredential(admin, actorId)
  if (!current) return { step: 'read_credential' }

  let secret
  try {
    secret = await open(hexToBytes(current.secret), actorId, KEYS)
  } catch {
    return { step: 'decrypt' }
  }

  const { data: connected } = await admin
    .from('connected_accounts')
    .select('platform_user_id')
    .eq('user_id', actorId)
    .eq('platform', 'twitch')
    .maybeSingle()
  const viewer = (connected as { platform_user_id?: string } | null)?.platform_user_id
  if (!viewer) return { step: 'viewer_identity' }

  const broadcaster = await broadcasterIdFor(join.destination_channel, secret.accessToken, CLIENT_ID)
  if (!broadcaster.ok) return { step: 'broadcaster_lookup', reason: broadcaster.reason }

  const follow = await followsBroadcaster(viewer, broadcaster.id, secret.accessToken, CLIENT_ID)
  // `ok` only. Never `follow.following`.
  if (!follow.ok) return { step: 'follow_lookup', reason: follow.reason }

  // The attribution rules, evaluated separately so a stale JOIN is reported as
  // what it is rather than mistaken for a broken Twitch path.
  const check = validateAttribution({
    join: {
      actorId,
      destinationChannel: join.destination_channel,
      occurredAt: join.occurred_at,
      socialCount: Number(join.properties?.social_count ?? 0),
    },
    broadcasterLogin: join.destination_channel,
    now,
  })

  return {
    step: 'ok',
    twitch_path_works: true,
    attribution_would_pass_now: check.ok,
    attribution_reason: check.ok ? null : check.reason,
    join_age_ms: now - Date.parse(join.occurred_at),
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Records whether this actor already followed this creator, at this JOIN.
 *
 * The whole point of the boundary: the caller learns that a baseline exists, or
 * that one does not and why. It never learns the answer. Every return goes
 * through toClientResponse(), so "did the follow result escape" is one place to
 * check rather than a property of nine separate branches.
 *
 * Nothing is written unless Twitch actually answered. A timeout, an outage, a
 * missing permission and an expired credential all end the same way - no
 * observation - because an absent baseline is honest and a fabricated one is
 * not.
 */
async function recordRelationship(
  admin: SupabaseClient,
  actorId: string,
  broadcasterLogin: string,
  attributionId: string,
  now: number,
): Promise<RelationshipResult> {
  const unavailable = (reason: RelationshipReason): RelationshipResult => ({
    state: 'unavailable',
    reason,
  })

  // 1. Can this actor measure at all?
  const credential = await readCredential(admin, actorId)
  const readiness = readinessFor({
    hasCredential: credential !== null,
    status: credential?.status ?? '',
    scopes: credential?.scopes ?? [],
  })
  if (readiness !== 'ready') {
    note('relationship_not_ready', { readiness })
    return unavailable(readiness as RelationshipReason)
  }

  // 2. Is this attribution really this actor's, aimed at this creator, now?
  const { data: contextRows, error: contextError } = await admin.rpc(
    'join_context_for_attribution',
    { p_actor: actorId, p_attribution: attributionId },
  )
  if (contextError) throw new Error('db_unavailable')

  const first = (contextRows as
    | { destination_channel: string | null; occurred_at: string; social_count: number }[]
    | null)?.[0]

  const check = validateAttribution({
    join: first
      ? {
          actorId,
          destinationChannel: first.destination_channel,
          occurredAt: first.occurred_at,
          socialCount: Number(first.social_count ?? 0),
        }
      : null,
    broadcasterLogin,
    now,
  })
  if (!check.ok) {
    note('relationship_refused', { reason: check.reason })
    return unavailable(check.reason)
  }

  /*
   * 3. Already answered?
   *
   * Checked before Twitch is asked, so a retry costs no API call and - more
   * importantly - cannot produce a second answer to a question already
   * answered. The unique index is the real guarantee; this is the cheap path.
   */
  const { data: existing, error: existingError } = await admin
    .from('creator_relationship_observations')
    .select('id')
    .eq('actor_id', actorId)
    .eq('attribution_id', attributionId)
    .maybeSingle()
  if (existingError) throw new Error('db_unavailable')
  if (existing) {
    note('relationship_already_recorded')
    return { state: 'recorded' }
  }

  // 4. A usable access token, through the existing subsystem. No second
  //    refresher exists anywhere.
  const fresh = await ensureFresh(admin, actorId, now)
  if (fresh.state !== 'fresh' && fresh.state !== 'refreshed') {
    note('relationship_credential_unavailable', { state: fresh.state })
    return unavailable(
      fresh.reason === 'needs_reauthorization' ? 'needs_reauthorization' : 'temporarily_unavailable',
    )
  }

  const current = await readCredential(admin, actorId)
  if (!current) return unavailable('needs_reauthorization')

  let secret
  try {
    secret = await open(hexToBytes(current.secret), actorId, KEYS)
  } catch {
    note('relationship_decrypt_failed')
    return unavailable('temporarily_unavailable')
  }

  // 5. Who is the viewer, in Twitch's terms?
  const { data: connected, error: viewerError } = await admin
    .from('connected_accounts')
    .select('platform_user_id')
    .eq('user_id', actorId)
    .eq('platform', 'twitch')
    .maybeSingle()
  if (viewerError) throw new Error('db_unavailable')
  const viewer = (connected as { platform_user_id?: string } | null)?.platform_user_id
  if (!viewer) return unavailable('needs_reauthorization')

  // 6. The creator's id. The follow endpoint takes an id, not a login.
  const broadcaster = await broadcasterIdFor(broadcasterLogin, secret.accessToken, CLIENT_ID)
  if (!broadcaster.ok) {
    note('relationship_broadcaster_unresolved', { reason: broadcaster.reason })
    return unavailable(
      broadcaster.reason === 'unknown_broadcaster' ? 'unknown_broadcaster' : 'twitch_unavailable',
    )
  }

  // 7. The one question, about the one creator.
  const follow = await followsBroadcaster(viewer, broadcaster.id, secret.accessToken, CLIENT_ID)
  if (!follow.ok) {
    if (follow.reason === 'scope_missing') {
      note('relationship_scope_missing')
      return unavailable('needs_follow_permission')
    }
    note('relationship_lookup_failed', { reason: follow.reason })
    return unavailable('twitch_unavailable')
  }

  /*
   * 8. Write it.
   *
   * Only reached when Twitch actually answered, so relationship_present is
   * always a real observation and never a stand-in for silence. A concurrent
   * duplicate loses to the unique index, which is treated as success because
   * the baseline it wanted does exist.
   */
  const { error: writeError } = await admin.from('creator_relationship_observations').insert({
    actor_id: actorId,
    broadcaster_login: broadcasterLogin,
    attribution_id: attributionId,
    relationship_type: 'follow',
    relationship_present: follow.following,
    observed_at: new Date(now).toISOString(),
  })

  if (writeError) {
    if ((writeError as { code?: string }).code === '23505') {
      note('relationship_already_recorded')
      return { state: 'recorded' }
    }
    throw new Error('db_unavailable')
  }

  // A count, never the answer.
  note('relationship_recorded')
  return { state: 'recorded' }
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
    if (
      body.action === 'credential_shape' ||
      body.action === 'observation_shape' ||
      body.action === 'relationship_probe'
    ) {
      const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
      if (body.action === 'credential_shape') return json(await credentialShape(admin))
      if (body.action === 'observation_shape') return json(await observationShape(admin))
      return json(await relationshipProbe(admin, Date.now()))
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
        /*
         * The authoritative answer to "can this actor be measured".
         *
         * It is computed from the stored scope set, not from anything the
         * client believes. An OAuth redirect coming back successfully is not
         * evidence that the permission was granted - Twitch will happily
         * complete a flow with fewer scopes than asked for - so the only
         * trustworthy source is what the credential actually carries.
         */
        readiness: readinessFor({
          hasCredential: row !== null,
          status: row?.status ?? '',
          scopes: row?.scopes ?? [],
        }),
      })
    }

    if (body.action === 'relationship') {
      const login = normalizeLogin(body.broadcaster_login)
      const attributionId = typeof body.attribution_id === 'string' ? body.attribution_id : ''
      // A malformed request is refused as "unknown attribution" rather than
      // echoed back: reasons here describe Watchside's state, not the input.
      if (!login || !UUID.test(attributionId)) {
        return json(toClientResponse({ state: 'unavailable', reason: 'unknown_attribution' }))
      }
      return json(
        toClientResponse(await recordRelationship(admin, actorId, login, attributionId, now)),
      )
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
