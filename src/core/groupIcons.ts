/**
 * The icons a group may wear.
 *
 * A group is a persistent social circle, and one recognisable character makes
 * a list of them read like places rather than rows of text. Deliberately a
 * fixed set rather than free input: it needs no upload pipeline, no storage,
 * no cropping and no moderation, and every group stays one character wide.
 *
 * Optional. A group with no icon is drawn with a neutral mark rather than an
 * assigned one, so groups that predate icons look deliberate.
 */

export const GROUP_ICONS = [
  '🎮', '🐸', '⚔️', '🔥', '💀', '🍻',
  '🎧', '🏆', '🎲', '🧠', '🚀', '👻',
  '🌙', '🦀', '🎬', '⚡', '🧊', '🍕',
] as const

/**
 * Bounded to match the database check.
 *
 * One user-perceived emoji can be several code points - a flag or a ZWJ
 * sequence is legitimately long - so this is generous, but it is a bound: the
 * column must not become a second name field.
 */
export const MAX_ICON_LENGTH = 24

export function isValidGroupIcon(icon: string): boolean {
  const trimmed = icon.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_ICON_LENGTH) return false
  // Whitespace would let an icon carry words.
  return !/\s/.test(trimmed)
}

/** What the server should be sent: a valid icon, or null for "none". */
export function normalizeGroupIcon(icon: string | null): string | null {
  if (icon === null) return null
  const trimmed = icon.trim()
  return isValidGroupIcon(trimmed) ? trimmed : null
}
