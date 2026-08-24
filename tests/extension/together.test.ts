import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COMBO_WINDOW_MS,
  MAX_REACTIONS,
  REACTIONS,
  REACTION_TTL_MS,
  isCombo,
  isReaction,
  liveReactions,
  parseReaction,
  pruneReactions,
  reactionBursts,
  withReaction,
} from '../../src/core/together'
import type { Reaction, TogetherReaction } from '../../src/core/together'
import { createTogetherReactions } from '../../src/background/togetherReactions'
import { socialGravity } from '../../src/core/socialGravity'
import type { Activity, Presence } from '../../src/core/types'

/**
 * Automatic Together.
 *
 * Two claims are being defended, and they are the whole feature.
 *
 * The first is that a Together is DERIVED, not created. There is no room
 * record, no membership and no lifecycle - so the participants must come from
 * the same `here` cluster the panel already draws, and everything presence
 * knows about staleness, privacy and multiple tabs must apply without being
 * restated.
 *
 * The second is that CHANNEL IS CONTEXT AND FRIENDSHIP IS AUTHORIZATION. Being
 * on the same Twitch stream as forty thousand strangers must not put you in a
 * social space with them.
 */

const NOW = 1_700_000_000_000

const reaction = (over: Partial<TogetherReaction> = {}): TogetherReaction => ({
  id: `r${Math.round(over.at ?? NOW)}-${over.userId ?? 'jake'}`,
  userId: 'jake',
  channel: 'lirik',
  reaction: '😂',
  at: NOW,
  ...over,
})

const watching = (userId: string, channel: string, lastSeenAt = Date.now()): Presence => ({
  userId,
  status: 'online',
  activity: { type: 'watching', platform: 'twitch', channel },
  since: NOW - 60_000,
  lastSeenAt,
})

// --------------------------------------------------- derived, never created

describe('a Together is derived from presence, not created', () => {
  const person = (id: string, presence: Presence | null) => ({
    member: id,
    userId: id,
    presence,
  })

  const here = (localChannel: string | null, people: ReturnType<typeof person>[]) => {
    const local: Activity = localChannel
      ? { type: 'watching', platform: 'twitch', channel: localChannel }
      : { type: 'idle' }
    return socialGravity(people, local, Date.now(), 'me').find(
      (section) => section.kind === 'here',
    )
  }

  it('forms the moment the viewer arrives where friends already are', () => {
    const people = [person('jake', watching('jake', 'lvndmark')), person('matt', watching('matt', 'lvndmark'))]

    // Before: a destination to go to, no Together.
    expect(here(null, people)).toBeUndefined()

    // After: the same people, the same presence, no room created.
    const together = here('lvndmark', people)
    expect(together?.channel).toBe('lvndmark')
    expect(together?.count).toBe(2)
    expect(together?.friends).toEqual(['jake', 'matt'])
  })

  it('is keyed by canonical login, whatever casing anyone reports', () => {
    const together = here('LVNDMARK', [person('jake', watching('jake', 'lvndmark'))])
    expect(together?.channel).toBe('lvndmark')
  })

  it('never counts the viewer as somebody they are with', () => {
    const together = here('lirik', [
      person('me', watching('me', 'lirik')),
      person('jake', watching('jake', 'lirik')),
    ])
    expect(together?.count).toBe(1)
  })

  it('loses a friend whose client went quiet, with no departure message', () => {
    // The 90-second staleness rule, inherited rather than restated.
    const together = here('lirik', [
      person('jake', watching('jake', 'lirik')),
      person('matt', watching('matt', 'lirik', Date.now() - 120_000)),
    ])
    expect(together?.count).toBe(1)
  })

  it('excludes somebody who is hiding their activity', () => {
    /*
     * Presence is redacted at WRITE time, so a friend who hides has no channel
     * at all by the time anyone reads it - they are online, and not here.
     */
    const hiding: Presence = {
      userId: 'matt',
      status: 'online',
      activity: { type: 'browsing', platform: 'twitch' },
      since: NOW,
      lastSeenAt: Date.now(),
    }
    const together = here('lirik', [person('jake', watching('jake', 'lirik')), person('matt', hiding)])
    expect(together?.count).toBe(1)
  })

  it('dissolves when the viewer leaves, with nothing to clean up', () => {
    const people = [person('jake', watching('jake', 'lirik'))]
    expect(here('lirik', people)?.count).toBe(1)
    // Moved to another stream: the old Together simply is not a fact any more.
    expect(here('xqc', people)).toBeUndefined()
  })
})

