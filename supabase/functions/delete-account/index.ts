/**
 * Watchside account deletion.
 *
 * POST { "confirm": "DELETE" }  ->  { "status": "deleted" }
 *
 * WHO CAN DELETE WHOM
 *
 * Yourself, and nobody else. The actor is read from the verified JWT via
 * `auth.getUser()`, and there is no user id anywhere in the request for
 * somebody to put another person's into. That is the same rule the metadata
 * function established: the id comes from the token, never from the body.
 *
 * THE ORDER IS THE SECURITY PROPERTY
 *
 *   1. destroy the Twitch credential and Twitch-derived observations
 *   2. delete the auth identity, which cascades the whole account graph
 *
 * If the process dies between them, the worst thing to have retained - a live
 * Twitch credential - is already gone, and the account is left in a state that
 * a retry completes. Doing it the other way round would leave the credential
 * orphaned behind a deleted account, unreachable by any later cleanup.
 *
 * WHAT GETS DELETED
 *
 * Everything the user owns. Deleting the `auth.users` row cascades to
 * `public.users` and from there to every table carrying a user foreign key -
 * the social graph, groups, messages, presence, invites, badges, feedback, and
 * their analytics history. That last one is deliberate (owner decision D-A):
 * "delete my account" means the measurement history too.
 *
 * This is NOT what a Twitch deauthorization does. That path removes only the
 * Twitch-derived layer and keeps Watchside's own analytics. The two events are
 * different and collapsing them would be a bug.
 *
 * Deployment: supabase functions deploy delete-account
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'

declare const Deno: { env: { get(key: string): string | undefined } }

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

/** A deliberate act, not a stray POST. The UI asks for it explicitly. */
const CONFIRMATION = 'DELETE'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** Fixed codes only - never an actor id, a login, or anything from a row. */
function note(code: string, extra: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({ at: 'delete-account', code, ...extra }))
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
    note('not_configured')
    return json({ error: 'not_configured' }, 500)
  }

  const authorization = request.headers.get('authorization') ?? ''
  if (!authorization.toLowerCase().startsWith('bearer ')) {
    return json({ error: 'unauthorized' }, 401)
  }

  let body: Record<string, unknown> | null = null
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return json({ error: 'bad_request' }, 400)
  }

  if (body?.confirm !== CONFIRMATION) {
    return json({ error: 'confirmation_required' }, 400)
  }

  /*
   * The actor, from the token.
   *
   * getUser() validates the JWT against the auth server rather than trusting
   * its contents, so a forged or expired token cannot name a victim.
   */
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { authorization } },
  })

  const { data: userData, error: userError } = await caller.auth.getUser()
  const actorId = userData?.user?.id
  if (userError || !actorId) {
    return json({ error: 'unauthorized' }, 401)
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  // 1. The credential first. Idempotent, so a retry after a partial failure is
  //    safe and simply reports zero.
  const { data: purged, error: purgeError } = await admin.rpc('purge_twitch_derived', {
    p_actor: actorId,
  })

  if (purgeError) {
    note('purge_failed')
    return json({ error: 'deletion_incomplete', stage: 'credential' }, 503)
  }

  note('purged', {
    credentials: (purged as Record<string, unknown> | null)?.credentials ?? 0,
    observations: (purged as Record<string, unknown> | null)?.observations ?? 0,
  })

  // 2. The auth identity. This cascades public.users and every table that
  //    references it.
  const { error: deleteError } = await admin.auth.admin.deleteUser(actorId)

  if (deleteError) {
    /*
     * Reported as INCOMPLETE, never as success.
     *
     * The credential is gone, so the dangerous part is done, but the account
     * still exists and the user must be told the truth so they can retry.
     */
    note('auth_delete_failed')
    return json({ error: 'deletion_incomplete', stage: 'account' }, 503)
  }

  note('deleted')
  return json({ status: 'deleted' }, 200)
})
