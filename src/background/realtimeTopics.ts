/**
 * Naming a realtime channel, and not tripping over the previous one.
 *
 * Two small, pure pieces that exist because both of the problems they solve
 * were found by reading the code rather than by anything failing loudly - see
 * docs/reports/friends-beta-investigation-2026-08-27.md §2 and
 * docs/reports/multi-stream-room-architecture-2026-08-27.md §10.5.
 *
 * WHY TOPICS MUST BE DERIVED FROM CONTENT
 *
 * Topics used to be spelled with the SIZE of the id set in them -
 * `kickback-presence:<count>:<first>` and `kickback-groups:<user>:<count>`.
 * Two different sets of the same size therefore shared a topic. supabase-js
 * keys its channel registry by topic, so asking for a name that is already
 * taken can hand back the wrong channel entirely, with somebody else's
 * bindings on it. Hashing the whole sorted set means a different set is always
 * a different name, and the same set is reliably the same name.
 *
 * WHY TEARDOWN HAS TO BE AWAITED
 *
 * `removeChannel` is asynchronous. The subscription managers close the old
 * channel and open the new one in the same tick, so a re-subscribe to the same
 * topic - which is exactly what a retry after CHANNEL_ERROR does - could reach
 * `supabase.channel(topic)` while the previous instance was still unsubscribing
 * and be handed that dying instance. Its bindings are already gone, so nothing
 * would ever arrive again: silent, permanent, and indistinguishable from "my
 * messages vanished".
 *
 * The gate below serialises per topic. It is deliberately NOT a global lock:
 * two unrelated channels must still be able to open at once.
 *
 * NOTE ON SCOPE. Neither of these is claimed to fix the unresolved group
 * incident. They remove a mechanism that could produce that symptom; that is
 * not the same as evidence it did.
 */

/**
 * A short, stable name for a set of ids.
 *
 * FNV-1a over the sorted, joined set. Not a cryptographic hash and does not
 * need to be: the input is our own list of uuids, the output is a channel name,
 * and the only property required is that different sets look different.
 *
 * Sorted first so that the same membership in a different order is the same
 * topic - otherwise a re-ordered friend list would churn the subscription for
 * no reason.
 */
export function setFingerprint(ids: readonly string[]): string {
  const sorted = [...new Set(ids)].sort()
  let hash = 0x811c9dc5
  const input = `${sorted.length}:${sorted.join(',')}`
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)
    // FNV prime, via shifts so this stays in 32-bit integer arithmetic.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  // The count stays in the name: it costs nothing and makes a topic readable
  // in a log without having to reverse the hash.
  return `${sorted.length}-${hash.toString(16).padStart(8, '0')}`
}

/** `prefix:user:<fingerprint>` - the whole naming convention, in one place. */
export function topicFor(prefix: string, userId: string, ids: readonly string[]): string {
  return `${prefix}:${userId}:${setFingerprint(ids)}`
}

export interface TopicGate {
  /**
   * Wait for any pending teardown of this topic, then run `open`.
   *
   * The wait is per topic, so opening the room inbox is never delayed by the
   * group channel closing.
   */
  enter<T>(topic: string, open: () => Promise<T>): Promise<T>
  /**
   * Record a teardown that a later `enter` on the same topic must wait for.
   *
   * Takes the promise rather than performing the removal, so this module never
   * needs to know what a Supabase channel is.
   */
  leave(topic: string, teardown: Promise<unknown>): Promise<void>
  /** For tests and diagnostics: how many teardowns are still in flight. */
  pending(): number
}

export function createTopicGate(): TopicGate {
  const inFlight = new Map<string, Promise<void>>()

  return {
    async enter(topic, open) {
      const pending = inFlight.get(topic)
      // A failed teardown must not block the next open forever; the whole
      // point is to get a live subscription back.
      if (pending) await pending.catch(() => {})
      return open()
    },

    leave(topic, teardown) {
      const settled = Promise.resolve(teardown).then(
        () => {},
        () => {},
      )
      // Chained rather than replaced: two closes of the same topic must both
      // be waited for, not just the later one.
      const previous = inFlight.get(topic)
      const next = previous ? previous.then(() => settled) : settled
      inFlight.set(topic, next)
      void next.then(() => {
        // Only clear if nothing newer took the slot, or a close that races a
        // reopen would drop a teardown somebody is waiting on.
        if (inFlight.get(topic) === next) inFlight.delete(topic)
      })
      return next
    },

    pending: () => inFlight.size,
  }
}
