import { IDLE } from '../core/types'
import type { Activity } from '../core/types'

/**
 * Decides what the user is *actually* doing, from however many Twitch tabs
 * they have open.
 *
 * The rule, in product terms: Kickback should say what you are watching, not
 * whatever a background tab last mentioned. Concretely:
 *
 *   1. A visible tab always beats a hidden one. If you are looking at Lirik,
 *      it does not matter that Shroud is open behind it.
 *   2. Among tabs of equal visibility, the most recently updated wins - that
 *      is the one you just navigated or just switched to.
 *   3. No tabs at all means no activity, which is reported as offline.
 *
 * Keeping this as a pure function of a tab map means the awkward cases -
 * background tab navigating on its own, two visible windows, a tab closing
 * mid-navigation - are all testable without a browser.
 */

export interface TabActivity {
  /** Twitch channel, or null when on Twitch but not watching a channel. */
  channel: string | null
  visible: boolean
  /** Monotonic-ish ordering; ties break toward the later report. */
  updatedAt: number
}

/**
 * How many destinations may be published at once.
 *
 * Three, and the server enforces the same number in apply_destinations - this
 * copy exists so the client does not send work the server will throw away, not
 * as the boundary. A modified extension gets nothing extra by ignoring it.
 */
export const MAX_DESTINATIONS = 3

export interface ActivityRegistry {
  /** Record what a tab is doing. Returns true if the effective activity changed. */
  update(tabKey: object, activity: TabActivity): boolean
  /** Forget a tab (closed, navigated away, port died). */
  remove(tabKey: object): boolean
  clear(): void
  /**
   * The PRIMARY destination, which is a purely local idea.
   *
   * Used for HERE, for the viewer's own "watching with you" question and for
   * analytics attribution. It is never published as a field: presence carries
   * a SET, and which of them the viewer is looking at is nobody else's
   * business. See docs/reports/multi-stream-room-architecture-2026-08-27.md §3.
   */
  effective(): Activity
  /**
   * Every Twitch channel currently open, most-recently-updated first, capped.
   *
   * Duplicate tabs on one stream collapse here rather than at the server:
   * three tabs on shroud are one destination, so closing one of them changes
   * nothing at all. A tab that is on Twitch but not on a channel contributes
   * nothing.
   */
  destinations(): string[]
  /** True when at least one Twitch tab is open. */
  hasTabs(): boolean
  tabCount(): number
}

function toActivity(tab: TabActivity | null): Activity {
  if (!tab) return IDLE
  if (!tab.channel) return { type: 'browsing', platform: 'twitch' }
  return { type: 'watching', platform: 'twitch', channel: tab.channel }
}

function sameActivity(a: Activity, b: Activity): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'watching' && b.type === 'watching') {
    return a.platform === b.platform && a.channel === b.channel
  }
  return true
}

export function createActivityRegistry(): ActivityRegistry {
  const tabs = new Map<object, TabActivity>()
  let lastEffective: Activity = IDLE

  function pick(): TabActivity | null {
    let best: TabActivity | null = null
    for (const tab of tabs.values()) {
      if (!best) {
        best = tab
        continue
      }
      if (tab.visible !== best.visible) {
        if (tab.visible) best = tab
        continue
      }
      if (tab.updatedAt >= best.updatedAt) best = tab
    }
    return best
  }

  function recompute(): boolean {
    const next = toActivity(pick())
    if (sameActivity(next, lastEffective)) return false
    lastEffective = next
    return true
  }

  return {
    update(tabKey, activity) {
      tabs.set(tabKey, activity)
      return recompute()
    },
    remove(tabKey) {
      if (!tabs.delete(tabKey)) return false
      return recompute()
    },
    clear() {
      tabs.clear()
      lastEffective = IDLE
    },
    effective: () => lastEffective,

    destinations(): string[] {
      /*
       * Newest first, de-duplicated, then capped.
       *
       * De-duplication has to happen BEFORE the cap: two tabs on shroud must
       * not consume two of the three slots, or a third stream would be
       * silently unpublishable for somebody who simply opened a duplicate.
       *
       * Ordering is by updatedAt because that is what "most recently active"
       * means here - it is the same signal the pick rule already trusts, and
       * it is what the server uses to choose the legacy primary channel.
       * Visibility is deliberately NOT part of it: a hidden tab is still an
       * open stream, and focus never reaches the network.
       */
      const seen = new Map<string, number>()
      for (const tab of tabs.values()) {
        if (!tab.channel) continue
        const at = seen.get(tab.channel)
        if (at === undefined || tab.updatedAt > at) seen.set(tab.channel, tab.updatedAt)
      }
      return [...seen.entries()]
        .sort(([channelA, a], [channelB, b]) => b - a || channelA.localeCompare(channelB))
        .slice(0, MAX_DESTINATIONS)
        .map(([channel]) => channel)
    },

    hasTabs: () => tabs.size > 0,
    tabCount: () => tabs.size,
  }
}