// -------------------------------------------------------------- reactions

describe('reactions are a closed set', () => {
  it('accepts only the five', () => {
    for (const value of REACTIONS) expect(isReaction(value)).toBe(true)
    for (const bad of ['💀', '<img>', '', 'lirik', null, 7, '😂😂']) {
      expect(isReaction(bad)).toBe(false)
    }
  })

  it('is the same set the database enforces', () => {
    /*
     * Written twice on purpose - the server cannot trust the client's idea of
     * the rules - so this asserts the two agree. A palette that drifted would
     * mean a button that silently fails, or a symbol the UI cannot draw.
     */
    const migration = readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '0019_automatic_together.sql'),
      'utf8',
    )
    const inSql = migration.slice(
      migration.indexOf('p_reaction not in ('),
      migration.indexOf(')', migration.indexOf('p_reaction not in (')),
    )
    for (const value of REACTIONS) expect(inSql).toContain(value)
    // And nothing extra: the same count of quoted values.
    expect((inSql.match(/'/g) ?? []).length / 2).toBe(REACTIONS.length)
  })
})

describe('reading a reaction row', () => {
  it('accepts a well-formed one', () => {
    const parsed = parseReaction({
      id: 'abc',
      user_id: 'jake',
      channel: 'lirik',
      reaction: '🔥',
      created_at: new Date(NOW).toISOString(),
    })
    expect(parsed).toEqual({ id: 'abc', userId: 'jake', channel: 'lirik', reaction: '🔥', at: NOW })
  })

  it('drops anything it cannot render', () => {
    const base = { id: 'a', user_id: 'jake', channel: 'lirik', reaction: '🔥' }
    expect(parseReaction({ ...base, reaction: '<script>' })).toBeNull()
    expect(parseReaction({ ...base, channel: 'NOT A CHANNEL' })).toBeNull()
    expect(parseReaction({ ...base, user_id: 42 })).toBeNull()
    expect(parseReaction(null)).toBeNull()
    expect(parseReaction('🔥')).toBeNull()
  })
})

describe('what a combo is', () => {
  it('needs two different people', () => {
    const bursts = reactionBursts([
      reaction({ userId: 'jake', at: NOW }),
      reaction({ userId: 'matt', at: NOW + 500 }),
    ])
    expect(bursts).toHaveLength(1)
    expect(bursts[0].count).toBe(2)
    expect(isCombo(bursts[0])).toBe(true)
  })

  it('is not one person pressing a button repeatedly', () => {
    /*
     * The rule that keeps this from being a clicker game - and it needs no
     * points, streaks or leaderboard to enforce, because enthusiasm simply is
     * not a second voice.
     */
    const bursts = reactionBursts([
      reaction({ userId: 'jake', at: NOW }),
      reaction({ userId: 'jake', at: NOW + 200 }),
      reaction({ userId: 'jake', at: NOW + 400 }),
    ])
    expect(bursts).toHaveLength(1)
    expect(bursts[0].count).toBe(1)
    expect(isCombo(bursts[0])).toBe(false)
  })

  it('grows past three', () => {
    const bursts = reactionBursts(
      ['jake', 'matt', 'chris', 'dana'].map((userId, index) =>
        reaction({ userId, at: NOW + index * 300 }),
      ),
    )
    expect(bursts[0].count).toBe(4)
  })

  it('lets a different reaction start its own run rather than breaking one', () => {
    // Joining in with something else is participation, not interruption.
    const bursts = reactionBursts([
      reaction({ userId: 'jake', reaction: '😂', at: NOW }),
      reaction({ userId: 'matt', reaction: '❤️', at: NOW + 100 }),
      reaction({ userId: 'chris', reaction: '😂', at: NOW + 200 }),
    ])
    expect(bursts.map((burst) => burst.reaction)).toEqual(['😂', '❤️', '😂'])
    expect(bursts.every((burst) => burst.count === 1)).toBe(true)
  })

  it('does not join two moments that were not the same moment', () => {
    const bursts = reactionBursts([
      reaction({ userId: 'jake', at: NOW }),
      reaction({ userId: 'matt', at: NOW + COMBO_WINDOW_MS + 1 }),
    ])
    expect(bursts).toHaveLength(2)
  })

  it('keeps a burst alive while people are still reacting', () => {
    // A repeat from somebody already in the run refreshes it, so it does not
    // fade while the moment is still going.
    const bursts = reactionBursts([
      reaction({ userId: 'jake', at: NOW }),
      reaction({ userId: 'matt', at: NOW + 100 }),
      reaction({ userId: 'jake', at: NOW + 3_000 }),
    ])
    expect(bursts).toHaveLength(1)
    expect(bursts[0].count).toBe(2)
    expect(bursts[0].at).toBe(NOW + 3_000)
  })
})

describe('reactions are ephemeral', () => {
  it('stops showing one that has aged out', () => {
    const reactions = [reaction({ at: NOW - REACTION_TTL_MS - 1 }), reaction({ at: NOW - 1_000 })]
    expect(liveReactions(reactions, 'lirik', NOW)).toHaveLength(1)
    expect(pruneReactions(reactions, NOW)).toHaveLength(1)
  })

  it('shows nothing at all when the viewer is not on a channel', () => {
    expect(liveReactions([reaction()], null, NOW)).toEqual([])
  })

  it('never shows one from another channel', () => {
    expect(liveReactions([reaction({ channel: 'xqc' })], 'lirik', NOW)).toEqual([])
  })

  it('keeps the buffer bounded and free of duplicates', () => {
    // Realtime can redeliver, and a worker that is meant to be evicted cheaply
    // must not grow a list forever.
    let buffer: TogetherReaction[] = []
    for (let index = 0; index < MAX_REACTIONS + 20; index += 1) {
      buffer = withReaction(buffer, reaction({ at: NOW + index, userId: `u${index}` }))
    }
    expect(buffer).toHaveLength(MAX_REACTIONS)

    const once = withReaction(buffer, buffer[0])
    expect(once).toHaveLength(MAX_REACTIONS)
  })
})

// ------------------------------------------------------- the worker service

describe('the worker follows the viewer and nobody else', () => {
  function service() {
    const opened: string[] = []
    const closed: string[] = []
    const sent: Array<{ channel: string; reaction: Reaction }> = []
    let deliver: ((row: unknown) => void) | null = null

    const handle = createTogetherReactions({
      channel: {
        async open(channel, handlers) {
          opened.push(channel)
          deliver = handlers.onReaction
          return () => closed.push(channel)
        },
      },
      backend: {
        async send(channel, value) {
          sent.push({ channel, reaction: value })
        },
      },
      now: () => NOW,
    })

    return { handle, opened, closed, sent, deliver: (row: unknown) => deliver?.(row) }
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  const row = (over: Record<string, unknown> = {}) => ({
    id: `row-${Math.random()}`,
    user_id: 'jake',
    channel: 'lirik',
    reaction: '😂',
    created_at: new Date(NOW).toISOString(),
    ...over,
  })

  it('opens exactly one subscription, for where the viewer is', async () => {
    const { handle, opened } = service()
    handle.setChannel('lirik')
    await settle()
    expect(opened).toEqual(['lirik'])
    expect(handle.channel()).toBe('lirik')
  })

  it('does not re-subscribe when told the same channel again', async () => {
    const { handle, opened } = service()
    handle.setChannel('lirik')
    await settle()
    for (let i = 0; i < 10; i += 1) handle.setChannel('LIRIK')
    await settle()
    expect(opened).toEqual(['lirik'])
  })

  it('closes the old one when the viewer moves, and drops its reactions', async () => {
    const { handle, opened, closed, deliver } = service()
    handle.setChannel('lirik')
    await settle()
    deliver(row())
    expect(handle.snapshot()).toHaveLength(1)

    handle.setChannel('xqc')
    await settle()

    expect(closed).toEqual(['lirik'])
    expect(opened).toEqual(['lirik', 'xqc'])
    // Reactions are about what just happened on THIS stream.
    expect(handle.snapshot()).toEqual([])
  })

  it('subscribes to nothing when the viewer is not on a channel', async () => {
    const { handle, opened, closed } = service()
    handle.setChannel('lirik')
    await settle()
    handle.setChannel(null)
    await settle()
    expect(closed).toEqual(['lirik'])
    expect(opened).toEqual(['lirik'])
    expect(handle.channel()).toBeNull()
  })

  it('ignores a row that arrives for a channel it has already left', async () => {
    const { handle, deliver } = service()
    handle.setChannel('lirik')
    await settle()
    handle.setChannel('xqc')
    await settle()

    deliver(row({ channel: 'lirik' }))
    expect(handle.snapshot()).toEqual([])
  })

  it('drops a malformed row rather than storing it', async () => {
    const { handle, deliver } = service()
    handle.setChannel('lirik')
    await settle()

    deliver(row({ reaction: '<script>alert(1)</script>' }))
    deliver(row({ user_id: null }))
    deliver('not a row')
    expect(handle.snapshot()).toEqual([])
  })

  it('sends on the channel the worker knows about, not one it was told', async () => {
    // The panel has no channel argument, so there is no way to react somewhere
    // the viewer is not.
    const { handle, sent } = service()
    handle.setChannel('lirik')
    await settle()
    handle.send('🔥')
    await settle()
    expect(sent).toEqual([{ channel: 'lirik', reaction: '🔥' }])
  })

  it('sends nothing when the viewer is nowhere', async () => {
    const { handle, sent } = service()
    handle.send('🔥')
    await settle()
    expect(sent).toEqual([])
  })

  it('forgets everything on sign-out', async () => {
    const { handle, closed, deliver } = service()
    handle.setChannel('lirik')
    await settle()
    deliver(row())

    handle.reset()
    expect(closed).toEqual(['lirik'])
    expect(handle.snapshot()).toEqual([])
    expect(handle.channel()).toBeNull()
  })

  it('survives realtime being unavailable', async () => {
    // Presence still works, so the surface still shows who is here - it simply
    // has no reactions in it.
    const errors: string[] = []
    const handle = createTogetherReactions({
      channel: {
        async open() {
          throw new Error('realtime down')
        },
      },
      backend: { async send() {} },
      onError: (context) => errors.push(context),
      now: () => NOW,
    })

    handle.setChannel('lirik')
    await settle()
    expect(errors).toContain('together.subscribe')
    expect(handle.snapshot()).toEqual([])
    expect(handle.channel()).toBe('lirik')
  })

  it('never surfaces a failed send', async () => {
    const errors: string[] = []
    const handle = createTogetherReactions({
      channel: {
        async open() {
          return () => {}
        },
      },
      backend: {
        async send() {
          throw new Error('rate limited')
        },
      },
      onError: (context) => errors.push(context),
      now: () => NOW,
    })

    handle.setChannel('lirik')
    await settle()
    expect(() => handle.send('😂')).not.toThrow()
    await settle()
    expect(errors).toContain('together.send')
    // Nothing was drawn optimistically, so nothing has to be taken back.
    expect(handle.snapshot()).toEqual([])
  })
})

// ------------------------------------------------------- security and privacy

describe('channel is context, friendship is authorization', () => {
  const migration = readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '0019_automatic_together.sql'),
    'utf8',
  )

  it('delivers only to the sender and their friends', () => {
    /*
     * The whole privacy model. A↔B and C↔D all watching LIRIK: A sees B,
     * because is_friend is evaluated AS A. Nothing is filtered client-side,
     * which matters - a client-side privacy filter is one the attacker
     * controls.
     */
    expect(migration).toContain('create policy together_reactions_select on public.together_reactions')
    expect(migration).toContain('using (user_id = (select auth.uid()) or public.is_friend(user_id))')
  })

  it('does not leak friend-of-friend activity', () => {
    // is_friend is direct, and the policy asks nothing else. A sees C only if
    // A and C are actually friends.
    // The policy STATEMENT, not the rest of the file - the realtime guard
    // further down contains an `if not exists`, which is not this.
    const at = migration.indexOf('create policy together_reactions_select')
    const policy = migration.slice(at, migration.indexOf(';', at))
    expect(policy).not.toContain('friend_of')
    expect(policy).not.toMatch(/exists\s*\(/i)
  })

  it('lets clients read but never write', () => {
    expect(migration).toContain('revoke all on public.together_reactions from anon, authenticated')
    expect(migration).toContain('grant select on public.together_reactions to authenticated')
    // Writes go through the RPC, which takes no sender.
    expect(migration).toContain('grant execute on function public.send_together_reaction(text, text) to authenticated')
  })

  it('takes the sender from the JWT, so nobody can react as anyone else', () => {
    expect(migration).toContain('v_actor   uuid := public.require_actor()')
    expect(migration).not.toMatch(/p_user|p_actor|p_sender/)
  })

  it('validates the channel before it becomes a row', () => {
    expect(migration).toContain(`v_channel !~ '^[a-z0-9_]{3,25}$'`)
    expect(migration).toContain(`check (channel ~ '^[a-z0-9_]{3,25}$')`)
  })

  it('bounds how fast one person may react', () => {
    expect(migration).toContain(`consume_rate_budget('together_reaction'`)
  })

  it('keeps nothing worth keeping', () => {
    // A transport, not a history: every insert sweeps the channel, and there
    // is no reader anywhere that returns old rows.
    expect(migration).toContain('delete from public.together_reactions')
    expect(migration).toContain(`created_at < now() - interval '1 minute'`)
  })

  it('records that an interaction happened, never what it was', () => {
    const contract = readFileSync(join(process.cwd(), 'src', 'core', 'analytics.ts'), 'utf8')
    const together = contract.slice(
      contract.indexOf('together_surface_shown: ['),
      contract.indexOf('join_clicked: ['),
    )
    for (const forbidden of ['reaction:', 'emoji', 'emote', 'content']) {
      expect(together).not.toContain(forbidden)
    }
    expect(together).toContain('participant_count')
    expect(together).toContain('combo_size')
  })
})

describe('Automatic Together is not a room', () => {
  const migration = readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '0019_automatic_together.sql'),
    'utf8',
  )

  it('creates no room, membership or ownership of any kind', () => {
    /*
     * The architectural claim. Persistent Groups already exist and stay
     * exactly as they were; this adds one table for one kind of event, and
     * nothing that has to be created, joined, left or deleted.
     */
    const tables = [...migration.matchAll(/create table if not exists (\S+)/g)].map((m) => m[1])
    expect(tables).toEqual(['public.together_reactions'])
    expect(migration).not.toMatch(/together_rooms|room_members|together_members/)
  })

  it('leaves the existing Groups tables untouched', () => {
    expect(migration).not.toContain('public.groups')
    expect(migration).not.toContain('public.group_members')
    expect(migration).not.toContain('public.group_messages')
  })

  it('adds no text of any kind', () => {
    // Reactions are a fixed palette. There is no body column and no place for
    // one to arrive.
    expect(migration).not.toMatch(/\bbody\b/)
    expect(migration).not.toMatch(/\bmessage\b/)
  })
})
