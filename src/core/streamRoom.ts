/**
 * Who is in the automatic Stream Room.
 *
 * The membership itself is computed by the server - `stream_room_members` in
 * 0020 - and this file only models the answer. That split is the privacy
 * model: a client cannot traverse the friendship graph because it never
 * receives one, and the server returns members rather than edges, seeded at
 * the caller and only for a channel the caller is verifiably on.
 *
 * HOPS
 *
 *   0  you
 *   1  a direct friend
 *   2  a friend of one of your friends
 *   3  one further, and the limit
 *
 * Hops exist for one reason: to make a person legible. Somebody at two hops
 * gets "Friend of Jake" so they are not a stranger who appeared in your panel.
 * Beyond that, nothing - "friend of a friend of Jake" is graph detail nobody
 * needs and the server does not send it.
 */

/**
 * The furthest the server will walk.
 *
 * Three is enough for the social path that motivates this - you, a friend, and
 * their friend - and short enough that the traversal stays a bounded query
 * rather than an invitation to enumerate.
 */
export const MAX_HOPS = 3

/**
 * The most people one room may contain.
 *
 * Not a product limit so much as a safety bound: a pathological component on a
 * huge channel must not become a denial of service, and a room with fifty
 * people in it has stopped being a room anyway.
 */
export const MAX_MEMBERS = 50

export interface RoomMember {
  userId: string
  /** 1 for a direct friend, 2 for a friend of theirs, 3 at the limit. */
  hops: number
  /**
   * The direct friend this person was reached through, when there is exactly
   * one hop between you. Null for direct friends (there is nothing to explain)
   * and null beyond two hops (we deliberately do not say).
   */
  viaUserId: string | null
}

/**
 * Read one membership row.
 *
 * Parsed rather than cast, like everything else that crosses a boundary, and
 * bounded on the way in so a server that ever returned something absurd could
 * not make the panel draw it.
 */
export function parseRoomMember(value: unknown): RoomMember | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>

  const userId = raw.user_id
  const hops = raw.hops
  const via = raw.via_user_id

  if (typeof userId !== 'string' || !userId) return null
  if (typeof hops !== 'number' || !Number.isFinite(hops)) return null
  if (hops < 1 || hops > MAX_HOPS) return null

  return {
    userId,
    hops: Math.floor(hops),
    // Only ever shown at two hops, so anything else is dropped rather than
    // carried around waiting to be rendered by mistake.
    viaUserId: hops === 2 && typeof via === 'string' && via ? via : null,
  }
}

export function parseRoomMembers(value: unknown): RoomMember[] {
  if (!Array.isArray(value)) return []
  return value
    .map(parseRoomMember)
    .filter((member): member is RoomMember => member !== null)
    .slice(0, MAX_MEMBERS)
}

/**
 * Whether there is a room at all.
 *
 * One person is not a gathering. The surface appears at two - you and somebody
 * else - which is the same threshold the HERE card already uses for "watching
 * with you".
 */
export function isRoom(members: readonly RoomMember[]): boolean {
  return members.length >= 1
}

/** Direct friends first, then by how far away they are, then stably by id. */
export function sortMembers(members: readonly RoomMember[]): RoomMember[] {
  return [...members].sort((a, b) => a.hops - b.hops || a.userId.localeCompare(b.userId))
}

/**
 * How many of the room are people the viewer actually knows.
 *
 * Reported to analytics beside the total, because "did friend-of-friend
 * exposure actually happen" is the question this whole model exists to answer
 * and the totals alone cannot answer it.
 */
export function directCount(members: readonly RoomMember[]): number {
  return members.filter((member) => member.hops === 1).length
}
