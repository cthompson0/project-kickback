import { describe, expect, it } from 'vitest'
import { channelNameFromTitle, resolveChannelName } from '../../src/core/channelNames'
import { aroundCount, clusterMembers } from '../../src/core/groupPresence'
import { isValidGroupIcon, normalizeGroupIcon, GROUP_ICONS } from '../../src/core/groupIcons'
import { formatChannelName } from '../../src/platforms/twitch/channels'
import type { Activity, Presence } from '../../src/core/types'

/**
 * Two things a social product has to get right about people: spell their name
 * the way they spell it, and say where they are without saying more than they
 * shared.
 */

// ------------------------------------------------------------ capitalisation

describe('channel capitalisation', () => {
  const ANOTEROS = { username: 'anoterostv', displayName: 'AnoterosTV' }

  it('uses the display name of a person we already know', () => {
    // A Twitch channel is a Twitch user, so a friend's stored name IS the
    // channel's name - no API call, no scraping, no guessing.
    expect(resolveChannelName('anoterostv', { people: [ANOTEROS] })).toBe('AnoterosTV')
  })

  it('uses a casing this browser has actually seen', () => {
    expect(resolveChannelName('xqc', { seen: { xqc: 'xQc' } })).toBe('xQc')
  })

  it('prefers a known person over a remembered page', () => {
    const resolved = resolveChannelName('anoterostv', {
      people: [ANOTEROS],
      seen: { anoterostv: 'anoterostv' },
    })
    expect(resolved).toBe('AnoterosTV')
  })

  it('falls back to the login rather than inventing capitalisation', () => {
    // The bug this replaced upper-cased the first letter, turning `anoterostv`
    // into `Anoterostv` - a name its owner never chose. Plain beats wrong.
    expect(resolveChannelName('anoterostv')).toBe('anoterostv')
    expect(resolveChannelName('xqc')).toBe('xqc')
    expect(resolveChannelName('lirik')).toBe('lirik')
  })

  it('never title-cases, for any input', () => {
    for (const login of ['anoterostv', 'xqc', 'iittztimmy', 'summit1g']) {
      const resolved = resolveChannelName(login)
      expect(resolved).toBe(login)
      expect(resolved[0]).toBe(login[0])
    }
  })

  it('refuses a name that is a different word', () => {
    // Someone's nickname is not their channel's name.
    expect(resolveChannelName('lirik', { people: [{ username: 'lirik', displayName: 'Big L' }] }))
      .toBe('lirik')
    expect(resolveChannelName('lirik', { seen: { lirik: 'Somebody Else' } })).toBe('lirik')
  })

  it('matches the channel regardless of how the login was cased', () => {
    expect(resolveChannelName('AnoterosTV', { people: [ANOTEROS] })).toBe('AnoterosTV')
  })

  it('leaves the canonical login untouched for lookups and URLs', () => {
    // Presentation must never change the identity: the login is still what
    // goes in a URL, a comparison and a database row.
    const login = 'anoterostv'
    expect(resolveChannelName(login, { people: [ANOTEROS] }).toLowerCase()).toBe(login)
  })
})

describe('formatChannelName', () => {
  it('shows a supplied display name', () => {
    expect(formatChannelName('anoterostv', 'AnoterosTV')).toBe('AnoterosTV')
  })

  it('shows the login when nothing is supplied', () => {
    expect(formatChannelName('anoterostv')).toBe('anoterostv')
    expect(formatChannelName('anoterostv', null)).toBe('anoterostv')
  })

  it('ignores a display name that spells something else', () => {
    expect(formatChannelName('lirik', 'Not Lirik')).toBe('lirik')
  })
})

