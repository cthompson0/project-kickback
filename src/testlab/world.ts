import { isSameChannel } from '../core/channelNames'

/**
 * The simulated social world.
 *
 * WHAT THIS FILE IS ALLOWED TO KNOW
 *
 * Almost nothing. It describes people and what they are doing, and turns that
 * into PRESENCE ROWS - the shape the `presence` table actually holds. That is
 * the whole contract. Everything after the row is production code:
 * `toPresence` maps it, `mergePresence` indexes it, `stampFriends` attaches it,
 * `clusterMembers` reads it, Social Gravity clusters it and the real panel
 * draws it.
 *
 * Choosing the row as the boundary is deliberate. A simulator that produced
 * `Friend[]` would have to decide who is online, who is stale and whose
 * channel is visible - which are exactly the decisions worth testing, so a
 * simulator that made them would be testing itself. A row is the last point
 * where the answer is data rather than a judgement.
 *
 * THE ONE PIECE OF SERVER BEHAVIOUR MODELLED HERE
 *
 * Privacy is applied at WRITE time by `report_presence` in
 * `supabase/migrations/0003_rpcs.sql`, so by the time any client sees a row it
 * is already redacted. There is no TypeScript copy of that rule to reuse - it
 * is SQL - so `presenceRow` below mirrors it, and is the only production
 * behaviour the Test Lab reimplements. It is kept to six lines, next to a
 * quotation of the SQL, so drift is visible. Real privacy enforcement remains
 * a real-Supabase smoke test; see docs/TEST_LAB.md.
 *
 * TIME
 *
 * People are described by AGES, not timestamps: "last heartbeat 0ms ago",
 * "watching for four minutes". Rows are stamped against the real clock at the
 * moment they are built, so the real staleness window applies unchanged, and
 * advancing lab time is just arithmetic on ages. See `advance`.
 */

export type SimActivity = 'watching' | 'around' | 'offline'
export type SimVisibility = 'visible' | 'hide_activity' | 'invisible'

/**
 * How the observer stands with this person.
 *
 * Non-friends still exist in the world: friend requests, search results and
 * "someone you are not friends with is on your channel" are all states the
 * panel has UI for, and none of them should need a second Twitch account.
 */
export type SimRelationship = 'friend' | 'incoming_request' | 'outgoing_request' | 'stranger'

export interface SimUser {
  /** Stable across a preset, so React keys and analytics ids do not churn. */
  id: string
  /** Twitch login. Lowercase by convention, as Twitch canonicalises it. */
  login: string
  displayName: string
  relationship: SimRelationship
  activity: SimActivity
  /**
   * What they are watching, exactly as typed.
   *
   * May carry any casing. It is lowercased into the row - the same thing
   * `parseChannelFromPath` does in production - and the casing is offered to
   * the channel-name map instead, which is where display spelling belongs.
   */
  channel: string
  visibility: SimVisibility
  /** Milliseconds since their last heartbeat. 0 is a client that is beating. */
  staleForMs: number
  /** How long they have been doing this, for the "watching for 12m" label. */
  activeForMs: number
}

export interface SimObserver {
  id: string
  login: string
  displayName: string
  /** The channel the observer's own browser is on, or null for "not watching". */
  channel: string | null
  visibility: SimVisibility
}

export interface SimWorld {
  observer: SimObserver
  users: SimUser[]
  /**
   * How far lab time has been pushed forward.
   *
   * Only analytics reads this: the hub, the exposure tracker and the gathering
   * watcher all already accept an injected `now`, so windows and cooldowns can
   * be crossed without touching production. Presence does not read it, because
   * presence ages through `staleForMs` instead - see `advance`.
   */
  clockOffsetMs: number
}

/** The shape `toPresence` consumes, which is the shape the table holds. */
export interface PresenceRow {
  user_id: string
  status: 'online' | 'offline'
  platform: string | null
  channel: string | null
  updated_at: string
  last_seen_at: string
}

