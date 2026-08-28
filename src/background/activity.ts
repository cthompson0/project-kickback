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
   * Every Twitch channel currently open, most-recently-OPENED first, capped.
   *
   * Duplicate tabs on one stream collapse here rather than at the server:
   * three tabs on shroud are one destination, so closing one of them changes
   * nothing at all. A tab that is on Twitch but not on a channel contributes
   * nothing.
   *
   * Ordered by when each tab arrived AT ITS CURRENT CHANNEL, which is not the
   * same as when it last reported. A tab reports again on every
   * visibilitychange, so ordering by the report time would let merely looking
   * at a tab reorder the published set - and that order decides the legacy
   * primary channel, which other people can see. Focus would become a network
   * event, which is the one property this design exists to prevent.
   */
  destinations(): string[]
  /** True when at least one Twitch tab is open. */
  hasTabs(): boolean
  tabCount(): number
  /**
   * Every live tab, exactly as the registry holds it.
   *
   * Read-only, and for development diagnostics only - the question "which
   * ports does the worker actually know about" cannot be answered from
   * `destinations()`, because a missing tab and a tab on no channel look
   * identical there. That distinction is what a browser investigation needs.
   */
  snapshot(): TabSnapshot[]
}

/** One live tab, for diagnostics. */
export interface TabSnapshot {
  /** The port object the worker keyed this tab by. */
  key: object
  channel: string | null
  visible: boolean
  /** When this tab last reported anything. */
  updatedAt: number
  /** When it arrived at the channel it is on now - what ordering uses. */
  channelAt: number
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

/**
 * A tab as the registry keeps it: what it reported, plus when it arrived at
 * the channel it is on now.
 */
interface TabRecord extends TabActivity {
  /**
   * When this tab first reported its CURRENT channel.
   *
   * Carried forward across every later report that does not change the
   * channel - a visibilitychange, a title settling, a pageshow. That is what
   * keeps the published order still while the user moves between tabs.
   */
  channelAt: number
}

export function createActivityRegistry(): ActivityRegistry {
  const tabs = new Map<object, TabRecord>()
  let lastEffective: Activity = IDLE

  function pick(): TabRecord | null {
    let best: TabRecord | null = null
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
      const previous = tabs.get(tabKey)
      /*
       * The channel clock only moves when the channel does.
       *
       * A tab that merely became visible, or hidden, or whose title finally
       * caught up, is still at the same destination and keeps its place in
       * the published order.
       */
      const channelAt =
        previous && previous.channel === activity.channel ? previous.channelAt : activity.updatedAt
      tabs.set(tabKey, { ...activity, channelAt })
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
       * Ordering is by channelAt - when each tab ARRIVED at the channel it is
       * on - and never by updatedAt. A tab reports again on every
       * visibilitychange, so ordering by the report time would make merely
       * looking at a background tab reorder the set, rewrite the legacy
       * primary channel, and put a write on the wire.
       *
       * Visibility is likewise not part of it: a hidden tab is still an open
       * stream, and its stream is still published.
       */
      /*
       * A destination is dated by the EARLIEST tab still showing it.
       *
       * So opening a second tab on a stream that is already published changes
       * nothing at all - it is the same destination, and it was opened when it
       * was opened. Taking the latest instead would let a duplicate tab shove
       * an old destination to the front of the set, rewrite the legacy primary
       * channel, and cost a write for no change in what is open.
       */
      const seen = new Map<string, number>()
      for (const tab of tabs.values()) {
        if (!tab.channel) continue
        const at = seen.get(tab.channel)
        if (at === undefined || tab.channelAt < at) seen.set(tab.channel, tab.channelAt)
      }
      return [...seen.entries()]
        .sort(([channelA, a], [channelB, b]) => b - a || channelA.localeCompare(channelB))
        .slice(0, MAX_DESTINATIONS)
        .map(([channel]) => channel)
    },

    hasTabs: () => tabs.size > 0,
    tabCount: () => tabs.size,

    snapshot: () =>
      [...tabs.entries()].map(([key, tab]) => ({
        key,
        channel: tab.channel,
        visible: tab.visible,
        updatedAt: tab.updatedAt,
        channelAt: tab.channelAt,
      })),
  }
}
