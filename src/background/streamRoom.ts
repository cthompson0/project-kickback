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

  async function ask(forChannel: string, mine: number): Promise<void> {
    inFlight = true
    try {
      const payload = await deps.backend.members(forChannel)
      if (mine !== generation) return

      members = sortMembers(parseRoomMembers(payload))
      fetchedAt = now()
      deps.onChange?.()
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

      void ask(channel, generation)
    },

    snapshot: () => members,
    channel: () => channel,

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
