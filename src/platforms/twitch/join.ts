import { channelUrl } from './channels'

/**
 * Jump to a channel. Twitch's router is not reachable from a content script, so
 * we do a real navigation - reliable, and Kickback re-mounts with its panel
 * state restored, which keeps the join feeling continuous.
 */
export function joinChannel(channel: string): void {
  window.location.assign(channelUrl(channel))
}
