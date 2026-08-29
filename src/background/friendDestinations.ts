import type { DestinationsByUser } from '../core/socialGravity'

/**
 * What the viewer can currently see of their friends' open streams.
 *
 * Extracted from the worker because the LIFECYCLE is what keeps going wrong,
 * and a lifecycle wired inline in `src/background/index.ts` cannot be tested -
 * that module touches chrome globals at import. Everything here is timers and
 * promises over injected dependencies, so the awkward cases (a change arriving
 * mid-fetch, two triggers in the same tick, a failure) are testable without a
 * browser.
 *
 * TWO THINGS IT OWNS, AND WHY THEY BELONG TOGETHER
 *
 * The SET, and the notification that the set changed. Those were separate
 * before, and the gap between them was the defect: the worker updated the map
 * and broadcast it to the panel, but nothing told the metadata service that
 * two channels it had never heard of were about to be drawn. Enrichment
 * arrived on the next unrelated trigger - a friend's 45-second heartbeat -
 * which is exactly the "sometimes delayed, fixed by refreshing" the owner saw.
 *
 * So `onChange` is the single event "the destination set is now different",
 * and every consequence of that hangs off it. There is no polling here and
 * none is needed: a friend opening a stream updates their presence row, which
 * is a realtime event, which is what calls `schedule()`.
 */

export interface FriendDestinationsDeps {
  /** Reads list_friend_destinations. Resolves to null with `error` on failure. */
  fetch(): Promise<{ value: Record<string, string[]> | null; error?: string }>
  /**
   * The set is now different from what it was.
   *
   * Fires on a REAL change only - this runs on a timer and on every friend
   * presence event, and an unchanged map must not push a full state snapshot
   * to every open tab for nothing.
   */
  onChange(destinations: DestinationsByUser): void
  onError?(context: string, error: unknown): void
  /** How long `schedule()` coalesces for. */
  coalesceMs?: number
}

export interface FriendDestinationsStore {
  snapshot(): DestinationsByUser
  /** Read now, unless a read is already in flight - in which case, after it. */
  refresh(): void
  /** Read soon, coalescing a burst of triggers into one read. */
  schedule(): void
  /** Forget everything, without reading. For sign-out. */
  clear(): void
  /** True while a read is in flight. */
  pending(): boolean
}

const DEFAULT_COALESCE_MS = 1_000

/** Same set, same order, same channels. */
function same(a: DestinationsByUser, b: DestinationsByUser): boolean {
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    const left = a[key]
    const right = b[key]
    if (!right || left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return false
    }
  }
  return true
}

export function createFriendDestinations(
  deps: FriendDestinationsDeps,
): FriendDestinationsStore {
  const coalesceMs = deps.coalesceMs ?? DEFAULT_COALESCE_MS

  let destinations: DestinationsByUser = {}
  let inFlight = false
  /**
   * A read was asked for while one was already running.
   *
   * It used to be DROPPED - `if (pending) return` - which quietly lost every
   * change that happened to land during a slow request, until some later
   * unrelated event asked again. Remembering it and running once more
   * afterwards is what makes "the set changed" reliably converge.
   */
  let again = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function run(): void {
    if (inFlight) {
      again = true
      return
    }
    inFlight = true

    void deps
      .fetch()
      .then((result) => {
        if (result.error) {
          deps.onError?.('presence.destinations', result.error)
          return
        }
        const next = result.value ?? {}
        if (same(next, destinations)) return
        destinations = next
        deps.onChange(destinations)
      })
      .catch((error: unknown) => {
        deps.onError?.('presence.destinations', error)
      })
      .finally(() => {
        inFlight = false
        if (!again) return
        again = false
        // Whatever asked while we were busy still wants an answer.
        run()
      })
  }

  return {
    snapshot: () => destinations,

    refresh(): void {
      clearTimeout(timer)
      timer = undefined
      run()
    },

    schedule(): void {
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        run()
      }, coalesceMs)
    },

    clear(): void {
      clearTimeout(timer)
      timer = undefined
      again = false
      destinations = {}
    },

    pending: () => inFlight,
  }
}