describe('reading capitalisation off a Twitch page title', () => {
  it('reads a plain channel title', () => {
    expect(channelNameFromTitle('AnoterosTV - Twitch', 'anoterostv')).toBe('AnoterosTV')
  })

  it('reads a title with the stream name in front', () => {
    expect(channelNameFromTitle('playing something - xQc - Twitch', 'xqc')).toBe('xQc')
  })

  it('ignores an unread-count prefix', () => {
    expect(channelNameFromTitle('(3) LIRIK - Twitch', 'lirik')).toBe('LIRIK')
  })

  it('returns nothing when the title is about something else', () => {
    // A title that does not contain this channel must never rename it.
    expect(channelNameFromTitle('Twitch', 'lirik')).toBeNull()
    expect(channelNameFromTitle('Directory - Twitch', 'lirik')).toBeNull()
    expect(channelNameFromTitle('', 'lirik')).toBeNull()
  })

  it('has nothing to give while the title still names the previous channel', () => {
    /*
     * Why casing was never learned.
     *
     * Twitch changes the URL before it changes the title, so at the instant a
     * navigation is detected the title still belongs to where you just were -
     * and against the NEW channel that title yields nothing. The content
     * script used to report activity only on channel change, so this null was
     * the only answer it ever got and every destination stayed a bare login.
     *
     * The correction arrives a beat later and is worth listening for; that is
     * what watchTitle is for.
     */
    expect(channelNameFromTitle('JoshOG - Twitch', 'lvndmark')).toBeNull()
    expect(channelNameFromTitle('LVNDMARK - Twitch', 'lvndmark')).toBe('LVNDMARK')
  })

  it('will not let a title rename a channel, only respell it', () => {
    // The learned value is a spelling of the same login and nothing else, so
    // a hijacked or mis-parsed title cannot point a name at another channel.
    expect(channelNameFromTitle('LVNDMARK - Twitch', 'joshog')).toBeNull()
    expect(resolveChannelName('lvndmark', { seen: { lvndmark: 'JoshOG' } })).toBe('lvndmark')
    expect(resolveChannelName('lvndmark', { seen: { lvndmark: 'LVNDMARK' } })).toBe('LVNDMARK')
  })
})

// ------------------------------------------------------------ group presence

const NOW = 1_700_000_000_000

const watching = (userId: string, channel: string): Presence => ({
  userId,
  status: 'online',
  activity: { type: 'watching', platform: 'twitch', channel },
  since: NOW,
  lastSeenAt: NOW,
})

const browsing = (userId: string): Presence => ({
  userId,
  status: 'online',
  activity: { type: 'browsing', platform: 'twitch' },
  since: NOW,
  lastSeenAt: NOW,
})

const offline = (userId: string): Presence => ({
  userId,
  status: 'offline',
  activity: { type: 'idle' },
  since: NOW,
  lastSeenAt: NOW,
})

const IDLE_LOCAL: Activity = { type: 'idle' }
const HERE_ON = (channel: string): Activity => ({ type: 'watching', platform: 'twitch', channel })

/** Members as the clustering sees them: a name and whatever presence said. */
const member = (name: string, presence: Presence | null) => ({ member: name, presence })

