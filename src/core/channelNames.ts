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
 * Three sources, in order of authority:
 *
 *   1. The Twitch Metadata Service. Twitch's own `display_name`, for the
 *      channel itself, fetched with an app token. Nothing can beat it, and it
 *      is the only source that can spell a channel this browser has never
 *      opened and nobody here is friends with.
 *   2. People Kickback already knows. A Twitch channel is a Twitch user, so if
 *      a friend or group member's login matches the channel, their stored
 *      Twitch display name IS the channel's display name.
 *   3. Channels this browser has actually opened. The content script reads the
 *      casing off the page title, which is Twitch telling us directly.
 *
 * All three are keyed by login and hold one value per channel, so the answer
 * cannot depend on who happens to be watching it - a destination with six
 * friends on it resolves exactly as it would with one.
 *
 * The order is about provenance, not freshness. (1) is the creator's own
 * account record; (2) is a copy of that record taken when someone signed in;
 * (3) is a string parsed out of a page title. Each is a step further from the
 * source, so each yields to the one above it.
 *
 * Every source is still only TEXT. The login stays canonical for equality,
 * clustering, JOIN, analytics and opportunity keys, and no amount of
 * authority changes that - see docs/ANALYTICS.md.
 */

/** Anything with a Twitch login and the display name that goes with it. */
export interface NamedTwitchUser {
  username: string
  displayName: string
}

export interface ChannelNameSources {
  /**
   * login -> Twitch's own display_name, from the metadata service.
   *
   * Highest authority: it is the creator's account record rather than a copy
   * of it or a parse of a page title.
   */
  metadata?: Readonly<Record<string, { displayName?: string | null }>>
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

  // Twitch's own answer about this channel. Checked the same way as every
  // other source: a name that is a different word is a rename, not a spelling,
  // and identity is never allowed to come from display text.
  const authoritative = sources.metadata?.[login]?.displayName?.trim()
  if (authoritative && isSameChannel(login, authoritative)) return authoritative

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
