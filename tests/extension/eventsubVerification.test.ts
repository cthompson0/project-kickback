import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  HEADER,
  MESSAGE_TYPE,
  TIMESTAMP_TOLERANCE_MS,
  challengeFrom,
  computeSignature,
  decideAction,
  isFresh,
  signedMessage,
  timingSafeEqual,
  verifyRequest,
} from '../../supabase/functions/twitch-eventsub/verify'

/**
 * What is allowed to delete a user's Twitch data.
 *
 * The EventSub receiver is the one endpoint in Watchside that deletes data on
 * the say-so of an outside party. Nothing about a request may be believed
 * before the HMAC over the exact received bytes matches, and even then the
 * request has to mean what it appears to mean.
 *
 * THE TRAP THIS SUITE EXISTS FOR
 *
 * Twitch uses the word "revocation" for two different things, and both arrive
 * at this endpoint:
 *
 *   Message-Type: notification, subscription type user.authorization.revoke
 *       -> a USER revoked authorization. Delete their Twitch-derived data.
 *
 *   Message-Type: revocation
 *       -> TWITCH dropped the SUBSCRIPTION. Nobody revoked anything. Deleting
 *          user data here would destroy an H2 baseline because our own
 *          subscription lapsed.
 *
 * That distinction was found by generating real payloads with Twitch's CLI, not
 * from the documentation, and it is the single most dangerous thing in this
 * file to get wrong.
 *
 * The fixtures mirror a payload observed from `twitch event trigger
 * user.authorization.revoke`.
 */

const SECRET = 'u3-verification-test-secret'
const NOW = Date.parse('2026-08-31T16:41:12.220Z')

/** Shaped exactly like the payload the Twitch CLI delivered. */
const REVOKE_BODY = {
  subscription: {
    id: '151e7814-743c-3fdb-b6a6-516ef257b1b9',
    status: 'enabled',
    type: 'user.authorization.revoke',
    version: '1',
    condition: { client_id: 'watchside-client-id' },
    transport: { method: 'webhook', callback: 'https://example.test/hook' },
    created_at: '2026-08-31T16:41:12.2205015Z',
    cost: 1,
  },
  event: {
    user_id: '19477018',
    user_login: 'testfromuser',
    user_name: 'testFromUser',
    client_id: 'watchside-client-id',
  },
}

async function headersFor(
  rawBody: string,
  over: Partial<Record<string, string>> = {},
): Promise<Record<string, string>> {
  const messageId = over[HEADER.messageId] ?? 'msg-0001'
  const timestamp = over[HEADER.timestamp] ?? new Date(NOW).toISOString()
  const signature =
    over[HEADER.signature] ?? (await computeSignature(SECRET, signedMessage(messageId, timestamp, rawBody)))
  return {
    [HEADER.messageId]: messageId,
    [HEADER.timestamp]: timestamp,
    [HEADER.signature]: signature,
    [HEADER.messageType]: MESSAGE_TYPE.notification,
    [HEADER.subscriptionType]: 'user.authorization.revoke',
    [HEADER.subscriptionVersion]: '1',
    ...over,
  }
}

async function verify(body: unknown, over: Partial<Record<string, string>> = {}) {
  const rawBody = JSON.stringify(body)
  return verifyRequest({ headers: await headersFor(rawBody, over), rawBody, secret: SECRET, now: NOW })
}

