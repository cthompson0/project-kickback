/**
 * Naming a failure, without describing it.
 *
 * WHY THIS EXISTS
 *
 * Until now every failure in the extension went to `console.warn` and nowhere
 * else. When the first external tester reported a real bug - a group she could
 * see but not participate in - there was no evidence at all, and the whole
 * server-side hypothesis space had to be eliminated by re-executing the schema
 * rather than by looking at what actually happened. See
 * docs/reports/friends-beta-investigation-2026-08-27.md §2 and §17.
 *
 * WHY IT IS A VOCABULARY AND NOT A MESSAGE
 *
 * The obvious version of this feature ships the exception text, and the obvious
 * version is the one that leaks. A Supabase error can quote the request that
 * produced it; a fetch failure can quote a URL; a validation error can quote
 * the value that failed. Analytics is built on the promise that it can never
 * contain free text, and one thoughtful exception would end that promise
 * permanently.
 *
 * So nothing here is derived from a message. A context is one of a fixed list
 * of call sites, and a code is one of a fixed list of shapes. Anything that
 * does not match a known member is reported as `unknown`, which is a genuine
 * signal - "something is failing in a way we did not anticipate" - rather than
 * a hole.
 *
 * WHAT IS THEREFORE STRUCTURALLY IMPOSSIBLE TO SEND
 *
 * Message bodies, exception text, stack traces, emails, friend codes, user ids,
 * channel names, emote content, URLs, tokens, and anything else a person typed
 * or a server echoed. The two properties are drawn from arrays declared in this
 * file; no other value can reach them.
 */

/**
 * Where a failure happened.
 *
 * The same strings the services already pass to `onError`, so a call site does
 * not have to learn a second name for itself - but enumerated here, so an
 * unrecognised one becomes `unknown` instead of travelling.
 */
export const FAILURE_CONTEXTS = [
  'analytics.flush',
  'attention.hydrate',
  'attention.persist',
  'emoteCatalog.loadChannel',
  'emoteCatalog.loadGlobal',
  'feedback',
  'groupSync.close',
  'groupSync.open',
  'groups.hydrate',
  'groups.persistSeen',
  'groups.refresh',
  'groups.setMuted',
  'heartbeat',
  'metadata.fetch',
  'metadata.hydrate',
  'preferences.hydrate',
  'preferences.set',
  'presenceSync.close',
  'presenceSync.open',
  'refresh',
  'refreshSession',
  'reportOffline',
  'reportPresence',
  'room.members',
  'roomMessages.history',
  'roomMessages.send',
  'roomMessages.subscribe',
  'search',
  'sessionTab.hydrate',
  'sessionTab.markRead',
  'sessionTab.mute',
  'sessionTab.persist',
  'signOut',
  'socialSync.close',
  'socialSync.open',
  'together.send',
  'together.subscribe',
  'unknown',
] as const

export type FailureContext = (typeof FAILURE_CONTEXTS)[number]

/**
 * What KIND of failure it was.
 *
 * Deliberately coarse. The question this has to answer is "which of the things
 * that can go wrong is going wrong", and eight answers cover it. A ninth would
 * be a temptation to encode detail, and detail is where content gets in.
 */
export const FAILURE_CODES = [
  /** The server refused on authorization grounds. Postgres 42501. */
  'refused',
  /** A rate budget was exhausted. Postgres 53400. */
  'rate_limited',
  /** The thing asked for does not exist, or is not ours. Postgres P0002. */
  'not_found',
  /** The request was malformed or out of range. Postgres 22023. */
  'invalid',
  /** No usable session. Postgres 28000, or our own sign-in check. */
  'unauthenticated',
  /** The request never reached anything. */
  'network',
  /** A realtime channel reported an error or timed out. */
  'realtime',
  /** Everything else, which is a real answer and not a gap. */
  'unknown',
] as const

export type FailureCode = (typeof FAILURE_CODES)[number]

const CONTEXTS = new Set<string>(FAILURE_CONTEXTS)

export function toFailureContext(value: unknown): FailureContext {
  return typeof value === 'string' && CONTEXTS.has(value)
    ? (value as FailureContext)
    : 'unknown'
}

/**
 * Classify an error into one of the codes above.
 *
 * Reads only from a small set of markers - the SQLSTATE-derived prefixes our
 * own RPCs raise, and a couple of shapes fetch produces. The message itself is
 * matched against fixed substrings and then DISCARDED; it is never returned,
 * stored or forwarded.
 */
export function toFailureCode(error: unknown): FailureCode {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : ''

  // Postgres SQLSTATEs, which is what our RPCs raise deliberately.
  if (code === '42501') return 'refused'
  if (code === '53400') return 'rate_limited'
  if (code === 'P0002') return 'not_found'
  if (code === '22023') return 'invalid'
  if (code === '28000') return 'unauthenticated'

  // PostgREST surfaces the same failures through the message when the error
  // arrives as a plain Error - which is how our own backend wrapper rethrows.
  const lowered = message.toLowerCase()
  if (lowered.includes('not authenticated') || lowered.includes('session ended')) {
    return 'unauthenticated'
  }
  if (lowered.includes('too quickly') || lowered.includes('rate limit')) return 'rate_limited'
  if (lowered.includes('you are not') || lowered.includes('permission')) return 'refused'
  if (lowered.includes('not found')) return 'not_found'
  if (lowered.includes('failed to fetch') || lowered.includes('network')) return 'network'

  return 'unknown'
}

/** Which subscription a realtime status belongs to. */
export const REALTIME_SURFACES = ['social', 'presence', 'group', 'together', 'room'] as const
export type RealtimeSurface = (typeof REALTIME_SURFACES)[number]

/**
 * What a realtime channel is doing.
 *
 * `connected` is included on purpose rather than only failures: without it a
 * silent channel is indistinguishable from a channel nobody opened, which is
 * exactly the ambiguity that made the group incident impossible to diagnose.
 */
export const REALTIME_STATUSES = ['connected', 'error', 'reconnected'] as const
export type RealtimeStatus = (typeof REALTIME_STATUSES)[number]
