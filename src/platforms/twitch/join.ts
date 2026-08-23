import { channelUrl } from './channels'

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
export function joinChannel(channel: string, _source: JoinSource = 'friend_row'): void {
  window.location.assign(channelUrl(channel))
}
