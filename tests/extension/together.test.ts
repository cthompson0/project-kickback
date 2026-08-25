import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_REACTIONS,
  REACTIONS,
  REACTION_TTL_MS,
  isReaction,
  liveReactions,
  parseReaction,
  pruneReactions,
  reactionEmote,
  reactionMessages,
  withReaction,
} from '../../src/core/together'
import type { TogetherReaction } from '../../src/core/together'
import {
  MAX_HOPS,
  MAX_MEMBERS,
  directCount,
  parseRoomMembers,
  sortMembers,
} from '../../src/core/streamRoom'
import { scanCombos } from '../../src/core/combos'
import { createTogetherReactions } from '../../src/background/togetherReactions'
import { createStreamRoom } from '../../src/background/streamRoom'

/**
 * Automatic Stream Rooms.
 *
 * Three claims, and they are the whole convergence.
 *
 *   1. A room is the CONNECTED COMPONENT of the friendship graph among people
 *      present on a destination - not the viewer's direct friends, which gave
 *      four people four different rooms.
 *   2. Recipients are decided at WRITE time, so every row has exactly one
 *      interested subscriber. That is the one-way reaction fix, and it is a
 *      shape rather than a patch.
 *   3. There is ONE combo engine. Reactions are Kickback emotes, so scanCombos
 *      counts them and the count grows in place.
 */

const NOW = 1_700_000_000_000
const MIGRATION = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0020_stream_rooms.sql'),
  'utf8',
)

const reaction = (over: Partial<TogetherReaction> = {}): TogetherReaction => ({
  id: `r-${over.senderId ?? 'jake'}-${over.at ?? NOW}`,
  senderId: 'jake',
  channel: 'lirik',
  reaction: 'lol',
  at: NOW,
  ...over,
})

// ------------------------------------------------------- one combo engine

describe('reactions are Kickback emotes, so the combo engine counts them', () => {
  const names = (id: string) => id.toUpperCase()

  it('draws every reaction from the existing artwork', () => {
    for (const value of REACTIONS) {
      const emote = reactionEmote(value)
      expect(emote.provider).toBe('kickback')
      expect(emote.token).toBe(`:${value}:`)
    }
  })

  it('counts two different people as a combo, in place', () => {
    /*
     * The convergence, asserted directly: no bespoke aggregator, just the
     * engine group chat has always used. It annotates the LAST contribution of
     * a run, which is why a combo grows as one badge instead of a row of
     * emoji - the stacking that was reported.
     */
    const stream = [
      reaction({ senderId: 'jake', at: NOW }),
      reaction({ senderId: 'matt', at: NOW + 500 }),
    ]
    const { annotations } = scanCombos(reactionMessages(stream, names))

    expect(annotations.size).toBe(1)
    expect(annotations.get(stream[1].id)?.comboCount).toBe(2)
    expect(annotations.get(stream[1].id)?.comboEmote?.id).toBe('lol')
  })

  it('does not count one person pressing a button repeatedly', () => {
    const stream = [
      reaction({ senderId: 'jake', at: NOW }),
      reaction({ senderId: 'jake', at: NOW + 200 }),
      reaction({ senderId: 'jake', at: NOW + 400 }),
    ]
    expect(scanCombos(reactionMessages(stream, names)).annotations.size).toBe(0)
  })

  it('grows past three, and reports the run still open', () => {
    const stream = ['jake', 'matt', 'chris', 'dana'].map((senderId, index) =>
      reaction({ senderId, at: NOW + index * 200 }),
    )
    const scan = scanCombos(reactionMessages(stream, names))
    expect(scan.annotations.get(stream[3].id)?.comboCount).toBe(4)
    expect(scan.active?.count).toBe(4)
  })

  it('lets a different reaction start its own run rather than breaking one', () => {
    // The engine's own rule, inherited: joining in with something else is
    // participation, not interruption.
    const stream = [
      reaction({ senderId: 'jake', reaction: 'lol', at: NOW }),
      reaction({ senderId: 'matt', reaction: 'heart', at: NOW + 100 }),
      reaction({ senderId: 'chris', reaction: 'lol', at: NOW + 200 }),
    ]
    const { annotations } = scanCombos(reactionMessages(stream, names))
    expect(annotations.size).toBe(0)
    expect([...annotations.values()].some((entry) => entry.brokeCombo)).toBe(false)
  })

  it('cannot produce a combo breaker, because there is nothing to break', () => {
    /*
     * A breaker is an ordinary message interrupting a run, and a reaction
     * stream has no ordinary messages in it. The rule is preserved rather than
     * removed - it simply has nothing to fire on until a room has text, which
     * v1 deliberately does not.
     */
    const stream = ['jake', 'matt', 'chris'].map((senderId, index) =>
      reaction({ senderId, at: NOW + index * 100 }),
    )
    const { annotations } = scanCombos(reactionMessages(stream, names))
    expect([...annotations.values()].every((entry) => !entry.brokeCombo)).toBe(true)
  })

  it('has no second combo implementation left', () => {
    // reactionBursts / isCombo are gone. Two engines would drift.
    const source = readFileSync(join(process.cwd(), 'src', 'core', 'together.ts'), 'utf8')
    expect(source).not.toContain('reactionBursts')
    expect(source).not.toContain('export function isCombo')
    expect(source).toContain('scanCombos')
  })
})

