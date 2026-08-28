import { parseRoomMembers, sortMembers } from '../core/streamRoom'
import type { RoomMember } from '../core/streamRoom'

/**
 * Who is in each room, asked of the server.
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
 * channels the viewer actually has open.
 *
 * WHY IT IS KEYED BY CHANNEL
 *
 * A viewer may have several streams open, and each is its own room with its own
 * membership, its own freshness and its own failures. When there was a single
 * `members` array, a slow answer for one channel could land after the viewer
 * opened another and overwrite it. Per-channel state makes that unrepresentable
 * rather than merely unlikely: a response can only ever reach its own entry,
 * and the generation counter inside that entry rejects it even then.
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
   * Declare every channel the viewer has open.
   *
   * Idempotent and cheap: safe to call on every presence tick and every
   * broadcast. Each channel is asked about only when it is new or its answer
   * went stale, and each keeps its own clock - so a busy room does not drag a
   * quiet one into a refresh, and a failure on one cannot empty another.
   *
   * A channel that leaves the set is forgotten, which is what makes closing a
   * stream forget its roster while looking at a different one does not.
   */
  want(channels: readonly string[]): void
  /** Everyone in one room, direct friends first. Empty when there is none. */
  snapshot(channel: string | null): RoomMember[]
  /** Every roster currently held, keyed by channel. */
  rosters(): Record<string, RoomMember[]>
  /** The channels currently tracked. */
  channels(): string[]
  /**
   * Throw away a cached answer without forgetting the channel.
   *
   * For when something the SERVER's answer depended on has demonstrably
   * changed - somebody arriving on or leaving a channel - which the refresh
   * interval would otherwise sit on for up to ninety seconds. The next `want`
   * asks again; nothing is cleared in the meantime, so a room on screen does
   * not blink while the new answer is in flight.
   *
   * With no argument every tracked channel is invalidated, which is what a
   * presence change means when we do not know whose room it touched.
   */
  invalidate(channel?: string | null): void
  /** Sign-out, or a different account. */
  reset(): void
  /** For tests and diagnostics. */
  pending(channel?: string | null): boolean
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

/** Everything known about one channel's room. */
interface RoomState {
  members: RoomMember[]
  fetchedAt: number
  inFlight: boolean
  /** Guards a slow answer landing after this channel was dropped and re-added. */
  generation: number
  /**
   * How many times this channel's answer has been declared out of date.
   *
   * A counter rather than a flag, because what matters is whether an
   * invalidation happened DURING a particular request - and a flag cleared by
   * whoever noticed it first cannot answer that.
   */
  invalidations: number
}

function emptyRoom(): RoomState {
  return { members: [], fetchedAt: 0, inFlight: false, generation: 0, invalidations: 0 }
}

const normalize = (channel: string | null | undefined): string | null =>
  channel ? channel.trim().toLowerCase() || null : null

export function createStreamRoom(deps: StreamRoomDeps): StreamRoom {
  const now = deps.now ?? (() => Date.now())
  const refreshMs = deps.refreshMs ?? DEFAULT_REFRESH_MS

  const rooms = new Map<string, RoomState>()

  async function ask(channel: string, state: RoomState, mine: number, seen: number): Promise<void> {
    state.inFlight = true
    try {
      const payload = await deps.backend.members(channel)
      /*
       * Two guards, and both are needed.
       *
       * The generation check rejects an answer for a channel that has since
       * been closed and reopened. The identity check rejects one whose state
       * object is no longer the live one - which is what a stale response
       * would have to get past to corrupt a roster.
       */
      if (mine !== state.generation) return
      if (rooms.get(channel) !== state) return

      state.members = sortMembers(parseRoomMembers(payload))
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
       * immediately, and the person already watching does not until they
       * refresh. Departure is the same shape.
       *
       * So an answer is only allowed to count as fresh if nothing invalidated
       * it while it was being fetched. Otherwise it is applied - it is still
       * the best we have - and asked again immediately. This terminates
       * because each retry observes the latest count, and invalidations only
       * happen when the co-present set actually changes.
       */
      if (state.invalidations !== seen) {
        state.fetchedAt = 0
        state.inFlight = false
        void ask(channel, state, mine, state.invalidations)
        return
      }

      state.fetchedAt = now()
    } catch (error) {
      /*
       * Nothing is cleared, and nothing outside this channel is touched.
       *
       * A failed membership call must not empty a room that exists - the
       * previous answer is still the best one we have, and the HERE card's own
       * count comes from presence either way. Failure degrades toward "we
       * cannot enrich it", never toward "nobody is here", and never toward
       * "some other room is empty".
       */
      deps.onError?.('room.members', error)
    } finally {
      if (mine === state.generation) state.inFlight = false
    }
  }

  return {
    want(next): void {
      const wanted = [...new Set(next.map(normalize).filter((c): c is string => c !== null))]

      // Forget rooms for streams that have closed. Their rosters are not
      // renderable any more, and keeping them would grow without bound.
      let dropped = false
      for (const channel of [...rooms.keys()]) {
        if (wanted.includes(channel)) continue
        rooms.delete(channel)
        dropped = true
      }
      if (dropped) deps.onChange?.()

      for (const channel of wanted) {
        let state = rooms.get(channel)
        if (!state) {
          state = emptyRoom()
          rooms.set(channel, state)
          deps.onChange?.()
        }
        if (state.inFlight) continue
        if (state.fetchedAt !== 0 && now() - state.fetchedAt < refreshMs) continue
        void ask(channel, state, state.generation, state.invalidations)
      }
    },

    snapshot(channel): RoomMember[] {
      const login = normalize(channel)
      if (!login) return []
      return rooms.get(login)?.members ?? []
    },

    rosters(): Record<string, RoomMember[]> {
      const out: Record<string, RoomMember[]> = {}
      for (const [channel, state] of rooms) out[channel] = state.members
      return out
    },

    channels: () => [...rooms.keys()],

    invalidate(channel): void {
      const login = normalize(channel)
      // The count is what makes this survive a request already in the air; see
      // ask(). Zeroing the timestamp alone was not enough.
      const touch = (state: RoomState) => {
        state.invalidations += 1
        state.fetchedAt = 0
      }
      if (login) {
        const state = rooms.get(login)
        if (state) touch(state)
        return
      }
      // No channel named: a presence change we cannot attribute, so every
      // room the viewer holds is suspect.
      for (const state of rooms.values()) touch(state)
    },

    reset(): void {
      // Bumping each generation first means an answer already in the air
      // cannot repopulate a room after sign-out.
      for (const state of rooms.values()) state.generation += 1
      rooms.clear()
      deps.onChange?.()
    },

    pending(channel): boolean {
      const login = normalize(channel)
      if (login) return rooms.get(login)?.inFlight ?? false
      for (const state of rooms.values()) if (state.inFlight) return true
      return false
    },
  }
}
