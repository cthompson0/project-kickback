import { describe, expect, it } from 'vitest'
import {
  GRAVITY_THRESHOLD,
  OPPORTUNITY_WINDOW_MS,
  gravityOpportunities,
  isGravity,
  opportunityKey,
  socialGravity,
} from '../../src/core/socialGravity'
import { resolveArm, isRandomisedArm } from '../../src/core/experiment'
import type { Activity, Presence } from '../../src/core/types'

/**
 * The live social map.
 *
 * Two things are being defended here. The first is that Gravity does not
 * reinterpret presence: everything about who is visible, who is stale and who
 * is hiding comes from clusterMembers, so a friend cannot read one way on the
 * map and another way in their user card. The second is that the map holds
 * still - presence heartbeats land every 45 seconds, and an order that shifted
 * on each one would be unusable however correct it was.
 */

const NOW = 1_700_000_000_000

const watching = (userId: string, channel: string, age = 0): Presence => ({
  userId,
  status: 'online',
  activity: { type: 'watching', platform: 'twitch', channel },
  since: NOW - 60_000,
  lastSeenAt: NOW - age,
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

/**
 * Someone who has chosen to hide what they are watching.
 *
 * Redaction happens at WRITE time, so by the time presence reaches any reader
 * it is already an online row with no channel on it. Modelled exactly that
 * way, because a fixture that carried the channel and expected the reader to
 * drop it would be testing a defence that does not exist.
 */
const hidingActivity = (userId: string): Presence => ({
  userId,
  status: 'online',
  activity: { type: 'browsing', platform: 'twitch' },
  since: NOW,
  lastSeenAt: NOW,
})

const ON = (channel: string): Activity => ({ type: 'watching', platform: 'twitch', channel })
const IDLE: Activity = { type: 'idle' }

/** The shape the UI passes: a row object plus the presence that places it. */
const person = (userId: string, presence: Presence | null) => ({
  member: userId,
  presence,
  userId,
})

const map = (
  people: Array<ReturnType<typeof person>>,
  local: Activity = IDLE,
  selfId: string | null = 'me',
) => socialGravity(people, local, NOW, selfId)

const find = (sections: ReturnType<typeof map>, channel: string) =>
  sections.find((section) => section.channel === channel)

describe('clustering by destination', () => {
  it('turns three friends on one channel into one destination', () => {
    const sections = map([
      person('jake', watching('jake', 'xqc')),
      person('matt', watching('matt', 'xqc')),
      person('chris', watching('chris', 'xqc')),
    ])

    const xqc = find(sections, 'xqc')
    expect(xqc?.kind).toBe('destination')
    expect(xqc?.count).toBe(3)
    expect(xqc?.friends).toEqual(['jake', 'matt', 'chris'])
    expect(isGravity(xqc!)).toBe(true)
  })

  it('keeps a single friend as a destination of their own', () => {
    // One friend on a stream is real social discovery. What changes with size
    // is emphasis, not existence.
    const sections = map([person('sarah', watching('sarah', 'lirik'))])
    const lirik = find(sections, 'lirik')

    expect(lirik?.kind).toBe('destination')
    expect(lirik?.count).toBe(1)
    expect(lirik?.canJoin).toBe(true)
    // But it is not a gathering.
    expect(isGravity(lirik!)).toBe(false)
    expect(GRAVITY_THRESHOLD).toBe(2)
  })

  it('clusters on the normalised login, not the casing', () => {
    const sections = map([
      person('jake', watching('jake', 'xqc')),
      person('matt', watching('matt', 'XQC')),
    ])
    expect(find(sections, 'xqc')?.count).toBe(2)
    expect(sections.filter((section) => section.kind === 'destination')).toHaveLength(1)
  })

  it('never places the same friend twice', () => {
    const sections = map([
      person('jake', watching('jake', 'xqc')),
      person('sarah', watching('sarah', 'lirik')),
      person('dave', browsing('dave')),
      person('nina', offline('nina')),
    ])

    const everyone = sections.flatMap((section) => section.friends)
    expect(everyone).toHaveLength(4)
    expect(new Set(everyone).size).toBe(4)
  })

  it('sends people with nothing to join to Around, and the rest to Offline', () => {
    const sections = map([
      person('dave', browsing('dave')),
      person('nina', offline('nina')),
      // No presence at all is not the same as offline, but neither is
      // somewhere you can go.
      person('pat', null),
    ])

    expect(sections.find((section) => section.kind === 'around')?.friends).toEqual(['dave'])
    expect(sections.find((section) => section.kind === 'offline')?.friends).toEqual(['nina', 'pat'])
  })
})

describe('what the map refuses to show', () => {
  it('leaves the viewer out of their own map', () => {
    const sections = map(
      [person('me', watching('me', 'xqc')), person('jake', watching('jake', 'xqc'))],
      ON('xqc'),
      'me',
    )

    const here = sections.find((section) => section.kind === 'here')
    // Two people are on xQc, but only one of them is somebody else.
    expect(here?.count).toBe(1)
    expect(here?.friends).toEqual(['jake'])
  })

  it('shows a friend who hides their activity as merely around', () => {
    const sections = map([
      person('secretive', hidingActivity('secretive')),
      person('jake', watching('jake', 'xqc')),
    ])

    expect(find(sections, 'xqc')?.friends).toEqual(['jake'])
    expect(sections.find((section) => section.kind === 'around')?.friends).toEqual(['secretive'])
    // No destination anywhere claims them.
    for (const section of sections) {
      if (section.kind === 'destination') expect(section.friends).not.toContain('secretive')
    }
  })

  it('drops a friend whose presence has gone stale', () => {
    // An invisible user looks offline by the time presence is written; a user
    // whose browser died looks online until their heartbeat ages out. Both
    // must be off the map, and for the same reason: we cannot vouch for them.
    const sections = map([
      person('ghost', watching('ghost', 'xqc', 10 * 60_000)),
      person('jake', watching('jake', 'lirik')),
    ])

    expect(find(sections, 'xqc')).toBeUndefined()
    expect(sections.find((section) => section.kind === 'offline')?.friends).toEqual(['ghost'])
  })

  it('names no channel it was not given', () => {
    const sections = map([
      person('secretive', hidingActivity('secretive')),
      person('nina', offline('nina')),
    ])
    // Nothing that is not a real, visible destination gets a channel.
    for (const section of sections) {
      if (section.kind !== 'destination' && section.kind !== 'here') {
        expect(section.channel).toBeNull()
      }
    }
  })
})

describe('ranking', () => {
  it('puts the biggest gathering first', () => {
    const sections = map([
      person('sarah', watching('sarah', 'lirik')),
      person('jake', watching('jake', 'xqc')),
      person('matt', watching('matt', 'xqc')),
      person('chris', watching('chris', 'xqc')),
    ])

    const destinations = gravityOpportunities(sections)
    expect(destinations.map((section) => section.channel)).toEqual(['xqc', 'lirik'])
    expect(destinations.map((section) => section.rank)).toEqual([1, 2])
  })

  it('puts where the viewer already is above everything', () => {
    const sections = map(
      [
        person('jake', watching('jake', 'xqc')),
        person('matt', watching('matt', 'xqc')),
        person('chris', watching('chris', 'xqc')),
        person('sarah', watching('sarah', 'lirik')),
      ],
      ON('lirik'),
    )

    expect(sections[0].kind).toBe('here')
    expect(sections[0].channel).toBe('lirik')
    // Even though xQc has three people and here has one.
    expect(sections[1].channel).toBe('xqc')
  })

  it('breaks ties in a way that cannot move under the cursor', () => {
    /*
     * Presence heartbeats land every 45 seconds. A freshness tie-break would
     * reorder the map several times a minute, so ties go alphabetically -
     * arbitrary, but completely stable.
     */
    const people = [
      person('jake', watching('jake', 'zulu', 1_000)),
      person('sarah', watching('sarah', 'alpha', 40_000)),
    ]
    const first = map(people).map((section) => section.channel)
    // Same people, freshness reversed.
    const second = map([
      person('jake', watching('jake', 'zulu', 40_000)),
      person('sarah', watching('sarah', 'alpha', 1_000)),
    ]).map((section) => section.channel)

    expect(first).toEqual(second)
    expect(first[0]).toBe('alpha')
  })

  it('does not rank the channel the viewer is on', () => {
    const sections = map(
      [person('jake', watching('jake', 'xqc')), person('sarah', watching('sarah', 'lirik'))],
      ON('xqc'),
    )

    const here = sections.find((section) => section.kind === 'here')
    // Not an opportunity: they are already there, and counting it would put a
    // row that can never convert into the conversion denominator.
    expect(here?.rank).toBeNull()
    expect(here?.canJoin).toBe(false)
    expect(gravityOpportunities(sections).map((section) => section.channel)).toEqual(['lirik'])
  })

  it('offers no JOIN for anything that is not somewhere to go', () => {
    const sections = map(
      [
        person('jake', watching('jake', 'xqc')),
        person('dave', browsing('dave')),
        person('nina', offline('nina')),
      ],
      ON('xqc'),
    )

    for (const section of sections) {
      expect(section.canJoin).toBe(section.kind === 'destination')
    }
  })
})

describe('the opportunity key', () => {
  it('is the same for every viewer of the same gathering', () => {
    // Amplification counts viewers who arrive at ONE gathering, so everyone
    // acting on it has to write down the same name for it.
    expect(opportunityKey('lirik', NOW)).toBe(opportunityKey('lirik', NOW + 60_000))
    expect(opportunityKey('LIRIK', NOW)).toBe(opportunityKey('lirik', NOW))
  })

  it('carries no friend identities', () => {
    const key = opportunityKey('lirik', NOW)
    for (const name of ['jake', 'matt', 'chris', 'user', 'id']) {
      expect(key).not.toContain(name)
    }
    expect(key).toBe(`gravity:lirik:${Math.floor(NOW / OPPORTUNITY_WINDOW_MS)}`)
  })

  it('separates different destinations', () => {
    expect(opportunityKey('lirik', NOW)).not.toBe(opportunityKey('xqc', NOW))
  })

  it('survives a brief flap', () => {
    // A friend flickering out for thirty seconds is the same gathering.
    expect(opportunityKey('lirik', NOW + 30_000)).toBe(opportunityKey('lirik', NOW))
  })

  it('becomes a new opportunity once the window has passed', () => {
    expect(opportunityKey('lirik', NOW + OPPORTUNITY_WINDOW_MS + 1)).not.toBe(
      opportunityKey('lirik', NOW),
    )
  })

  it('is a pure function, never a per-render id', () => {
    expect(opportunityKey('lirik', NOW)).toBe(opportunityKey('lirik', NOW))
  })

  it('stays short enough for the analytics property cap', () => {
    // Property values are capped at 64 characters server-side.
    expect(opportunityKey('a'.repeat(25), NOW).length).toBeLessThanOrEqual(64)
  })
})

describe('experiment arms', () => {
  it('shows Gravity to everyone outside production', () => {
    // A holdout across five testers measures nothing and costs the feature
    // half the people who are there to test it.
    for (const environment of ['development', 'private_beta'] as const) {
      expect(resolveArm({ userId: 'anyone', environment })).toBe('gravity')
      expect(isRandomisedArm(environment)).toBe(false)
    }
  })

  it('assigns production users deterministically', () => {
    const first = resolveArm({ userId: 'user-a', environment: 'production' })
    // Same id, same answer - on every device, forever, with nothing stored.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(resolveArm({ userId: 'user-a', environment: 'production' })).toBe(first)
    }
    expect(isRandomisedArm('production')).toBe(true)
  })

  it('splits production roughly evenly', () => {
    const arms = Array.from({ length: 1000 }, (_, index) =>
      resolveArm({ userId: `user-${index}`, environment: 'production' }),
    )
    const gravity = arms.filter((arm) => arm === 'gravity').length
    expect(gravity).toBeGreaterThan(400)
    expect(gravity).toBeLessThan(600)
  })

  it('honours an explicit override for local testing', () => {
    expect(resolveArm({ userId: 'anyone', environment: 'production', override: 'flat' })).toBe(
      'flat',
    )
    expect(resolveArm({ userId: 'anyone', environment: 'private_beta', override: 'flat' })).toBe(
      'flat',
    )
  })
})

describe('canonical identity versus display casing', () => {
  /*
   * A channel has two spellings and they do different jobs.
   *
   * The CANONICAL one - the lowercase login - is the identity: it decides who
   * clusters with whom, whether the viewer is already there, what the JOIN
   * navigates to and what analytics calls the destination. Every one of those
   * would break if LVNDMARK and lvndmark were two different things.
   *
   * The DISPLAY one - whatever casing Twitch chose - is text, and belongs only
   * on screen. It is resolved separately in the UI, so nothing below should
   * ever see it. These tests exist because the display fix must not be
   * implemented by loosening the identity.
   */

  it('keeps the destination key lowercase whatever casing presence carries', () => {
    const sections = map([
      person('jake', watching('jake', 'LVNDMARK')),
      person('matt', watching('matt', 'JoshOG')),
    ])

    // Sorted, because this is about spelling and not about ranking.
    expect(sections.map((section) => section.channel).filter(Boolean).sort()).toEqual([
      'joshog',
      'lvndmark',
    ])
  })

  it('puts LVNDMARK and lvndmark in one cluster, not two', () => {
    const sections = map([
      person('jake', watching('jake', 'LVNDMARK')),
      person('matt', watching('matt', 'lvndmark')),
      person('chris', watching('chris', 'LvNdMaRk')),
    ])

    const destinations = sections.filter((section) => section.kind === 'destination')
    expect(destinations).toHaveLength(1)
    expect(destinations[0].channel).toBe('lvndmark')
    expect(destinations[0].count).toBe(3)
    // And it is a gathering: casing must not cost a cluster its weight.
    expect(isGravity(destinations[0])).toBe(true)
  })

  it('recognises the viewer is already there across casing', () => {
    // The viewer's tab says LVNDMARK; their friends' presence says lvndmark.
    // If that reads as two channels the panel offers a JOIN to where you are.
    const sections = map(
      [person('jake', watching('jake', 'lvndmark')), person('matt', watching('matt', 'lvndmark'))],
      ON('LVNDMARK'),
    )

    const here = find(sections, 'lvndmark')
    expect(here?.kind).toBe('here')
    expect(here?.canJoin).toBe(false)
    expect(here?.count).toBe(2)
    expect(sections.filter((section) => section.kind === 'destination')).toHaveLength(0)
  })

  it('recognises it in the other direction too', () => {
    const sections = map([person('jake', watching('jake', 'LVNDMARK'))], ON('lvndmark'))
    expect(find(sections, 'lvndmark')?.kind).toBe('here')
  })

  it('gives one gathering one opportunity key however it is spelled', () => {
    /*
     * Amplification counts the viewers who arrive at ONE gathering, so two
     * viewers whose clients happen to have seen different casing must still
     * write down the same name for it.
     */
    expect(opportunityKey('LVNDMARK', NOW)).toBe(opportunityKey('lvndmark', NOW))
    expect(opportunityKey('LVNDMARK', NOW)).toContain('gravity:lvndmark:')
  })

  it('hands analytics the canonical destination, never the display spelling', () => {
    const sections = map([
      person('jake', watching('jake', 'LVNDMARK')),
      person('matt', watching('matt', 'LVNDMARK')),
    ])

    // What the impression and the JOIN are reported against.
    const [opportunity] = gravityOpportunities(sections)
    expect(opportunity.channel).toBe('lvndmark')
    expect(opportunityKey(opportunity.channel, NOW)).toBe(opportunityKey('lvndmark', NOW))
  })
})
