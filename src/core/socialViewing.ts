import { liveStateOf } from './twitchMetadata'
import type { ChannelMetadata, LiveState } from './twitchMetadata'

/**
 * Whether being on a destination counts as WATCHING IT WITH SOMEBODY.
 *
 * THE BUG THIS EXISTS FOR
 *
 * Two accounts sat on twitch.tv/lirik while LIRIK was offline, and Kickback
 * said "HERE · OFFLINE · 1 friend watching with you". A room formed, the
 * shared-watch analytics lifecycle opened, and had they stayed an hour the
 * database would have recorded an hour of watching together - of a channel
 * with no stream on it.
 *
 * The cause is not a bug in any one place. It is that "user's Twitch page is
 * /lirik" and "user is watching LIRIK" were the same fact everywhere
 * downstream, because presence is the only thing anyone asked.
 *
 * TWO DIFFERENT QUESTIONS
 *
 *   RAW ACTIVITY      where is this person's browser?
 *                     Presence answers it, and it stays exactly as hardened as
 *                     it was: URL parsing, multi-tab effective activity, the
 *                     90-second staleness rule, write-time redaction. Nothing
 *                     in this file touches it, and the Friends list still says
 *                     a friend is on an offline channel, because they are.
 *
 *   SOCIAL VIEWING    are they watching a stream, with people, right now?
 *                     That needs presence AND a live stream, and it is what
 *                     Together, Stream Rooms, reactions and the shared-watch
 *                     analytics lifecycle are all about.
 *
 * ONE RULE, ONE PLACE
 *
 * Everything that means "watching together" asks this function. If Gravity,
 * the room, the reaction transport and analytics each decided for themselves,
 * they would eventually disagree - and the disagreement would be invisible
 * until a number in a report was wrong.
 */

/**
 * A destination is eligible only when Twitch says a stream is up.
 *
 * `unknown` is NOT eligible, and that is the deliberate half.
 *
 * A cold cache, an undeployed function, a Twitch outage and a channel nobody
 * has asked about yet all produce `unknown`. Treating that as live would mean
 * inventing certainty, and the cost lands in the one place we cannot repair:
 * analytics claiming people watched something together when nobody knows
 * whether there was anything to watch.
 *
 * The price is a false negative - a live channel whose metadata has not
 * arrived yet shows no room for a moment. That is recoverable and visible; the
 * false positive is neither. This is the same trade the analytics work has
 * made throughout: conservative undercounting over fabricated activity.
 */
export function isSocialViewing(live: LiveState): boolean {
  return live === 'live'
}

/**
 * The eligibility of one channel, from whatever metadata is in hand.
 *
 * Goes through `liveStateOf` rather than reading `metadata.live` directly, so
 * a record too old to be evidence reports `unknown` and is therefore not
 * eligible - the same freshness rule the Gravity card already draws with.
 */
export function canWatchTogether(
  channel: string | null,
  metadata: Readonly<Record<string, ChannelMetadata>> | undefined,
  now: number = Date.now(),
): boolean {
  if (!channel) return false
  return isSocialViewing(liveStateOf(metadata?.[channel.toLowerCase()], now))
}

/**
 * Why a destination is not eligible, for the one place that says so on screen.
 *
 * The HERE card already distinguishes `offline` from `unknown` - a stream that
 * ended is a fact, and "we have not been told" is not - so this returns the
 * live state rather than a boolean, and the card keeps saying OFFLINE exactly
 * as it does now. Nothing here hides the label; it only stops the label being
 * attached to a social space that should not exist.
 */
export function watchTogetherState(
  channel: string | null,
  metadata: Readonly<Record<string, ChannelMetadata>> | undefined,
  now: number = Date.now(),
): LiveState {
  if (!channel) return 'unknown'
  return liveStateOf(metadata?.[channel.toLowerCase()], now)
}