describe('reading a group at a glance', () => {
  it('puts one member watching something in their own cluster', () => {
    const clusters = clusterMembers([member('Jake', watching('u1', 'xqc'))], IDLE_LOCAL, NOW)
    expect(clusters).toEqual([{ kind: 'channel', channel: 'xqc', members: ['Jake'] }])
  })

  it('gathers two members on the same stream into one cluster', () => {
    // The whole point: "we are watching this together" should be one row you
    // can act on, not two rows you have to notice match.
    const clusters = clusterMembers(
      [member('Jake', watching('u1', 'xqc')), member('Sarah', watching('u2', 'xqc'))],
      IDLE_LOCAL,
      NOW,
    )
    expect(clusters).toHaveLength(1)
    expect(clusters[0]).toMatchObject({ kind: 'channel', channel: 'xqc' })
    expect(clusters[0].members).toEqual(['Jake', 'Sarah'])
  })

  it('splits members across the channels they are actually on', () => {
    const clusters = clusterMembers(
      [
        member('Jake', watching('u1', 'xqc')),
        member('Matt', watching('u2', 'lirik')),
        member('Sarah', watching('u3', 'xqc')),
      ],
      IDLE_LOCAL,
      NOW,
    )
    expect(clusters.map((c) => c.channel)).toEqual(['xqc', 'lirik'])
    // Bigger clusters first: that is where the group actually is.
    expect(clusters[0].members).toEqual(['Jake', 'Sarah'])
  })

  it('breaks ties between equal clusters alphabetically, so order is stable', () => {
    const clusters = clusterMembers(
      [member('Jake', watching('u1', 'zebra')), member('Matt', watching('u2', 'apple'))],
      IDLE_LOCAL,
      NOW,
    )
    expect(clusters.map((c) => c.channel)).toEqual(['apple', 'zebra'])
  })

  it('calls out the people already with you, and offers them no JOIN', () => {
    const clusters = clusterMembers(
      [member('Jake', watching('u1', 'lirik')), member('Matt', watching('u2', 'xqc'))],
      HERE_ON('lirik'),
      NOW,
    )
    expect(clusters[0]).toMatchObject({ kind: 'here', channel: 'lirik', members: ['Jake'] })
    expect(clusters[1]).toMatchObject({ kind: 'channel', channel: 'xqc' })
  })

  it('matches HERE regardless of how either side was cased', () => {
    const clusters = clusterMembers(
      [member('Jake', watching('u1', 'LIRIK'))],
      HERE_ON('lirik'),
      NOW,
    )
    expect(clusters[0].kind).toBe('here')
  })

  it('separates people who are around from people who are gone', () => {
    // Around matters: they might come and watch something with you. Offline
    // does not.
    const clusters = clusterMembers(
      [member('Nina', browsing('u1')), member('Dave', offline('u2'))],
      IDLE_LOCAL,
      NOW,
    )
    expect(clusters).toEqual([
      { kind: 'browsing', channel: null, members: ['Nina'] },
      { kind: 'offline', channel: null, members: ['Dave'] },
    ])
  })

  it('keeps the roster complete, offline members included', () => {
    const clusters = clusterMembers(
      [member('Jake', watching('u1', 'xqc')), member('Dave', offline('u2'))],
      IDLE_LOCAL,
      NOW,
    )
    expect(clusters.flatMap((c) => c.members)).toEqual(['Jake', 'Dave'])
  })

  it('orders clusters most actionable first', () => {
    const clusters = clusterMembers(
      [
        member('Dave', offline('u1')),
        member('Nina', browsing('u2')),
        member('Matt', watching('u3', 'xqc')),
        member('Jake', watching('u4', 'lirik')),
      ],
      HERE_ON('lirik'),
      NOW,
    )
    expect(clusters.map((c) => c.kind)).toEqual(['here', 'channel', 'browsing', 'offline'])
  })

  it('says nothing at all about a member with no presence', () => {
    // Hidden and invisible presence is redacted before it is written, so it
    // arrives here looking like this. There is no branch that could reveal it.
    const clusters = clusterMembers([member('Ghost', null)], IDLE_LOCAL, NOW)
    expect(clusters).toEqual([{ kind: 'offline', channel: null, members: ['Ghost'] }])
  })

  it('never invents a channel for someone who shared none', () => {
    const clusters = clusterMembers(
      [member('Ghost', null), member('Quiet', offline('u2'))],
      HERE_ON('lirik'),
      NOW,
    )
    expect(clusters.every((cluster) => cluster.kind !== 'here')).toBe(true)
    expect(clusters.every((cluster) => cluster.channel === null)).toBe(true)
  })

  it('treats a member whose presence went stale as offline', () => {
    // A heartbeat that stopped is not a claim that they are still watching.
    const stale = { ...watching('u1', 'xqc'), lastSeenAt: NOW - 60 * 60_000 }
    const clusters = clusterMembers([member('Jake', stale)], IDLE_LOCAL, NOW)
    expect(clusters[0].kind).toBe('offline')
  })

  it('produces nothing for an empty group', () => {
    expect(clusterMembers([], IDLE_LOCAL, NOW)).toEqual([])
  })

  it('counts who is visibly around', () => {
    const members = [
      member('Jake', watching('u1', 'xqc')),
      member('Nina', browsing('u2')),
      member('Dave', offline('u3')),
      member('Ghost', null),
    ]
    expect(aroundCount(members, NOW)).toBe(2)
  })
})

// ------------------------------------------------------------- group icons

describe('group icons', () => {
  it('accepts the icons we offer', () => {
    for (const icon of GROUP_ICONS) expect(isValidGroupIcon(icon)).toBe(true)
  })

  it('rejects anything that would be a second name field', () => {
    for (const bad of ['', '   ', 'The Boys', 'a b', 'x'.repeat(25)]) {
      expect(isValidGroupIcon(bad)).toBe(false)
    }
  })

  it('normalises a chosen icon and drops a bad one', () => {
    expect(normalizeGroupIcon(' 🎮 ')).toBe('🎮')
    expect(normalizeGroupIcon('not an icon')).toBeNull()
  })

  it('treats no icon as a legitimate choice', () => {
    // Picking one is optional, so groups that predate icons stay valid.
    expect(normalizeGroupIcon(null)).toBeNull()
  })

  it('allows a multi-code-point emoji', () => {
    // One user-perceived emoji can be several code points; the bound is on
    // length, not on it being a single unit.
    expect(isValidGroupIcon('⚔️')).toBe(true)
    expect(isValidGroupIcon('👩‍💻')).toBe(true)
  })
})