describe('signature verification', () => {
  it('accepts a genuinely signed delivery', async () => {
    const result = await verify(REVOKE_BODY)
    expect(result.ok).toBe(true)
  })

  it('signs id, then timestamp, then the raw body, in that order', () => {
    expect(signedMessage('a', 'b', 'c')).toBe('abc')
  })

  it('rejects a wrong signature', async () => {
    const result = await verify(REVOKE_BODY, { [HEADER.signature]: 'sha256=' + '0'.repeat(64) })
    expect(result).toEqual({ ok: false, reason: 'bad_signature' })
  })

  /**
   * The attack this actually stops.
   *
   * A signature is only meaningful over the exact bytes that arrived. If the
   * body is modified in flight - swapping in somebody else's user_id - the
   * signature no longer matches and nothing is deleted.
   */
  it('rejects a body tampered with after signing', async () => {
    const rawBody = JSON.stringify(REVOKE_BODY)
    const headers = await headersFor(rawBody)
    const tampered = JSON.stringify({
      ...REVOKE_BODY,
      event: { ...REVOKE_BODY.event, user_id: '99999999' },
    })

    const result = await verifyRequest({ headers, rawBody: tampered, secret: SECRET, now: NOW })
    expect(result).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects a signature made with a different secret', async () => {
    const rawBody = JSON.stringify(REVOKE_BODY)
    const forged = await computeSignature(
      'not-the-secret',
      signedMessage('msg-0001', new Date(NOW).toISOString(), rawBody),
    )
    const result = await verify(REVOKE_BODY, { [HEADER.signature]: forged })
    expect(result).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects a delivery missing its headers entirely', async () => {
    const rawBody = JSON.stringify(REVOKE_BODY)
    const result = await verifyRequest({ headers: {}, rawBody, secret: SECRET, now: NOW })
    expect(result).toEqual({ ok: false, reason: 'missing_headers' })
  })

  it('produces the sha256=<hex> shape Twitch sends', async () => {
    const signature = await computeSignature(SECRET, 'anything')
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(signature).toHaveLength(71)
  })

  it('compares without revealing how much of the signature was right', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(timingSafeEqual('', '')).toBe(true)

    /*
     * The behaviour above is identical to `a === b`, so it cannot be what
     * defends this. The property that matters is that comparison takes the same
     * time whatever the input, and no assertion about a return value can
     * observe that - a mutation replacing this with `===` passes every
     * behavioural test there is.
     *
     * So the shape is pinned instead: no early return inside the loop, and every
     * character folded into one accumulator. Replacing it with `===` would be a
     * plausible-looking simplification that quietly reintroduces a timing
     * oracle on a signature comparison.
     */
    const source = readFileSync('supabase/functions/twitch-eventsub/verify.ts', 'utf8')
    const fn = source.slice(
      source.indexOf('export function timingSafeEqual'),
      source.indexOf('export function isFresh'),
    )
    expect(fn).toContain('mismatch |=')
    expect(fn).toContain('charCodeAt(i) ^')
    expect(fn).not.toMatch(/return a === b/)
  })
})

describe('replay protection', () => {
  it('rejects a delivery older than the tolerance', async () => {
    const stale = new Date(NOW - TIMESTAMP_TOLERANCE_MS - 1000).toISOString()
    const result = await verify(REVOKE_BODY, { [HEADER.timestamp]: stale })
    expect(result).toEqual({ ok: false, reason: 'stale_timestamp' })
  })

  it('rejects a delivery from implausibly far in the future', async () => {
    const ahead = new Date(NOW + TIMESTAMP_TOLERANCE_MS + 1000).toISOString()
    const result = await verify(REVOKE_BODY, { [HEADER.timestamp]: ahead })
    expect(result).toEqual({ ok: false, reason: 'stale_timestamp' })
  })

  it('accepts one inside the window', async () => {
    const recent = new Date(NOW - 60_000).toISOString()
    const result = await verify(REVOKE_BODY, { [HEADER.timestamp]: recent })
    expect(result.ok).toBe(true)
  })

  it('treats an unparseable timestamp as stale rather than as now', () => {
    expect(isFresh('not a date', NOW)).toBe(false)
    expect(isFresh('', NOW)).toBe(false)
  })

  /*
   * Freshness is checked BEFORE the HMAC. A replayed message that is merely old
   * never reaches the signature comparison, and its signature is still valid -
   * which is exactly why the message id is also recorded server-side.
   */
  it('rejects a stale delivery even when its signature is perfectly valid', async () => {
    const stale = new Date(NOW - 60 * 60 * 1000).toISOString()
    const rawBody = JSON.stringify(REVOKE_BODY)
    const headers = await headersFor(rawBody, { [HEADER.timestamp]: stale })
    const result = await verifyRequest({ headers, rawBody, secret: SECRET, now: NOW })
    expect(result).toEqual({ ok: false, reason: 'stale_timestamp' })
  })
})

