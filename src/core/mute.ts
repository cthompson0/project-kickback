/**
 * Mute: a personal quiet, and nothing more.
 *
 * WHAT IT IS
 *
 * A local list of people whose noise you would rather not have. It suppresses
 * their room messages, their reactions, and their contribution to the combo
 * counts YOU see - that last one deliberately, because a muted person
 * inflating a number in your panel is still them getting your attention.
 *
 * WHAT IT IS NOT
 *
 * It is not a block, and the distinction is the point.
 *
 *   * The server never learns about it. There is no table, no RPC, no
 *     migration, and nothing that could leak it back to the muted person.
 *   * They are not told, and nothing they can observe changes.
 *   * They keep participating normally for everybody else.
 *   * Friendship, presence, Social Gravity and the HERE card are untouched. A
 *     muted friend is still on your map, because they are still your friend
 *     and still watching something - mute is about noise in a conversation,
 *     not about hiding a person.
 *
 * Because it is local, two viewers can see different combo counts for the same
 * moment. That is unavoidable for any client-side mute and is much better than
 * a mute that only half works.
 *
 * BLOCK IS A SEPARATE, SERVER-SIDE THING, AND IT IS NEXT
 *
 * Mute is not a substitute for it. A room reaches three hops, so you can end
 * up with somebody you never chose; muting stops them being loud but does not
 * stop them being there or seeing you. Block has to affect the graph itself -
 * friendship, requests, traversal, delivery, presence - and it must land
 * before this is opened past controlled testing. See
 * docs/checkpoints/contextual-stream-session-architecture.md.
 */

export interface Muted {
  /** User ids, deduplicated. Order is irrelevant and not preserved. */
  readonly userIds: readonly string[]
}

export function parseMutedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) seen.add(entry)
  }
  return [...seen]
}

export function isMuted(mutedIds: readonly string[], userId: string | null): boolean {
  return userId !== null && mutedIds.includes(userId)
}

export function withMuted(mutedIds: readonly string[], userId: string): string[] {
  return mutedIds.includes(userId) ? [...mutedIds] : [...mutedIds, userId]
}

export function withoutMuted(mutedIds: readonly string[], userId: string): string[] {
  return mutedIds.filter((id) => id !== userId)
}

/**
 * Drop everything a muted person contributed.
 *
 * Applied BEFORE the combo engine rather than after it, which is what makes
 * their contribution disappear from the count rather than merely from the
 * list. Generic over anything with a sender, so messages and reactions go
 * through the same filter and cannot drift apart.
 */
export function withoutMutedSenders<T extends { senderId: string }>(
  entries: readonly T[],
  mutedIds: readonly string[],
): T[] {
  if (mutedIds.length === 0) return entries as T[]
  return entries.filter((entry) => !mutedIds.includes(entry.senderId))
}
