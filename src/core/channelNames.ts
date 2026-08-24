/**
 * How a Twitch channel is spelled when we show it to someone.
 *
 * Twitch has two names for every channel: a canonical lowercase login
 * (`anoterostv`) and a display name the owner chose (`AnoterosTV`). The login
 * is the identity - URLs, comparisons, lookups and storage all use it. The
 * display name is presentation, and it is the one a person recognises.
 *
 * Kickback used to derive the second from the first by upper-casing the first
 * letter, which produced `Anoterostv`: not the login, and not the name anyone
 * chose. Capitalisation is data, not a formatting rule - `xQc`, `iiTzTimmy`
 * and `LIRIK` are unguessable - so this module only ever *looks names up*, and
 * falls back to the login unchanged rather than inventing one.
 *
 * Two sources, both already in hand and neither needing a Twitch API call:
 *
 *   1. People Kickback already knows. A Twitch channel is a Twitch user, so if
 *      a friend or group member's login matches the channel, their stored
 *      Twitch display name IS the channel's display name.
 *   2. Channels this browser has actually opened. The content script reads the
 *      casing off the page title, which is Twitch telling us directly.
 *
 * Both are keyed by login and hold one value per channel, so the answer cannot
 * depend on who happens to be watching it - a destination with six friends on
 * it resolves exactly as it would with one. Sources are tried in the order
 * above; a person Kickback knows outranks a title it read, because the first
 * came from Twitch's own record of that user and the second from a string.
 *
 * A third source belongs here later: the Twitch Metadata Service's
 * authoritative `display_name`, which would take precedence over both and give
 * a spelling to channels this browser has never opened. It drops in as another
 * lookup in resolveChannelName and improves every call site at once - nothing
 * upstream has ever been permitted to treat display text as identity.
 */

/** Anything with a Twitch login and the display name that goes with it. */
export interface NamedTwitchUser {
  username: string
  displayName: string
}

export interface ChannelNameSources {
  /** Friends, group members - anyone whose Twitch name we already hold. */
  people?: readonly NamedTwitchUser[]
  /** login -> display, learned from pages this browser has opened. */
  seen?: Readonly<Record<string, string>>
}

/** A display name must be the same word as the login, differing only in case. */
export function isSameChannel(login: string, candidate: string): boolean {
  return login.toLowerCase() === candidate.trim().toLowerCase()
}

/**
 * The best spelling of a channel we can honestly justify.
 *
 * Never fabricates. If nothing knows better, the login is returned exactly as
 * Twitch canonicalised it, which is always a correct - if plain - answer.
 */
export function resolveChannelName(
  channel: string,
  sources: ChannelNameSources = {},
): string {
  const login = channel.trim().toLowerCase()
  if (!login) return channel

  // A person we know, whose Twitch name is by definition the channel's name.
  for (const person of sources.people ?? []) {
    if (person.username && isSameChannel(login, person.username)) {
      const name = person.displayName?.trim()
      // Only if it really is the same word: a display name that spells
      // something else is somebody's nickname, not this channel.
      if (name && isSameChannel(login, name)) return name
    }
  }

  const seen = sources.seen?.[login]
  if (seen && isSameChannel(login, seen)) return seen

  return login
}

/**
 * Reads a channel's display name out of a Twitch page title.
 *
 * Twitch titles look like "AnoterosTV - Twitch" while live, and carry the
 * stream title in front when watching. This deliberately reads only the title
 * string rather than reaching into Twitch's markup: the title is a single
 * documented value, whereas the header element it would otherwise come from is
 * a styled-components tree that changes without notice.
 *
 * Returns null unless the extracted name is the same word as the login, so a
 * mismatched or unexpected title can never rename a channel.
 */
export function channelNameFromTitle(title: string, login: string): string | null {
  if (!title || !login) return null

  // Strip a trailing " - Twitch", then any leading unread badge like "(3) ".
  const withoutSuffix = title.replace(/\s*-\s*Twitch\s*$/i, '').replace(/^\(\d+\)\s*/, '')

  // Either the whole thing is the channel, or it is the last " - " segment
  // ("Stream title - AnoterosTV").
  const candidates = [withoutSuffix, ...withoutSuffix.split(' - ')]
  for (const candidate of candidates) {
    const name = candidate.trim()
    if (name && isSameChannel(login, name)) return name
  }
  return null
}
