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

export interface ActivityRegistry {
  /** Record what a tab is doing. Returns true if the effective activity changed. */
  update(tabKey: object, activity: TabActivity): boolean
  /** Forget a tab (closed, navigated away, port died). */
  remove(tabKey: object): boolean
  clear(): void
  /** What Kickback should report right now. */
  effective(): Activity
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
    hasTabs: () => tabs.size > 0,
    tabCount: () => tabs.size,
  }
}
