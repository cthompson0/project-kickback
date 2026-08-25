import { parseRoomMembers, sortMembers } from '../core/streamRoom'
import type { RoomMember } from '../core/streamRoom'

/**
 * Who is in the room, asked of the server.
 *
 * WHY THE SERVER AND NOT HERE
 *
 * A room is the connected component of the friendship graph among people
 * present on a destination. Computing that needs the friendship edges BETWEEN
 * other people and their presence - neither of which this client can see, and
 * neither of which it should. Sending the graph to the browser so the browser
 * could walk it is exactly the thing the privacy model forbids.
 *
 * So `stream_room_members` walks it, seeded at the caller, and returns members
 * rather than edges. This file only asks, caches and forgets.
 *
 * WHY IT IS CACHED RATHER THAN LIVE
 *
 * Membership changes when presence changes, and presence already broadcasts.
 * Asking on every presence tick would be a query per heartbeat per user for an
 * answer that rarely differs, so the ask is debounced and only ever made for
 * the one channel the viewer is on. Presence remains the truth; this is the
 * part of it the viewer is not otherwise entitled to see.
 */

export interface RoomBackend {
  /** Ask the server for the caller's component on this channel. */
  members(channel: string): Promise<unknown>
}

export interface StreamRoomDeps {
  backend: RoomBackend
  onChange?: () => void
  now?: () => number
  /** How long an answer is reused before asking again. */
  refreshMs?: number
  onError?: (context: string, error: unknown) => void
}

export interface StreamRoom {
  /**
   * Declare the channel the viewer is on, or null.
   *
   * Idempotent and cheap: safe to call on every presence tick and every
   * broadcast. Asks only when the channel changed or the answer went stale.
   */
  want(channel: string | null): void
  /** Everyone in the room, direct friends first. Empty when there is none. */
  snapshot(): RoomMember[]
  /** The channel the current membership belongs to. */
  channel(): string | null
  /**
   * Throw away the cached answer without forgetting the channel.
   *
   * For when something the SERVER's answer depended on has demonstrably
   * changed - somebody arriving on or leaving this channel - which the
   * refresh interval would otherwise sit on for up to ninety seconds. The
   * next `want` asks again; nothing is cleared in the meantime, so a room on
   * screen does not blink while the new answer is in flight.
   */
  invalidate(): void
  /** Sign-out, or a different account. */
  reset(): void
  /** For tests and diagnostics. */
  pending(): boolean
}

/**
 * Two presence heartbeats.
 *
 * Long enough that a room does not cost a query per beat, short enough that
 * somebody arriving is visible within the time it takes to notice them on
 * screen. Departures are usually faster than this anyway: they show up through
 * presence, which the panel already has.
 */
const DEFAULT_REFRESH_MS = 90_000

export function createStreamRoom(deps: StreamRoomDeps): StreamRoom {
  const now = deps.now ?? (() => Date.now())
  const refreshMs = deps.refreshMs ?? DEFAULT_REFRESH_MS

  let channel: string | null = null
  let members: RoomMember[] = []
  let fetchedAt = 0
  let inFlight = false
  /** Guards a slow answer landing after the viewer moved on. */
  let generation = 0
  /**
   * How many times the answer has been declared out of date.
   *
   * A counter rather than a flag, because what matters is whether an
   * invalidation happened DURING a particular request - and a flag cleared by
   * whoever noticed it first cannot answer that.
   */
  let invalidations = 0

  async function ask(forChannel: string, mine: number, seen: number): Promise<void> {
    inFlight = true
    try {
      const payload = await deps.backend.members(forChannel)
      if (mine !== generation) return

      members = sortMembers(parseRoomMembers(payload))
      deps.onChange?.()

      /*
       * THE ARRIVAL AND DEPARTURE BUG.
       *
       * Somebody joining produces TWO presence events in quick succession -
       * they go idle as their old tab closes, then appear on the new channel a
       * moment later - and each one invalidates the room. The first fires a
       * request; the second arrives while it is still in the air, finds
       * `inFlight` and returns early.
       *
       * The request then lands with an answer computed BEFORE the arrival, and
       * used to stamp `fetchedAt` - swallowing the invalidation and caching
       * the pre-arrival room for the full refresh interval. That is exactly
       * the reported symptom: the person who joined sees the session
       * immediately (their own navigation resets this state), and the person
       * already watching does not get it until they refresh. Departure is the
       * same shape, which is why leaving took most of a minute to show.
       *
       * So an answer is only allowed to count as fresh if nothing invalidated
       * it while it was being fetched. Otherwise it is applied - it is still
       * the best we have - and asked again immediately. This terminates
       * because each retry observes the latest count, and invalidations only
       * happen when the co-present set actually changes.
       */
      if (invalidations !== seen) {
        fetchedAt = 0
        inFlight = false
        void ask(forChannel, mine, invalidations)
        return
      }

      fetchedAt = now()
    } catch (error) {
      /*
       * Nothing is cleared.
       *
       * A failed membership call must not empty a room that exists - the
       * previous answer is still the best one we have, and the HERE card's own
       * count comes from presence either way. Failure degrades toward "we
       * cannot enrich it", never toward "nobody is here".
       */
      deps.onError?.('room.members', error)
    } finally {
      if (mine === generation) inFlight = false
    }
  }

  return {
    want(next): void {
      const login = next ? next.trim().toLowerCase() : null

      if (login !== channel) {
        generation += 1
        channel = login
        members = []
        fetchedAt = 0
        inFlight = false
        deps.onChange?.()
      }

      if (!channel) return
      if (inFlight) return
      if (fetchedAt !== 0 && now() - fetchedAt < refreshMs) return

      void ask(channel, generation, invalidations)
    },

    snapshot: () => members,
    channel: () => channel,

    invalidate(): void {
      // The count is what makes this survive a request that is already in the
      // air; see ask(). Zeroing the timestamp alone was not enough.
      invalidations += 1
      fetchedAt = 0
    },

    reset(): void {
      generation += 1
      channel = null
      members = []
      fetchedAt = 0
      inFlight = false
      deps.onChange?.()
    },

    pending: () => inFlight,
  }
}
