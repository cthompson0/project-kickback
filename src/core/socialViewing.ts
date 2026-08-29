import { liveStateOf } from './twitchMetadata'
import type { ChannelMetadata, LiveState } from './twitchMetadata'

/**
 * Two different questions that were once one boolean.
 *
 * WHY THEY WERE EVER THE SAME
 *
 * Two accounts once sat on twitch.tv/lirik with no stream running and Watchside
 * reported them watching together - a room, reactions, and an open shared-watch
 * interval that would eventually have claimed an hour of co-viewing of nothing.
 * The fix was to require an authoritative LIVE status before any of it formed,
 * and it worked.
 *
 * It was also too broad. Requiring a broadcast to be running before people are
 * allowed to have a conversation says that a stream ending should end the
 * social space it happened in, which is the opposite of what it should do: the
 * stream ends and everybody is still sitting there, which is exactly when there
 * is most to say. And a group agreeing to meet on a channel that has not gone
 * live yet is a perfectly ordinary thing to want.
 *
 * So it is two rules now, and they are deliberately named so that nothing can
 * quietly ask one when it means the other.
 *
 *   SOCIAL SESSION      are these people together at the same destination?
 *                       Presence and social connectivity. NOT live status.
 *                       Drives: the contextual tab, the room, its messages,
 *                       its emotes and its combos.
 *
 *   LIVE SHARED WATCH   are they co-viewing a live broadcast right now?
 *                       Presence AND authoritative live status.
 *                       Drives: watching_together_started / _ended, durations,
 *                       and the retention measured from them - and nothing a
 *                       person can see.
 *
 * The failure mode each protects against is different, which is why one rule
 * could never serve both. Getting SOCIAL SESSION wrong shows somebody a tab
 * they did not expect. Getting LIVE SHARED WATCH wrong writes a number into
 * the database that nobody can ever tell was fiction.
 */

// --------------------------------------------------------- social session

/**
 * Whether a contextual session can exist at a destination.
 *
 * Deliberately says nothing about broadcasts. A session needs somewhere to be
 * and somebody to be there with - so a channel and at least one other person
 * whose presence puts them on it.
 *
 * `peers` is a count rather than the live state on purpose: what makes a
 * session real is people, and there is no argument from metadata that can
 * conjure one or take one away.
 */
export function canSessionForm(channel: string | null, peers: number): boolean {
  return channel !== null && channel.length > 0 && peers > 0
}

// ------------------------------------------------------ live shared watch

/**
 * Whether co-viewing counts as watching a LIVE broadcast together.
 *
 * `unknown` is NOT eligible, and that is the deliberate half.
 *
 * A cold cache, an undeployed function, a Twitch outage and a channel nobody
 * has asked about yet all produce `unknown`. Treating that as live would mean
 * inventing certainty, and the cost lands in the one place we cannot repair:
 * analytics claiming people watched something together when nobody knows
 * whether there was anything to watch.
 *
 * The price is under-counting - a live channel whose metadata has not arrived
 * yet loses the first moments of a shared watch. That is the direction to err
 * in, and it is the same trade the rest of the analytics work has made.
 *
 * Nothing a person can SEE hangs off this any more. If it is wrong, a number
 * is slightly conservative; nobody loses a conversation.
 */
export function isLiveSharedWatch(live: LiveState): boolean {
  return live === 'live'
}

/** The live half of the question, for one channel, from whatever is in hand. */
export function canWatchLiveTogether(
  channel: string | null,
  metadata: Readonly<Record<string, ChannelMetadata>> | undefined,
  now: number = Date.now(),
): boolean {
  if (!channel) return false
  return isLiveSharedWatch(liveStateOf(metadata?.[channel.toLowerCase()], now))
}

// ------------------------------------------------------------- the label

/**
 * What to SAY about a destination's broadcast, which is a third thing again.
 *
 * The card distinguishes `offline` from `unknown` - a stream that ended is a
 * fact, and "we have not been told" is not - so this returns the state rather
 * than a boolean. Nothing here hides the OFFLINE label; the label is now the
 * only thing live status decides on screen.
 */
export function watchTogetherState(
  channel: string | null,
  metadata: Readonly<Record<string, ChannelMetadata>> | undefined,
  now: number = Date.now(),
): LiveState {
  if (!channel) return 'unknown'
  return liveStateOf(metadata?.[channel.toLowerCase()], now)
}
