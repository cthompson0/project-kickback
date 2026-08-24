import { channelUrl, getCurrentChannel } from './channels'
import type { AnalyticsSurface } from '../../core/analytics'

/**
 * Where a JOIN came from.
 *
 * The same vocabulary analytics uses for every other surface, deliberately -
 * not a parallel list that happens to agree today. "Which surface drove a
 * JOIN" and "which surface showed the opportunity" have to be the same words
 * or the funnel cannot be joined up, and two enums that must match is a
 * promise nobody keeps.
 *
 * The JOIN itself is recorded by JoinButton, which is the only thing that
 * knows both the surface and whether the navigation actually happened.
 */
export type JoinSource = AnalyticsSurface

/**
 * Jump to a channel. Twitch's router is not reachable from a content script, so
 * we do a real navigation - reliable, and Kickback re-mounts with its panel
 * state restored, which keeps the join feeling continuous.
 *
 * Returns whether it navigated. That answer is load-bearing: a JOIN to the
 * channel already being watched is a click that goes nowhere, and treating it
 * as a join would count an arrival that never happens.
 */
export function joinChannel(channel: string): boolean {
  // Guarded at the action, not only where the button is drawn: a panel that
  // has not re-rendered since the user navigated must not be able to reload
  // the stream they are already watching.
  if (getCurrentChannel()?.toLowerCase() === channel.trim().toLowerCase()) return false

  window.location.assign(channelUrl(channel))
  return true
}
