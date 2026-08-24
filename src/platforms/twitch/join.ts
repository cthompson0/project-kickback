import { channelUrl, getCurrentChannel } from './channels'

/**
 * Where a JOIN came from.
 *
 * Carried through but not reported anywhere: no telemetry exists yet. It is
 * here so the future analytics checkpoint can tell "clicked a friend" apart
 * from "answered a gathering alert" without re-plumbing every call site.
 */
export type JoinSource = 'friend_row' | 'gathering' | 'notification' | 'group'

/**
 * Jump to a channel. Twitch's router is not reachable from a content script, so
 * we do a real navigation - reliable, and Kickback re-mounts with its panel
 * state restored, which keeps the join feeling continuous.
 */
export function joinChannel(channel: string, _source: JoinSource = 'friend_row'): boolean {
  // Guarded at the action, not only where the button is drawn: a panel that
  // has not re-rendered since the user navigated must not be able to reload
  // the stream they are already watching.
  if (getCurrentChannel()?.toLowerCase() === channel.trim().toLowerCase()) return false

  window.location.assign(channelUrl(channel))
  return true
}
