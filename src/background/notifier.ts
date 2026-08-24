import { channelUrl, formatChannelName, parseChannelFromPath } from '../platforms/twitch/channels'

/**
 * Desktop notifications for gatherings.
 *
 * Kept deliberately thin: the decision about *whether* to interrupt someone
 * lives in gatherings.ts, and this only knows how to draw the result. The
 * Chrome APIs are injected so the whole thing is testable without a browser.
 *
 * The destination is never built from free text. A notification id carries a
 * channel, and that channel is re-parsed through the same validation the URL
 * bar goes through before it becomes a URL - so a malformed or hostile id
 * cannot turn into navigation somewhere unexpected.
 */

const ID_PREFIX = 'kickback:gathering:'

export interface NotificationOptions {
  type: 'basic'
  iconUrl: string
  title: string
  message: string
  buttons?: Array<{ title: string }>
  silent?: boolean
}

export interface NotifierDeps {
  create(id: string, options: NotificationOptions): void
  clear?(id: string): void
  onClicked(handler: (id: string) => void): void
  onButtonClicked(handler: (id: string, buttonIndex: number) => void): void
  /** Opens a Twitch tab. Separated so tests can assert the destination. */
  openUrl(url: string): void
  /**
   * A gathering notification was acted on, with the channel it pointed at.
   *
   * Separate from openUrl so the caller does not have to parse a URL back into
   * a channel to know what happened - and so the notifier stays the only place
   * that decides what a notification id means.
   */
  onOpen?(channel: string): void
  iconUrl: string
}

export interface GatheringNotification {
  channel: string
  /** Display names, already authorized - these are the user's own friends. */
  names: string[]
  /**
   * Twitch's own capitalisation for the channel, when it is known.
   *
   * Passed in rather than derived: the login cannot tell you whether a channel
   * spells itself xQc or Xqc, and guessing produces a name nobody chose.
   */
  channelName?: string | null
}

export interface Notifier {
  notifyGathering(notification: GatheringNotification): void
  /** Removes the notification for a channel, e.g. once the user is there. */
  dismissGathering(channel: string): void
}

/** "Jake", "Jake and Matt", "Jake, Matt and 2 others". */
export function describeNames(names: string[]): string {
  if (names.length === 0) return 'Friends'
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`
}

/** Recovers the channel from a notification id, or null if it is not ours. */
export function channelFromNotificationId(id: string): string | null {
  if (!id.startsWith(ID_PREFIX)) return null
  // Re-validate through the ordinary channel parser rather than trusting the id.
  return parseChannelFromPath(`/${id.slice(ID_PREFIX.length)}`)
}

export function createNotifier(deps: NotifierDeps): Notifier {
  const open = (id: string) => {
    const channel = channelFromNotificationId(id)
    if (!channel) return
    deps.openUrl(channelUrl(channel))
    deps.onOpen?.(channel)
    deps.clear?.(id)
  }

  deps.onClicked(open)
  deps.onButtonClicked((id, buttonIndex) => {
    if (buttonIndex !== 0) return
    open(id)
  })

  return {
    notifyGathering({ channel, names, channelName }: GatheringNotification): void {
      const safeChannel = parseChannelFromPath(`/${channel}`)
      if (!safeChannel) return

      // Reusing the id per channel means Chrome replaces rather than stacks,
      // which is a second layer of de-duplication under the decision rules.
      deps.create(`${ID_PREFIX}${safeChannel}`, {
        type: 'basic',
        iconUrl: deps.iconUrl,
        title: `${describeNames(names)} on Twitch`,
        message: `Watching ${formatChannelName(safeChannel, channelName)}`,
        buttons: [{ title: 'Join them' }],
      })
    },

    dismissGathering(channel: string): void {
      const safeChannel = parseChannelFromPath(`/${channel}`)
      if (!safeChannel) return
      deps.clear?.(`${ID_PREFIX}${safeChannel}`)
    },
  }
}
