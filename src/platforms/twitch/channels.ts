/**
 * Twitch URL / channel helpers. Everything Twitch-shaped that the UI needs to
 * know lives behind this module.
 */

/**
 * Top-level Twitch paths that are pages rather than channels. Anything not on
 * this list and shaped like a login is treated as a channel, which is the right
 * default: guessing wrong just means Kickback shows "Browsing Twitch".
 */
const RESERVED_PATHS = new Set([
  '',
  'directory',
  'videos',
  'video',
  'settings',
  'subscriptions',
  'inventory',
  'wallet',
  'drops',
  'friends',
  'following',
  'search',
  'downloads',
  'store',
  'prime',
  'turbo',
  'jobs',
  'p',
  'u',
  'popout',
  'payments',
  'broadcast',
  'dashboard',
  'creatorcamp',
  'products',
  'bits',
  'privacy',
  'legal',
  'login',
  'signup',
])

const CHANNEL_PATTERN = /^[a-zA-Z0-9_]{3,25}$/

/** Parse the channel out of a Twitch pathname, or null if it isn't a channel page. */
export function parseChannelFromPath(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 0) return null

  // /moderator/<channel> still means the user is looking at that channel.
  const candidate = segments[0] === 'moderator' && segments[1] ? segments[1] : segments[0]

  if (RESERVED_PATHS.has(candidate.toLowerCase())) return null
  if (!CHANNEL_PATTERN.test(candidate)) return null

  // /<channel>/clip/<slug> and /<channel>/video/<id> are VODs, not live viewing,
  // but for a presence prototype "watching <channel>" is still the right answer.
  return candidate.toLowerCase()
}

export function getCurrentChannel(): string | null {
  return parseChannelFromPath(window.location.pathname)
}

/**
 * How to spell a channel on screen.
 *
 * This used to upper-case the first letter of the login, which invents casing
 * nobody chose: `anoterostv` became `Anoterostv`, and `xqc` became `Xqc`.
 * Twitch capitalisation is data, so pass the real display name when one is
 * known - see core/channelNames.ts - and otherwise the login is shown exactly
 * as Twitch canonicalised it.
 */
export function formatChannelName(channel: string, displayName?: string | null): string {
  const name = displayName?.trim()
  if (name && name.toLowerCase() === channel.trim().toLowerCase()) return name
  return channel
}

export function channelUrl(channel: string): string {
  return `https://www.twitch.tv/${channel}`
}
