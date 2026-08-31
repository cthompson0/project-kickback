/**
 * Watchside's Twitch EventSub receiver.
 *
 * One job: when somebody disconnects Watchside on Twitch, destroy the Twitch
 * credential and the Twitch-derived observations Watchside holds for them.
 *
 * WHAT AUTHENTICATES A CALLER HERE
 *
 * Not a Supabase JWT - Twitch does not have one. This function is deployed
 * WITH --no-verify-jwt, and the HMAC signature over the raw body IS the
 * authentication. Nothing in a request is believed until that check passes, so
 * an unsigned or tampered request cannot delete anything.
 *
 * THE WORD "REVOCATION" MEANS TWO THINGS
 *
 * A `notification` whose subscription type is `user.authorization.revoke` means
 * a USER revoked authorization: that is the G6 cleanup path. A message type of
 * `revocation` means TWITCH is dropping the subscription itself, which says
 * nothing about any user's authorization and must never delete user data. Both
 * arrive here. See verify.ts.
 *
 * WHAT IT DELETES, AND WHAT IT DOES NOT
 *
 * It calls one database function, `purge_twitch_derived`, which removes the
 * encrypted credential and the Twitch-derived relationship observations for
 * that actor - and nothing else. Watchside's own analytics, the social graph
 * and the account all survive. Revoking a Twitch grant is not a request to
 * erase Watchside's record of Watchside.
 *
 * PHASE 1 NOTE
 *
 * There is no writer for either of those tables yet. This receiver is
 * deliberately built and proven before custody exists, because a credential
 * with no working deletion path is a liability from its first row.
 *
 * Deployment:
 *   supabase functions deploy twitch-eventsub --no-verify-jwt
 *   supabase secrets set TWITCH_EVENTSUB_SECRET=<the subscription secret>
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  HEADER,
  challengeFrom,
  decideAction,
  verifyRequest,
} from './verify.ts'

declare const Deno: { env: { get(key: string): string | undefined } }

const EVENTSUB_SECRET = Deno.env.get('TWITCH_EVENTSUB_SECRET') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/**
 * Fixed codes only.
 *
 * Never a message, never a header value, never anything derived from the
 * payload or a credential. Enough to know the subsystem is healthy without
 * logging what moved through it.
 */
function note(code: string, extra: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({ at: 'twitch-eventsub', code, ...extra }))
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  if (!EVENTSUB_SECRET || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
    // Fail closed. A misconfigured receiver must not silently accept traffic
    // it cannot verify.
    note('not_configured')
    return json({ error: 'not_configured' }, 500)
  }

  // The RAW body, read once, before anything parses or re-serialises it.
  // Twitch signed these exact bytes.
  const rawBody = await request.text()

  const headers: Record<string, string | null> = {}
  for (const name of Object.values(HEADER)) headers[name] = request.headers.get(name)

  const verified = await verifyRequest({
    headers,
    rawBody,
    secret: EVENTSUB_SECRET,
    now: Date.now(),
  })

  if (!verified.ok) {
    note('rejected', { reason: verified.reason })
    // 403 for anything that is not provably from Twitch. Nothing has been
    // parsed as an instruction and nothing has been deleted.
    return json({ error: verified.reason }, 403)
  }

  let body: unknown = null
  try {
    body = rawBody.length > 0 ? JSON.parse(rawBody) : null
  } catch {
    note('unparseable_body')
    return json({ error: 'bad_request' }, 400)
  }

  const action = decideAction(verified.messageType, verified.subscriptionType, body)

  // Setup handshake. No database work, no dedupe - Twitch retries this until
  // it gets the challenge back.
  if (action.kind === 'challenge') {
    const challenge = challengeFrom(body)
    if (!challenge) return json({ error: 'bad_request' }, 400)
    note('challenge_answered')
    return new Response(challenge, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  /*
   * Replay guard.
   *
   * The message id is stable across Twitch's retries, so inserting it is both
   * the dedupe and the record that we saw it. A duplicate insert fails on the
   * primary key, which is the signal that this delivery has already been
   * handled - answer 2xx and stop, or Twitch keeps retrying.
   *
   * Deliberately AFTER signature verification: an unverified request must not
   * be able to poison the table with an id that would suppress a later genuine
   * delivery.
   */
  const { error: dedupeError } = await supabase
    .from('eventsub_messages')
    .insert({ message_id: verified.messageId })

  if (dedupeError) {
    if (dedupeError.code === '23505') {
      note('duplicate_delivery')
      return json({ status: 'duplicate' }, 200)
    }
    // The guard is unavailable. Deleting anyway would be safe (the purge is
    // idempotent), but failing closed keeps the invariant simple: no cleanup
    // happens without a recorded delivery.
    note('dedupe_unavailable')
    return json({ error: 'unavailable' }, 503)
  }

  if (action.kind === 'subscription_dropped') {
    /*
     * TWITCH dropped the subscription. This is not a user revocation and must
     * not delete anything. It does need to be loud, because from here on
     * Watchside stops hearing about real revocations until the subscription is
     * recreated.
     */
    note('subscription_dropped')
    return json({ status: 'subscription_dropped' }, 200)
  }

  if (action.kind === 'ignore') {
    note('ignored', { reason: action.reason })
    return json({ status: 'ignored' }, 200)
  }

  // action.kind === 'purge_actor'
  const { data: actorId, error: resolveError } = await supabase.rpc('actor_for_twitch_user', {
    p_twitch_user_id: action.twitchUserId,
  })

  if (resolveError) {
    note('resolve_failed')
    return json({ error: 'unavailable' }, 503)
  }

  if (!actorId) {
    /*
     * A revocation for somebody Watchside does not know - never signed in, or
     * already deleted. Both are ordinary. Answer 2xx so Twitch stops retrying
     * a delivery that can never succeed, and never fall back to matching on
     * login or display name.
     */
    note('unknown_actor')
    return json({ status: 'no_actor' }, 200)
  }

  const { data: purged, error: purgeError } = await supabase.rpc('purge_twitch_derived', {
    p_actor: actorId,
  })

  if (purgeError) {
    note('purge_failed')
    return json({ error: 'unavailable' }, 503)
  }

  // Counts only. Never an actor id, never a login, never anything from the row.
  note('purged', {
    credentials: (purged as Record<string, unknown> | null)?.credentials ?? 0,
    observations: (purged as Record<string, unknown> | null)?.observations ?? 0,
  })

  return json({ status: 'purged' }, 200)
})