describe('the two things Twitch calls revocation', () => {
  /** A user revoked authorization. This is the one that deletes. */
  it('treats a notification of user.authorization.revoke as an actor purge', () => {
    const action = decideAction(MESSAGE_TYPE.notification, 'user.authorization.revoke', REVOKE_BODY)
    expect(action).toEqual({ kind: 'purge_actor', twitchUserId: '19477018' })
  })

  /**
   * THE TRAP.
   *
   * Twitch dropping our subscription is not a user revoking authorization. If
   * this branch ever performed a purge, an expired subscription would silently
   * delete relationship data for whoever the body happened to name.
   */
  it('NEVER purges on a Message-Type of revocation', () => {
    const action = decideAction(MESSAGE_TYPE.revocation, 'user.authorization.revoke', {
      subscription: { ...REVOKE_BODY.subscription, status: 'authorization_revoked' },
    })
    expect(action).toEqual({ kind: 'subscription_dropped' })
    expect(action.kind).not.toBe('purge_actor')
  })

  it('does not purge even when a revocation message carries a full event body', () => {
    const action = decideAction(MESSAGE_TYPE.revocation, 'user.authorization.revoke', REVOKE_BODY)
    expect(action.kind).toBe('subscription_dropped')
  })

  it('answers the setup challenge', () => {
    const action = decideAction(MESSAGE_TYPE.verification, null, { challenge: 'abc123' })
    expect(action).toEqual({ kind: 'challenge' })
    expect(challengeFrom({ challenge: 'abc123' })).toBe('abc123')
    expect(challengeFrom({})).toBeNull()
  })

  it('ignores a message type it does not know', () => {
    expect(decideAction('something_new', 'user.authorization.revoke', REVOKE_BODY)).toEqual({
      kind: 'ignore',
      reason: 'unknown_message_type',
    })
  })

  it('ignores a notification for a subscription type it did not ask for', () => {
    expect(decideAction(MESSAGE_TYPE.notification, 'channel.follow', REVOKE_BODY)).toEqual({
      kind: 'ignore',
      reason: 'unsubscribed_type',
    })
  })
})

describe('identity comes from user_id and nothing else', () => {
  it('reads event.user_id', () => {
    const action = decideAction(MESSAGE_TYPE.notification, 'user.authorization.revoke', REVOKE_BODY)
    expect(action).toMatchObject({ twitchUserId: '19477018' })
  })

  /**
   * user_login and user_name are null when the Twitch account no longer
   * exists - which is one of the situations that PRODUCES a revocation. A
   * design that fell back to them would fail exactly when it mattered.
   */
  it('still resolves when login and name are null', () => {
    const action = decideAction(MESSAGE_TYPE.notification, 'user.authorization.revoke', {
      ...REVOKE_BODY,
      event: { ...REVOKE_BODY.event, user_login: null, user_name: null },
    })
    expect(action).toEqual({ kind: 'purge_actor', twitchUserId: '19477018' })
  })

  it('refuses to act when user_id is missing, rather than guessing from the login', () => {
    const action = decideAction(MESSAGE_TYPE.notification, 'user.authorization.revoke', {
      ...REVOKE_BODY,
      event: { user_login: 'testfromuser', user_name: 'testFromUser' },
    })
    expect(action).toEqual({ kind: 'ignore', reason: 'no_user_id' })
  })

  it('refuses a non-string user_id', () => {
    const action = decideAction(MESSAGE_TYPE.notification, 'user.authorization.revoke', {
      ...REVOKE_BODY,
      event: { ...REVOKE_BODY.event, user_id: 19477018 },
    })
    expect(action).toEqual({ kind: 'ignore', reason: 'no_user_id' })
  })

  it('survives a body with no event at all', () => {
    expect(decideAction(MESSAGE_TYPE.notification, 'user.authorization.revoke', {})).toEqual({
      kind: 'ignore',
      reason: 'no_user_id',
    })
    expect(decideAction(MESSAGE_TYPE.notification, 'user.authorization.revoke', null)).toEqual({
      kind: 'ignore',
      reason: 'no_user_id',
    })
  })
})