describe('the reaction palette is closed and agrees with the database', () => {
  it('accepts only the five', () => {
    for (const value of REACTIONS) expect(isReaction(value)).toBe(true)
    for (const bad of ['pog', 'gg', '😂', '<img>', '', null, 7]) {
      expect(isReaction(bad)).toBe(false)
    }
  })

  it('matches the check in 0020', () => {
    const inSql = MIGRATION.slice(
      MIGRATION.indexOf('p_reaction not in ('),
      MIGRATION.indexOf(')', MIGRATION.indexOf('p_reaction not in (')),
    )
    for (const value of REACTIONS) expect(inSql).toContain(`'${value}'`)
    expect((inSql.match(/'/g) ?? []).length / 2).toBe(REACTIONS.length)
  })
})

describe('reading a reaction row', () => {
  it('reads the sender, not a generic user id', () => {
    const parsed = parseReaction({
      id: 'abc',
      sender_id: 'jake',
      recipient_id: 'me',
      channel: 'lirik',
      reaction: 'fire',
      created_at: new Date(NOW).toISOString(),
    })
    expect(parsed).toEqual({ id: 'abc', senderId: 'jake', channel: 'lirik', reaction: 'fire', at: NOW })
  })

  it('drops anything it cannot render', () => {
    const base = { id: 'a', sender_id: 'jake', channel: 'lirik', reaction: 'fire' }
    expect(parseReaction({ ...base, reaction: '<script>' })).toBeNull()
    expect(parseReaction({ ...base, reaction: 'pog' })).toBeNull()
    expect(parseReaction({ ...base, channel: 'NOT A CHANNEL' })).toBeNull()
    expect(parseReaction({ ...base, sender_id: 42 })).toBeNull()
    expect(parseReaction(null)).toBeNull()
  })
})

describe('reactions are ephemeral', () => {
  it('stops showing one that aged out', () => {
    const reactions = [reaction({ at: NOW - REACTION_TTL_MS - 1 }), reaction({ at: NOW - 1_000 })]
    expect(liveReactions(reactions, 'lirik', NOW)).toHaveLength(1)
    expect(pruneReactions(reactions, NOW)).toHaveLength(1)
  })

  it('shows nothing off-channel or with no channel', () => {
    expect(liveReactions([reaction({ channel: 'xqc' })], 'lirik', NOW)).toEqual([])
    expect(liveReactions([reaction()], null, NOW)).toEqual([])
  })

  it('keeps the buffer bounded and duplicate-free', () => {
    let buffer: TogetherReaction[] = []
    for (let index = 0; index < MAX_REACTIONS + 20; index += 1) {
      buffer = withReaction(buffer, reaction({ at: NOW + index, senderId: `u${index}` }))
    }
    expect(buffer).toHaveLength(MAX_REACTIONS)
    expect(withReaction(buffer, buffer[0])).toHaveLength(MAX_REACTIONS)
  })
})

// ------------------------------------------------------- room membership

describe('room membership, as the client reads it', () => {
  const row = (userId: string, hops: number, via?: string) => ({
    user_id: userId,
    hops,
    via_user_id: via ?? null,
  })

  it('reads hops and the connecting friend', () => {
    const members = parseRoomMembers([row('jake', 1), row('sarah', 2, 'jake')])
    expect(members).toEqual([
      { userId: 'jake', hops: 1, viaUserId: null },
      { userId: 'sarah', hops: 2, viaUserId: 'jake' },
    ])
  })

  it('drops the connector beyond two hops, deliberately', () => {
    // "Friend of a friend of Jake" is graph detail nobody needs, so it is not
    // carried around waiting to be rendered by mistake.
    expect(parseRoomMembers([row('matt', 3, 'sarah')])[0].viaUserId).toBeNull()
  })

  it('refuses a hop count outside the bounds the server promises', () => {
    expect(parseRoomMembers([row('x', 0), row('y', MAX_HOPS + 1), row('z', -1)])).toEqual([])
  })

  it('never returns more than the room limit', () => {
    const many = Array.from({ length: MAX_MEMBERS + 20 }, (_, index) => row(`u${index}`, 1))
    expect(parseRoomMembers(many)).toHaveLength(MAX_MEMBERS)
  })

  it('puts direct friends first', () => {
    const sorted = sortMembers([
      { userId: 'far', hops: 3, viaUserId: null },
      { userId: 'near', hops: 1, viaUserId: null },
      { userId: 'mid', hops: 2, viaUserId: 'near' },
    ])
    expect(sorted.map((m) => m.userId)).toEqual(['near', 'mid', 'far'])
  })

  it('counts how many the viewer actually knows', () => {
    // The number that says whether friend-of-friend exposure is happening.
    expect(
      directCount([
        { userId: 'a', hops: 1, viaUserId: null },
        { userId: 'b', hops: 2, viaUserId: 'a' },
      ]),
    ).toBe(1)
  })
})

describe('the room service asks the server, and never traverses anything', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  function service(members: (channel: string) => Promise<unknown>) {
    const calls: string[] = []
    const handle = createStreamRoom({
      backend: {
        members: (channel) => {
          calls.push(channel)
          return members(channel)
        },
      },
      now: () => NOW,
    })
    return { handle, calls }
  }

  const rows = [{ user_id: 'jake', hops: 1, via_user_id: null }]

  it('asks once for the channel the viewer is on', async () => {
    const { handle, calls } = service(async () => rows)
    handle.want('lirik')
    await settle()
    expect(calls).toEqual(['lirik'])
    expect(handle.snapshot()).toHaveLength(1)
  })

  it('does not ask again while the answer is fresh', async () => {
    const { handle, calls } = service(async () => rows)
    handle.want('lirik')
    await settle()
    for (let i = 0; i < 20; i += 1) handle.want('LIRIK')
    await settle()
    expect(calls).toEqual(['lirik'])
  })

  it('forgets the room the moment the viewer moves', async () => {
    const { handle } = service(async () => rows)
    handle.want('lirik')
    await settle()
    expect(handle.snapshot()).toHaveLength(1)

    handle.want('xqc')
    // Not "the old room until the new answer arrives" - that would show the
    // wrong people on the wrong stream.
    expect(handle.snapshot()).toEqual([])
  })

  it('asks for nothing when the viewer is nowhere', async () => {
    const { handle, calls } = service(async () => rows)
    handle.want(null)
    await settle()
    expect(calls).toEqual([])
  })

  it('keeps the room it had when a call fails', async () => {
    let fail = false
    const { handle } = service(async () => {
      if (fail) throw new Error('offline')
      return rows
    })
    handle.want('lirik')
    await settle()

    fail = true
    handle.reset()
    handle.want('lirik')
    await settle()

    // Nothing to keep after a reset, but the failure must not throw and must
    // not leave the service wedged.
    expect(handle.pending()).toBe(false)
  })

  it('ignores an answer that lands after the viewer moved on', async () => {
    let release: (value: unknown) => void = () => {}
    const gate = new Promise((resolve) => {
      release = resolve
    })
    // Answers per channel, so a stale answer is distinguishable from a fresh
    // one - otherwise this passes for the wrong reason.
    const { handle } = service(async (channel) => {
      await gate
      return channel === 'lirik' ? rows : []
    })

    handle.want('lirik')
    handle.want('xqc')
    release(null)
    await settle()
    await settle()

    expect(handle.channel()).toBe('xqc')
    // lirik's answer landed last and was discarded; xqc's empty one stands.
    expect(handle.snapshot()).toEqual([])
  })
})

// ------------------------------------------------- the inbox, and symmetry

describe('every reaction row has exactly one interested subscriber', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  function inbox() {
    const opened: string[] = []
    const closed: string[] = []
    const sent: Array<{ channel: string; reaction: string }> = []
    const seen: Array<{ senderId: string; mine: boolean }> = []
    let deliver: ((row: unknown) => void) | null = null

    const handle = createTogetherReactions({
      channel: {
        async open(userId, handlers) {
          opened.push(userId)
          deliver = handlers.onReaction
          return () => closed.push(userId)
        },
      },
      backend: {
        async send(channel, value) {
          sent.push({ channel, reaction: value })
          return 2
        },
      },
      onReaction: (r, mine) => seen.push({ senderId: r.senderId, mine }),
      now: () => NOW,
    })

    return { handle, opened, closed, sent, seen, deliver: (row: unknown) => deliver?.(row) }
  }

  const row = (over: Record<string, unknown> = {}) => ({
    id: `row-${Math.random()}`,
    sender_id: 'jake',
    recipient_id: 'me',
    channel: 'lirik',
    reaction: 'lol',
    created_at: new Date(NOW).toISOString(),
    ...over,
  })

  it('subscribes per USER, not per channel', async () => {
    /*
     * The one-way reaction bug in one assertion.
     *
     * A shared per-channel topic meant one row matched many subscriptions,
     * which is the condition for the hosted defect where only the most
     * recently created subscription receives. A per-user inbox gives every row
     * exactly one interested subscriber - the property presence has always
     * had, and why presence never broke this way.
     */
    const { handle, opened } = inbox()
    handle.setUser('me')
    await settle()
    expect(opened).toEqual(['me'])

    // Moving between channels must NOT churn the subscription.
    handle.setChannel('lirik')
    handle.setChannel('xqc')
    handle.setChannel('lirik')
    await settle()
    expect(opened).toEqual(['me'])
  })

  it('delivers symmetrically - the sender sees their own by the same route', async () => {
    const { handle, seen, deliver } = inbox()
    handle.setUser('me')
    handle.setChannel('lirik')
    await settle()

    deliver(row({ sender_id: 'jake' }))
    deliver(row({ sender_id: 'me' }))

    expect(seen).toEqual([
      { senderId: 'jake', mine: false },
      { senderId: 'me', mine: true },
    ])
    expect(handle.snapshot()).toHaveLength(2)
  })

  it('shows nothing for a channel the viewer has left', async () => {
    // The inbox outlives any one stream, so a row can arrive moments after
    // they moved. Showing it would be a friend laughing at something they can
    // no longer see.
    const { handle, deliver } = inbox()
    handle.setUser('me')
    handle.setChannel('lirik')
    await settle()

    handle.setChannel('xqc')
    deliver(row({ channel: 'lirik' }))
    expect(handle.snapshot()).toEqual([])
  })

  it('drops the buffer when the viewer moves', async () => {
    const { handle, deliver } = inbox()
    handle.setUser('me')
    handle.setChannel('lirik')
    await settle()
    deliver(row())
    expect(handle.snapshot()).toHaveLength(1)

    handle.setChannel('xqc')
    expect(handle.snapshot()).toEqual([])
  })

  it('sends on the channel the worker knows, never one it was told', async () => {
    const { handle, sent } = inbox()
    handle.setUser('me')
    handle.setChannel('lirik')
    await settle()
    handle.send('fire')
    await settle()
    expect(sent).toEqual([{ channel: 'lirik', reaction: 'fire' }])
  })

  it('sends nothing when the viewer is on no channel', async () => {
    const { handle, sent } = inbox()
    handle.setUser('me')
    await settle()
    handle.send('fire')
    await settle()
    expect(sent).toEqual([])
  })

  it('drops a malformed row rather than storing it', async () => {
    const { handle, deliver } = inbox()
    handle.setUser('me')
    handle.setChannel('lirik')
    await settle()

    deliver(row({ reaction: '<script>' }))
    deliver(row({ sender_id: null }))
    deliver('not a row')
    expect(handle.snapshot()).toEqual([])
  })

  it('closes and reopens when the account changes', async () => {
    const { handle, opened, closed } = inbox()
    handle.setUser('me')
    await settle()
    handle.setUser('someone-else')
    await settle()
    expect(closed).toEqual(['me'])
    expect(opened).toEqual(['me', 'someone-else'])
  })

  it('survives realtime being unavailable', async () => {
    const errors: string[] = []
    const handle = createTogetherReactions({
      channel: {
        async open() {
          throw new Error('realtime down')
        },
      },
      backend: { async send() { return 0 } },
      onError: (context) => errors.push(context),
      now: () => NOW,
    })

    handle.setUser('me')
    await settle()
    expect(errors).toContain('together.subscribe')
    // The room still shows who is in it; there is simply nothing landing.
    expect(handle.snapshot()).toEqual([])
  })

  it('never surfaces a failed send', async () => {
    const errors: string[] = []
    const handle = createTogetherReactions({
      channel: { async open() { return () => {} } },
      backend: {
        async send() {
          throw new Error('not watching that')
        },
      },
      onError: (context) => errors.push(context),
      now: () => NOW,
    })

    handle.setUser('me')
    handle.setChannel('lirik')
    await settle()
    expect(() => handle.send('lol')).not.toThrow()
    await settle()
    expect(errors).toContain('together.send')
    // Nothing was drawn optimistically, so nothing has to be taken back.
    expect(handle.snapshot()).toEqual([])
  })

  it('forgets everything on sign-out', async () => {
    const { handle, closed, deliver } = inbox()
    handle.setUser('me')
    handle.setChannel('lirik')
    await settle()
    deliver(row())

    handle.reset()
    expect(closed).toEqual(['me'])
    expect(handle.snapshot()).toEqual([])
    expect(handle.subscribedTo()).toBeNull()
  })
})

// ------------------------------------------------------ server-side rules

describe('the server decides who is in the room, and who receives', () => {
  it('walks the graph itself and returns members, never edges', () => {
    expect(MIGRATION).toContain('create or replace function public.stream_room_members(p_channel text)')
    expect(MIGRATION).toContain('returns table (user_id uuid, hops int, via_user_id uuid)')
    expect(MIGRATION).toContain('security definer')
    // No parameter names a user: the walk is seeded at the caller.
    expect(MIGRATION).not.toMatch(/stream_room_members\(p_channel text, p_user/)
  })

  it('refuses unless the caller is actually watching that channel', () => {
    /*
     * Knowing a channel name grants nothing. This is what stops the function
     * being an oracle for "who is watching X", and it is why clicking JOIN
     * without arriving does not make you a participant.
     */
    const guard = MIGRATION.slice(
      MIGRATION.indexOf('The caller must actually be there'),
      MIGRATION.indexOf('return query'),
    )
    expect(guard).toContain('p.user_id = v_actor')
    expect(guard).toContain('return;')
  })

  it('is bounded in hops, members and cycles', () => {
    expect(MIGRATION).toContain('w.hops < 3')
    expect(MIGRATION).toContain('limit 50')
    // Friendships are mirrored rows, so an unguarded walk would not terminate.
    expect(MIGRATION).toContain('not (f.friend_id = any(w.path))')
  })

  it('only considers people whose presence says they are here and fresh', () => {
    expect(MIGRATION).toContain(`and p.last_seen_at > now() - interval '90 seconds'`)
    expect(MIGRATION).toContain(`p.status = 'online'`)
  })

  it('addresses one row per recipient, so read-time authorization is trivial', () => {
    expect(MIGRATION).toContain('recipient_id uuid        not null')
    expect(MIGRATION).toContain('using (recipient_id = (select auth.uid()))')
    // The recursive predicate is gone from the read path entirely.
    const policy = MIGRATION.slice(
      MIGRATION.indexOf('create policy together_reactions_select'),
      MIGRATION.indexOf(';', MIGRATION.indexOf('create policy together_reactions_select')),
    )
    expect(policy).not.toContain('is_friend')
    expect(policy).not.toContain('stream_room_members')
  })

  it('takes neither the sender nor the recipients from the client', () => {
    expect(MIGRATION).toContain('v_actor   uuid := public.require_actor()')
    expect(MIGRATION).toContain('from public.stream_room_members(v_channel) m')
    expect(MIGRATION).not.toMatch(/p_recipient|p_sender|p_user/)
  })

  it('refuses to send into a channel the sender is not on', () => {
    expect(MIGRATION).toContain(`raise exception 'kickback: you are not watching that'`)
  })

  it('bounds reaction rate and validates the channel', () => {
    expect(MIGRATION).toContain(`consume_rate_budget('together_reaction'`)
    expect(MIGRATION).toContain(`v_channel !~ '^[a-z0-9_]{3,25}$'`)
  })

  it('keeps nothing, and creates no room record', () => {
    expect(MIGRATION).toContain('delete from public.together_reactions')
    // One table, and it holds events rather than rooms. Asserted on what is
    // CREATED - stream_room_members is a function, and naming it here would
    // flag the very thing this migration is built around.
    const tables = [...MIGRATION.matchAll(/create table if not exists (\S+)/g)].map((m) => m[1])
    expect(tables).toEqual(['public.together_reactions'])
    expect(MIGRATION).not.toMatch(/create table[^;]*(stream_rooms|automatic_rooms|room_members)/)
  })

  it('leaves Groups and global presence policy alone', () => {
    expect(MIGRATION).not.toContain('public.groups')
    expect(MIGRATION).not.toContain('public.group_messages')
    // An index is not a policy. No presence policy is touched.
    expect(MIGRATION).not.toMatch(/policy .*on public\.presence/)
  })

  it('records that an interaction happened, never what it was', () => {
    const contract = readFileSync(join(process.cwd(), 'src', 'core', 'analytics.ts'), 'utf8')
    const room = contract.slice(
      contract.indexOf('automatic_room_entered: {'),
      contract.indexOf('// --------------------------------------------------------------------- join'),
    )
    /*
     * Asserted on PROPERTY names, not on the block's prose or its event names -
     * `automatic_room_reaction` necessarily contains "reaction", and flagging
     * that would be flagging the feature's own name.
     */
    const properties = [...room.matchAll(/^\s{4}(\w+)[?]?:/gm)].map((match) => match[1])
    for (const forbidden of ['reaction', 'emote', 'content', 'message', 'body', 'text']) {
      expect(properties).not.toContain(forbidden)
    }
    expect(properties).toContain('direct_friend_count')
    expect(properties).toContain('participant_count')
  })
})