/**
 * One person's presence row, as the database would hold it.
 *
 * Mirrors `report_presence` (0003_rpcs.sql):
 *
 *   if v_mode = 'invisible' then
 *     update ... set status = 'offline', platform = null, channel = null
 *   if v_mode = 'hide_activity' then
 *     v_platform := null; v_channel := null;
 *
 * Note what is NOT here: no decision about who may read the row, and no
 * staleness. RLS decides the first and the client's own 90-second rule decides
 * the second, and neither is this file's business.
 */
export function presenceRow(user: SimUser, now: number): PresenceRow {
  const lastSeenAt = new Date(now - Math.max(0, user.staleForMs)).toISOString()
  const updatedAt = new Date(now - Math.max(0, user.activeForMs)).toISOString()

  const blank = {
    user_id: user.id,
    status: 'offline' as const,
    platform: null,
    channel: null,
    updated_at: updatedAt,
    last_seen_at: lastSeenAt,
  }

  if (user.visibility === 'invisible' || user.activity === 'offline') return blank

  // hide_activity keeps them online and drops where they are - so they read as
  // "around on Twitch", which is the point of the setting.
  const hidden = user.visibility === 'hide_activity'
  const watching = user.activity === 'watching' && user.channel.trim() !== ''

  return {
    ...blank,
    status: 'online',
    platform: hidden ? null : 'twitch',
    channel: hidden || !watching ? null : canonicalChannel(user.channel),
  }
}

/** What the channel is called for lookups. Production lowercases at the URL. */
export function canonicalChannel(channel: string): string {
  return channel.trim().toLowerCase()
}

/**
 * Display spellings the observer's browser could plausibly have learned.
 *
 * The worker learns these from page titles and stores login -> display. The lab
 * offers the casing the developer typed, filtered through the SAME predicate
 * production uses, so a "display name" that is a different word is refused here
 * exactly as it is refused there.
 */
export function channelNames(world: SimWorld): Record<string, string> {
  const names: Record<string, string> = {}

  const offer = (raw: string | null) => {
    if (!raw) return
    const typed = raw.trim()
    const login = canonicalChannel(typed)
    if (!login || typed === login) return
    // First offer wins, so a world that spells one channel two ways still
    // resolves it one way - and the same way on every rebuild.
    if (names[login]) return
    if (isSameChannel(login, typed)) names[login] = typed
  }

  // The observer's own channel first, then everyone else in order, so a world
  // spelling one channel two ways resolves the same way every time it is built.
  offer(world.observer.channel)
  for (const user of world.users) {
    if (user.activity === 'watching') offer(user.channel)
  }

  return names
}

/** Everyone whose presence the observer is entitled to see: their friends. */
export function friendsOf(world: SimWorld): SimUser[] {
  return world.users.filter((user) => user.relationship === 'friend')
}

/**
 * Push lab time forward.
 *
 * Two things move, because two different mechanisms measure time:
 *
 *   - a client that has stopped beating falls further behind, so the real
 *     90-second staleness rule can be crossed without a fake clock;
 *   - the injected analytics clock advances, so exposure windows, gathering
 *     cooldowns and opportunity-key boundaries can be crossed the same way.
 *
 * A client that is still beating does not go stale, because in the real world
 * it would not: it keeps saying it is there. That is what `staleForMs > 0`
 * distinguishes.
 */
export function advance(world: SimWorld, ms: number): SimWorld {
  return {
    ...world,
    clockOffsetMs: world.clockOffsetMs + ms,
    users: world.users.map((user) => ({
      ...user,
      activeForMs: user.activeForMs + ms,
      staleForMs: user.staleForMs > 0 ? user.staleForMs + ms : 0,
    })),
  }
}

export function updateUser(world: SimWorld, id: string, patch: Partial<SimUser>): SimWorld {
  return {
    ...world,
    users: world.users.map((user) => (user.id === id ? { ...user, ...patch } : user)),
  }
}
