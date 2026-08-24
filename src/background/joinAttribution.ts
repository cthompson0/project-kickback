/**
 * Carrying a JOIN's origin through to what happened next.
 *
 * The question analytics has to answer is not "was JOIN clicked" but "did
 * clicking JOIN on a gathering actually put this person in front of that
 * stream, with their friends, for a while". That is four events in three
 * different parts of the extension, minutes apart, and the only honest way to
 * connect them is to carry an id rather than to match timestamps afterwards.
 *
 * So a click MINTS an attribution: an id, the destination, the surface, the
 * session, and the moment. Arrival and the shared watch that follows quote it.
 * In SQL the funnel is then a join on one column instead of a guess.
 *
 * WHAT MAKES THIS AWKWARD, AND WHAT IS DONE ABOUT IT
 *
 *   - The navigation destroys the page that clicked. The click therefore has
 *     to be recorded by the service worker, not the content script, and the
 *     attribution has to be in storage before the tab goes.
 *   - The worker is killed after ~30s idle, and a navigation is exactly the
 *     kind of pause that kills it. So this is stored, not remembered.
 *   - Navigation can simply fail, or the user can change their mind and go
 *     somewhere else. A pending attribution therefore EXPIRES, and expiry is
 *     silent: arrival rate is arrivals over clicks, so a click with no arrival
 *     is already counted correctly by being absent.
 *   - Clicking JOIN five times in a second is one intention. A new click for
 *     the same destination replaces the pending one rather than adding to it.
 *   - Clicking JOIN for a different destination abandons the first: the user
 *     is going to the second place, and attributing their arrival to the first
 *     would be a lie.
 *
 * After arrival the attribution is KEPT, for longer, because the shared watch
 * that a JOIN produced can start several minutes later - a friend arrives, or
 * presence catches up. It is dropped once even that window has passed, so
 * nothing here accumulates.
 */

export type AttributionState = 'pending' | 'arrived'

export interface JoinAttribution {
  id: string
  /** Lowercase Twitch login. */
  channel: string
  source: string
  sessionId: string | null
  clickedAt: number
  state: AttributionState
  arrivedAt: number | null
}

/** How long a click may wait for an arrival before it is treated as abandoned. */
export const ARRIVAL_WINDOW_MS = 90 * 1000
/** How long an arrival stays attributable to a shared watch that begins later. */
export const TOGETHER_WINDOW_MS = 10 * 60 * 1000

export interface AttributionStore {
  read(): Promise<JoinAttribution | null>
  write(value: JoinAttribution | null): Promise<void>
}

export interface JoinAttributionDeps {
  store: AttributionStore
  now?: () => number
  newId?: () => string
  arrivalWindowMs?: number
  togetherWindowMs?: number
}

export interface JoinAttributionTracker {
  /** Record a click and return the attribution to quote on the join event. */
  click(input: { channel: string; source: string; sessionId: string | null }): Promise<JoinAttribution>
  /**
   * The user is now on this channel. Returns the attribution if this arrival
   * answers a pending click, and null otherwise - which is the normal case for
   * ordinary browsing.
   */
  arrive(channel: string | null): Promise<JoinAttribution | null>
  /** The live attribution for a shared watch starting on this channel, if any. */
  forTogether(channel: string): Promise<JoinAttribution | null>
  clear(): Promise<void>
}

export function createJoinAttribution(deps: JoinAttributionDeps): JoinAttributionTracker {
  const now = deps.now ?? (() => Date.now())
  const newId = deps.newId ?? (() => crypto.randomUUID())
  const arrivalWindowMs = deps.arrivalWindowMs ?? ARRIVAL_WINDOW_MS
  const togetherWindowMs = deps.togetherWindowMs ?? TOGETHER_WINDOW_MS

  /** Drops anything that is past its usefulness. One rule, one place. */
  function alive(value: JoinAttribution | null, at: number): JoinAttribution | null {
    if (!value) return null
    if (value.state === 'pending') {
      return at - value.clickedAt <= arrivalWindowMs ? value : null
    }
    return at - (value.arrivedAt ?? value.clickedAt) <= togetherWindowMs ? value : null
  }

  return {
    async click({ channel, source, sessionId }): Promise<JoinAttribution> {
      // Whatever was pending is superseded. Even for the same channel: the
      // latest click is the one whose surface the user actually acted on.
      const attribution: JoinAttribution = {
        id: newId(),
        channel,
        source,
        sessionId,
        clickedAt: now(),
        state: 'pending',
        arrivedAt: null,
      }
      await deps.store.write(attribution)
      return attribution
    },

    async arrive(channel: string | null): Promise<JoinAttribution | null> {
      const at = now()
      const current = alive(await deps.store.read(), at)

      if (!current) {
        // Expired or absent. Clear the slot so a stale record cannot be
        // resurrected by a coincidence later.
        await deps.store.write(null)
        return null
      }

      if (current.state !== 'pending') return null
      // Ordinary navigation somewhere else. The click did not lead here, so it
      // gets no arrival - and it stays pending in case the user is passing
      // through on their way to the destination.
      if (!channel || channel !== current.channel) return null

      const arrived: JoinAttribution = { ...current, state: 'arrived', arrivedAt: at }
      await deps.store.write(arrived)
      return arrived
    },

    async forTogether(channel: string): Promise<JoinAttribution | null> {
      const at = now()
      const current = alive(await deps.store.read(), at)
      if (!current) {
        await deps.store.write(null)
        return null
      }
      // Only an arrival counts. A shared watch that begins while a click is
      // still pending is a coincidence, not that click's outcome.
      if (current.state !== 'arrived') return null
      return current.channel === channel ? current : null
    },

    clear: () => deps.store.write(null),
  }
}
