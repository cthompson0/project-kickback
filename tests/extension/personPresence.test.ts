import { describe, expect, it } from 'vitest'
import { describePresence, isSameChannel, viewerChannel } from '../../src/core/personPresence'
import { aroundCount, clusterMembers } from '../../src/core/groupPresence'
import type { Activity, Presence } from '../../src/core/types'

/**
 * One interpretation of one person, for one viewer.
 *
 * The bug these defend against: the group cluster said somebody was "here with
 * you" while the user card, looking at the same presence and the same viewer,
 * said "watching stankRat" and offered a JOIN that reloaded the stream you were
 * already on. Two implementations of one question.
 *
 * And its sibling: the viewer counting as one of the people they were watching
 * with, so a group of one looked like company.
 */

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

const ON = (channel: string): Activity => ({ type: 'watching', platform: 'twitch', channel })
const IDLE: Activity = { type: 'idle' }

// ------------------------------------------------------- the shared answer

describe('what one person is doing, for one viewer', () => {
  it('reports watching with you when both are on the same channel', () => {
    const state = describePresence(watching('u1', 'lirik'), ON('lirik'), NOW)
    expect(state.kind).toBe('watching_with_you')
    expect(state.channel).toBe('lirik')
  })

  it('offers no JOIN to where the viewer already is', () => {
    // The reported bug: JOIN simply reloaded the current stream.
    expect(describePresence(watching('u1', 'lirik'), ON('lirik'), NOW).canJoin).toBe(false)
  })

  it('matches the same channel however either side was cased', () => {
    expect(describePresence(watching('u1', 'LIRIK'), ON('lirik'), NOW).kind).toBe(
      'watching_with_you',
    )
    expect(describePresence(watching('u1', 'lirik'), ON('LiRiK'), NOW).kind).toBe(
      'watching_with_you',
    )
  })

  it('reports watching elsewhere, with a JOIN, for a different channel', () => {
    const state = describePresence(watching('u1', 'xqc'), ON('lirik'), NOW)
    expect(state).toMatchObject({ kind: 'watching_elsewhere', channel: 'xqc', canJoin: true })
  })

  it('offers a JOIN when the viewer is not watching anything', () => {
    const state = describePresence(watching('u1', 'xqc'), IDLE, NOW)
    expect(state).toMatchObject({ kind: 'watching_elsewhere', canJoin: true })
  })

  it('reports around, with nowhere to go, for someone not on a channel', () => {
    // Browsing and hiding activity are indistinguishable by design: presence
    // is redacted at write time, and a client that could tell them apart would
    // be leaking the choice.
    const state = describePresence(browsing('u1'), ON('lirik'), NOW)
    expect(state).toMatchObject({ kind: 'around', channel: null, canJoin: false })
  })

  it('reports offline for offline, missing, and stale presence', () => {
    for (const presence of [
      offline('u1'),
      null,
      undefined,
      { ...watching('u1', 'lirik'), lastSeenAt: NOW - 60 * 60_000 },
    ]) {
      const state = describePresence(presence, ON('lirik'), NOW)
      expect(state).toMatchObject({ kind: 'offline', channel: null, canJoin: false })
    }
  })

  it('never claims someone is with a viewer who has no channel', () => {
    expect(describePresence(watching('u1', 'lirik'), null, NOW).kind).toBe('watching_elsewhere')
    expect(describePresence(watching('u1', 'lirik'), IDLE, NOW).kind).toBe('watching_elsewhere')
  })

  it("reads the viewer's own channel, or nothing", () => {
    expect(viewerChannel(ON('LIRIK'))).toBe('lirik')
    expect(viewerChannel(IDLE)).toBeNull()
    expect(viewerChannel(null)).toBeNull()
  })
})

describe('the JOIN guard', () => {
  it('recognises a destination the viewer is already at', () => {
    expect(isSameChannel('lirik', ON('lirik'))).toBe(true)
    expect(isSameChannel('LIRIK', ON('lirik'))).toBe(true)
  })

  it('lets a different destination through', () => {
    expect(isSameChannel('xqc', ON('lirik'))).toBe(false)
  })

  it('lets anything through when the viewer is nowhere', () => {
    expect(isSameChannel('lirik', IDLE)).toBe(false)
    expect(isSameChannel('lirik', null)).toBe(false)
  })

  it('treats a missing destination as nothing to guard', () => {
    expect(isSameChannel(null, ON('lirik'))).toBe(false)
    expect(isSameChannel('', ON('lirik'))).toBe(false)
  })
})

// ---------------------------------------------------------- self exclusion

describe('social summaries describe other people', () => {
  const entry = (id: string, presence: Presence | null) => ({
    member: id,
    presence,
    userId: id,
  })

  it('leaves the viewer out of the people they are watching with', () => {
    // A, B and C are all on Lirik. A is the viewer, so A sees two others.
    const clusters = clusterMembers(
      [
        entry('a', watching('a', 'lirik')),
        entry('b', watching('b', 'lirik')),
        entry('c', watching('c', 'lirik')),
      ],
      ON('lirik'),
      NOW,
      'a',
    )
    expect(clusters).toHaveLength(1)
    expect(clusters[0].kind).toBe('here')
    expect(clusters[0].members).toEqual(['b', 'c'])
    expect(clusters[0].members).not.toContain('a')
  })

  it('renders no watching-with-you row when the viewer is alone', () => {
    // "1 member is watching with you - you" is not a thing. Zero others means
    // zero rows, not a row of one.
    const clusters = clusterMembers([entry('a', watching('a', 'lirik'))], ON('lirik'), NOW, 'a')
    expect(clusters).toEqual([])
  })

  it('leaves the viewer out of every other cluster too', () => {
    for (const [label, presence] of [
      ['watching elsewhere', watching('a', 'xqc')],
      ['browsing', browsing('a')],
      ['offline', offline('a')],
    ] as const) {
      const clusters = clusterMembers([entry('a', presence)], ON('lirik'), NOW, 'a')
      expect(clusters, label).toEqual([])
    }
  })

  it('excludes the viewer even when they have shared no presence at all', () => {
    // Keyed on identity, not on presence: a viewer with nothing to share is
    // still the viewer, and must not appear as an offline member of their own
    // social summary.
    const clusters = clusterMembers(
      [entry('a', null), entry('b', watching('b', 'lirik'))],
      ON('lirik'),
      NOW,
      'a',
    )
    expect(clusters.flatMap((cluster) => cluster.members)).toEqual(['b'])
  })

  it('counts only other people as being around', () => {
    const members = [entry('a', browsing('a')), entry('b', browsing('b'))]
    expect(aroundCount(members, NOW, 'a')).toBe(1)
    // Without a viewer there is nobody to exclude.
    expect(aroundCount(members, NOW)).toBe(2)
  })

  it('still includes everyone when no viewer is given', () => {
    // Membership and management lists are a different question, and they ask
    // it by passing no self.
    const clusters = clusterMembers([entry('a', watching('a', 'lirik'))], ON('lirik'), NOW)
    expect(clusters[0].members).toEqual(['a'])
  })

  it('does not confuse the viewer with somebody else', () => {
    const clusters = clusterMembers(
      [entry('a', watching('a', 'lirik')), entry('ab', watching('ab', 'lirik'))],
      ON('lirik'),
      NOW,
      'a',
    )
    expect(clusters[0].members).toEqual(['ab'])
  })
})
