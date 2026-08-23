/**
 * Decides when a gathering is worth interrupting someone for.
 *
 * A gathering is 2+ of your friends watching the same Twitch channel. The hard
 * part is not detecting one - `findGatherings` does that - it is deciding when
 * that fact deserves a desktop notification, given presence updates arrive
 * every few seconds.
 *
 * The rules, precisely:
 *
 *   1. Notify when a channel CROSSES the threshold: below -> at-or-above. A
 *      gathering growing from 2 to 5 is the same gathering and says nothing
 *      new, so it never re-notifies.
 *   2. A gathering must actually END (drop below the threshold) before that
 *      channel can notify again. This is what stops 2->3->2->3 oscillation
 *      from firing repeatedly.
 *   3. Even then, a per-channel cooldown must have elapsed. Friends drifting
 *      in and out of a channel over an evening produce one notification, not
 *      a stream of them.
 *   4. Never notify about the channel the user is already watching - they can
 *      see those friends as HERE. The gathering is still recorded as active,
 *      so leaving that channel does not immediately notify about the thing
 *      they just left.
 *   5. The first snapshot after starting never notifies. Otherwise every
 *      service-worker restart would announce gatherings that were already
 *      under way.
 *
 * Stale presence never reaches here: findGatherings filters on effective
 * status, so a friend whose heartbeat stopped is not in a gathering.
 */

export interface GatheringSnapshot {
  channel: string
  friendIds: string[]
}

export interface GatheringNotice {
  channel: string
  friendIds: string[]
}

export interface GatheringWatcherDeps {
  /** How many friends make a gathering. The local user is not counted. */
  threshold?: number
  /** Minimum gap between notifications for the same channel. */
  cooldownMs?: number
  now?: () => number
  onNotify: (notice: GatheringNotice) => void
}

export interface GatheringWatcher {
  /**
   * Feed the current gatherings and the channel the user is watching.
   * The first call only seeds state.
   */
  update(gatherings: GatheringSnapshot[], myChannel: string | null): void
  /** Forget everything - sign-out, or a different account. */
  reset(): void
  /** Channels currently considered an active gathering. For tests. */
  activeChannels(): string[]
}

export const GATHERING_THRESHOLD = 2
/** Long enough that an evening of friends drifting about is not a stream. */
export const GATHERING_COOLDOWN_MS = 30 * 60_000

interface ChannelState {
  active: boolean
  /**
   * -Infinity, not 0: "never notified" must read as infinitely long ago. With
   * 0 the cooldown check silently swallows the first notification whenever the
   * clock is smaller than the cooldown.
   */
  lastNotifiedAt: number
}

export function createGatheringWatcher(deps: GatheringWatcherDeps): GatheringWatcher {
  const threshold = deps.threshold ?? GATHERING_THRESHOLD
  const cooldownMs = deps.cooldownMs ?? GATHERING_COOLDOWN_MS
  const now = deps.now ?? (() => Date.now())

  const channels = new Map<string, ChannelState>()
  let seeded = false

  return {
    update(gatherings: GatheringSnapshot[], myChannel: string | null): void {
      const qualifying = new Map(
        gatherings
          .filter((gathering) => gathering.friendIds.length >= threshold)
          .map((gathering) => [gathering.channel.toLowerCase(), gathering]),
      )

      // Anything that dropped below the threshold has ended. Ending is what
      // re-arms a channel, so it must be recorded even on the seeding pass.
      for (const [channel, state] of channels) {
        if (!qualifying.has(channel)) state.active = false
      }

      for (const [channel, gathering] of qualifying) {
        const state = channels.get(channel) ?? {
          active: false,
          lastNotifiedAt: Number.NEGATIVE_INFINITY,
        }
        const crossedThreshold = !state.active
        state.active = true
        channels.set(channel, state)

        if (!crossedThreshold) continue
        // Seeding: adopt the current world without announcing it.
        if (!seeded) continue
        // They are already there; those friends show as HERE.
        if (myChannel && channel === myChannel.toLowerCase()) continue
        if (now() - state.lastNotifiedAt < cooldownMs) continue

        state.lastNotifiedAt = now()
        deps.onNotify({ channel: gathering.channel, friendIds: [...gathering.friendIds] })
      }

      seeded = true
    },

    reset(): void {
      channels.clear()
      seeded = false
    },

    activeChannels(): string[] {
      return [...channels.entries()]
        .filter(([, state]) => state.active)
        .map(([channel]) => channel)
        .sort()
    },
  }
}
