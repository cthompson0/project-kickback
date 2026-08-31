/**
 * EventSub request verification, kept free of Deno and of the database.
 *
 * This is the part that decides whether a request is really from Twitch, and
 * whether it means what it appears to mean. It lives apart from index.ts so it
 * can be exercised directly by the test suite rather than only through a
 * deployed function - the signature check and the message-type branch are the
 * two places where a mistake silently deletes user data, and both need to be
 * provable offline.
 *
 * Everything here operates on the RAW body string. Twitch signs the exact bytes
 * it sent, so parsing before verifying - or re-serialising and signing that -
 * checks a different message than the one that arrived.
 */

/** Header names, lower-cased, as observed on a real delivery. */
export const HEADER = {
  messageId: 'twitch-eventsub-message-id',
  timestamp: 'twitch-eventsub-message-timestamp',
  signature: 'twitch-eventsub-message-signature',
  messageType: 'twitch-eventsub-message-type',
  retry: 'twitch-eventsub-message-retry',
  subscriptionType: 'twitch-eventsub-subscription-type',
  subscriptionVersion: 'twitch-eventsub-subscription-version',
} as const

/**
 * The three things Twitch sends to one endpoint.
 *
 * `revocation` is the trap. Twitch uses the word for two different concepts:
 *
 *   messageType 'notification' + subscriptionType 'user.authorization.revoke'
 *       -> A USER revoked Watchside's Twitch authorization. This is the one
 *          that must delete that actor's credential and observations.
 *
 *   messageType 'revocation'
 *       -> TWITCH is dropping the SUBSCRIPTION itself (it expired, the app was
 *          suspended, the auth behind the subscription went away). Nobody's
 *          Twitch authorization has necessarily changed and NO user data may be
 *          touched.
 *
 * Both arrive at the same URL and both are called revocation in Twitch's own
 * vocabulary. Confusing them either deletes data for a user who revoked
 * nothing, or ignores a subscription that has silently stopped working.
 */
export const MESSAGE_TYPE = {
  notification: 'notification',
  verification: 'webhook_callback_verification',
  revocation: 'revocation',
} as const

export const REVOKE_SUBSCRIPTION_TYPE = 'user.authorization.revoke'
export const REVOKE_SUBSCRIPTION_VERSION = '1'

/** How far out of date a delivery may be before it is treated as a replay. */
export const TIMESTAMP_TOLERANCE_MS = 10 * 60 * 1000

/**
 * What Twitch signs: message id, then timestamp, then the raw body.
 *
 * Quoting Twitch: "a message that is the concatenation of the values in the
 * Twitch-Eventsub-Message-Id header, Twitch-Eventsub-Message-Timestamp header,
 * and the raw request body (the order is important.)"
 */
export function signedMessage(messageId: string, timestamp: string, rawBody: string): string {
  return `${messageId}${timestamp}${rawBody}`
}

const encoder = new TextEncoder()

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** HMAC-SHA256, formatted the way Twitch formats it: `sha256=<hex>`. */
export async function computeSignature(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return `sha256=${toHex(signed)}`
}

/**
 * Comparison that does not leak how much of the signature was right.
 *
 * A plain `===` on strings can return as soon as two characters differ, which
 * in principle lets an attacker discover a valid signature one character at a
 * time. The cost of avoiding that here is a loop.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0
}

/** Is this delivery recent enough to be believed? */
export function isFresh(timestamp: string, now: number, tolerance = TIMESTAMP_TOLERANCE_MS): boolean {
  const sent = Date.parse(timestamp)
  if (Number.isNaN(sent)) return false
  return Math.abs(now - sent) <= tolerance
}

export interface VerifyInput {
  headers: Record<string, string | null | undefined>
  rawBody: string
  secret: string
  now: number
}

export type VerifyResult =
  | { ok: false; reason: 'missing_headers' | 'stale_timestamp' | 'bad_signature' }
  | { ok: true; messageId: string; messageType: string; subscriptionType: string | null }

/**
 * Decides whether a request is genuinely from Twitch.
 *
 * Order matters and is deliberate: headers, then freshness, then signature. A
 * stale delivery is rejected before any HMAC work, and nothing at all is
 * believed about the body until the signature over the exact received bytes
 * matches.
 */
export async function verifyRequest(input: VerifyInput): Promise<VerifyResult> {
  const get = (name: string): string => (input.headers[name] ?? '').toString()

  const messageId = get(HEADER.messageId)
  const timestamp = get(HEADER.timestamp)
  const signature = get(HEADER.signature)
  const messageType = get(HEADER.messageType)

  if (!messageId || !timestamp || !signature || !messageType) {
    return { ok: false, reason: 'missing_headers' }
  }
  if (!isFresh(timestamp, input.now)) {
    return { ok: false, reason: 'stale_timestamp' }
  }

  const expected = await computeSignature(
    input.secret,
    signedMessage(messageId, timestamp, input.rawBody),
  )
  if (!timingSafeEqual(expected, signature)) {
    return { ok: false, reason: 'bad_signature' }
  }

  return {
    ok: true,
    messageId,
    messageType,
    subscriptionType: get(HEADER.subscriptionType) || null,
  }
}

export type Action =
  | { kind: 'challenge' }
  | { kind: 'purge_actor'; twitchUserId: string }
  | { kind: 'subscription_dropped' }
  | { kind: 'ignore'; reason: string }

/**
 * Decides what a VERIFIED request means.
 *
 * Branching on message type happens before anything in the body is interpreted
 * as an instruction, which is what keeps a dropped subscription from being read
 * as a user revocation.
 *
 * Identity comes from `event.user_id` and nothing else. The payload also
 * carries `user_login` and `user_name`, and both are null when the Twitch
 * account no longer exists - which is precisely one of the situations that
 * produces a revocation. Falling back to a login would fail exactly when it
 * mattered, and would fail silently.
 */
export function decideAction(
  messageType: string,
  subscriptionType: string | null,
  body: unknown,
): Action {
  if (messageType === MESSAGE_TYPE.verification) {
    return { kind: 'challenge' }
  }

  // Twitch dropping the subscription. Never a user's authorization.
  if (messageType === MESSAGE_TYPE.revocation) {
    return { kind: 'subscription_dropped' }
  }

  if (messageType !== MESSAGE_TYPE.notification) {
    return { kind: 'ignore', reason: 'unknown_message_type' }
  }

  const record = (body ?? {}) as Record<string, unknown>
  const subscription = (record.subscription ?? {}) as Record<string, unknown>
  const type = subscriptionType ?? (subscription.type as string | undefined) ?? null
  if (type !== REVOKE_SUBSCRIPTION_TYPE) {
    return { kind: 'ignore', reason: 'unsubscribed_type' }
  }

  const event = (record.event ?? {}) as Record<string, unknown>
  const twitchUserId = event.user_id
  if (typeof twitchUserId !== 'string' || twitchUserId.length === 0) {
    return { kind: 'ignore', reason: 'no_user_id' }
  }

  return { kind: 'purge_actor', twitchUserId }
}

/** The challenge Twitch expects echoed back verbatim during setup. */
export function challengeFrom(body: unknown): string | null {
  const challenge = (body as Record<string, unknown> | null)?.challenge
  return typeof challenge === 'string' ? challenge : null
}
