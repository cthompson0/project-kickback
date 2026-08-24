import { describe, expect, it } from 'vitest'
import { toPresence } from '../../src/background/supabaseBackend'
import { advance, canonicalChannel, channelNames, presenceRow } from '../../src/testlab/world'
import type { SimUser, SimWorld } from '../../src/testlab/world'
import { PRESETS, person, preset } from '../../src/testlab/presets'

/**
 * The one piece of server behaviour the Test Lab models.
 *
 * Everything else in the lab is production code, so the only thing that can
 * drift is this: the write-time redaction `report_presence` performs in
 * 0003_rpcs.sql. These tests pin it against the SQL, quoted in world.ts.
 */

const NOW = 1_700_000_000_000

const sim = (patch: Partial<SimUser> = {}): SimUser =>
  person(0, { activity: 'watching', channel: 'LIRIK', ...patch })

describe('presence rows, as the database would hold them', () => {
  it('gives a visible watcher their platform and channel', () => {
    const row = presenceRow(sim(), NOW)
    expect(row.status).toBe('online')
    expect(row.platform).toBe('twitch')
    expect(row.channel).toBe('lirik')
  })

  it('canonicalises the channel, exactly as the URL parser does', () => {
    // Production lowercases at parseChannelFromPath, so the database never
    // holds casing and neither does a simulated row.
    expect(presenceRow(sim({ channel: 'LVNDMARK' }), NOW).channel).toBe('lvndmark')
    expect(presenceRow(sim({ channel: '  xQc ' }), NOW).channel).toBe('xqc')
  })

  it('drops the destination for hide_activity but keeps them online', () => {
    // if v_mode = 'hide_activity' then v_platform := null; v_channel := null;
    const row = presenceRow(sim({ visibility: 'hide_activity' }), NOW)
    expect(row.status).toBe('online')
    expect(row.platform).toBeNull()
    expect(row.channel).toBeNull()
  })

  it('blanks the row entirely for invisible', () => {
    // update ... set status = 'offline', platform = null, channel = null
    const row = presenceRow(sim({ visibility: 'invisible' }), NOW)
    expect(row.status).toBe('offline')
    expect(row.platform).toBeNull()
    expect(row.channel).toBeNull()
  })

  it('leaves nothing to infer from an invisible watcher', () => {
    // A hidden row must be indistinguishable from a genuinely offline one, or
    // the difference is the leak.
    const hidden = presenceRow(sim({ visibility: 'invisible' }), NOW)
    const away = presenceRow(sim({ activity: 'offline' }), NOW)
    expect({ ...hidden, user_id: '' }).toEqual({ ...away, user_id: '' })
  })

  it('reads back as browsing once production maps it', () => {
    // The end-to-end consequence: hide_activity shows as "around on Twitch".
    const presence = toPresence(presenceRow(sim({ visibility: 'hide_activity' }), NOW))
    expect(presence.status).toBe('online')
    expect(presence.activity.type).toBe('browsing')
  })

  it('reports someone around as online with no channel', () => {
    const presence = toPresence(presenceRow(sim({ activity: 'around' }), NOW))
    expect(presence.activity.type).toBe('browsing')
  })

  it('stamps the heartbeat where the staleness rule will read it', () => {
    const fresh = presenceRow(sim(), NOW)
    const silent = presenceRow(sim({ staleForMs: 120_000 }), NOW)
    expect(Date.parse(fresh.last_seen_at)).toBe(NOW)
    expect(Date.parse(silent.last_seen_at)).toBe(NOW - 120_000)
  })
})

describe('display casing is offered, never invented', () => {
  const world = (users: SimUser[], observer: string | null = null): SimWorld => ({
    observer: {
      id: 'me',
      login: 'me',
      displayName: 'Me',
      channel: observer,
      visibility: 'visible',
    },
    users,
    clockOffsetMs: 0,
  })

  it('learns the casing a channel was typed with', () => {
    expect(channelNames(world([sim({ channel: 'LVNDMARK' })]))).toEqual({ lvndmark: 'LVNDMARK' })
  })

  it('offers nothing when the casing adds nothing', () => {
    expect(channelNames(world([sim({ channel: 'lirik' })]))).toEqual({})
  })

  it('resolves one channel the same way however many people are on it', () => {
    // Deterministic by construction: the map is keyed by login and holds one
    // value, so a cluster's size cannot change its spelling.
    const many = channelNames(
      world([sim({ channel: 'LVNDMARK' }), sim({ channel: 'lvndmark' }), sim({ channel: 'LvNdMaRk' })]),
    )
    expect(many).toEqual({ lvndmark: 'LVNDMARK' })
  })

  it(`lets the observer own channel win, because they are looking at it`, () => {
    const names = channelNames(world([sim({ channel: 'lvndmark' })], 'LVNDMARK'))
    expect(names.lvndmark).toBe('LVNDMARK')
  })

  it('ignores people who are not watching', () => {
    expect(channelNames(world([sim({ activity: 'around', channel: 'LIRIK' })]))).toEqual({})
  })
})

describe('advancing lab time', () => {
  const world: SimWorld = {
    observer: { id: 'me', login: 'me', displayName: 'Me', channel: null, visibility: 'visible' },
    users: [sim({ staleForMs: 0 }), { ...sim({ staleForMs: 1 }), id: 'sim-c' }],
    clockOffsetMs: 0,
  }

  it('leaves a beating client alone', () => {
    // A client that is still reporting does not go stale just because time
    // passed - in the real world it would keep saying it is there.
    expect(advance(world, 90_000).users[0].staleForMs).toBe(0)
  })

  it('pushes a silent client further behind', () => {
    expect(advance(world, 90_000).users[1].staleForMs).toBe(90_001)
  })

  it('moves the analytics clock, which is what windows are measured on', () => {
    expect(advance(world, 30 * 60_000).clockOffsetMs).toBe(1_800_000)
  })

  it(`ages everyone activity, so elapsed labels move`, () => {
    const before = world.users[0].activeForMs
    expect(advance(world, 45_000).users[0].activeForMs).toBe(before + 45_000)
  })
})

describe('presets', () => {
  it('are deterministic - the same button twice is the same world', () => {
    for (const entry of PRESETS) {
      expect(entry.build()).toEqual(entry.build())
    }
  })

  it('never exceed the ten simulated people the lab supports', () => {
    for (const entry of PRESETS) {
      expect(entry.build().users.length).toBeLessThanOrEqual(10)
    }
  })

  it('give every simulated person a distinct id', () => {
    for (const entry of PRESETS) {
      const ids = entry.build().users.map((user) => user.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('describe people only - never what the panel should draw', () => {
    // The preset's job is the world. If it ever starts asserting an outcome,
    // the lab has begun testing itself.
    const world = preset('five').build()
    expect(world.users).toHaveLength(5)
    expect(world.users.every((user) => user.activity === 'watching')).toBe(true)
    expect(new Set(world.users.map((user) => canonicalChannel(user.channel)))).toEqual(
      new Set(['lirik']),
    )
  })

  it('refuses an unknown preset rather than returning an empty world', () => {
    expect(() => preset('nope')).toThrow(/no preset/)
  })
})
