import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { socialGravity } from '../../src/core/socialGravity'
import { effectiveStatus } from '../../src/core/presence'
import type { ChannelMetadata } from '../../src/core/twitchMetadata'
import type { Activity, Presence } from '../../src/core/types'

/**
 * A friend's presence and a stream's liveness are independent dimensions.
 *
 * THE BETA OBSERVATION THIS EXISTS FOR
 *
 * A friend was online and present, with Twitch left open on a channel that had
 * stopped streaming. Watchside drew her underneath the Offline section, and she
 * read as offline. Both of these were true at once and both had to stay true:
 *
 *   ohjuliego   = ONLINE / PRESENT
 *   OriginAngel = OFFLINE
 *
 * She was never classified as offline. `effectiveStatus` looks at her own
 * status and staleness and has never consulted metadata, and her cluster is a
 * `destination` from beginning to end. What was wrong was WHERE the section
 * landed: ended destinations were sunk to the very end of the map, which is
 * past `around` and past `offline`, so a live person rendered below the heading
 * for people who are gone.
 *
 * Position is what a reader sees, so that was a presence bug even though
 * presence was computed correctly - and it is why these tests assert ORDER and
 * not only classification. A test that checked `kind === 'destination'` would
 * have passed throughout the entire period the bug existed.
 */

const NOW = 1_700_000_000_000

const online = (id: string, channel: string | null): Presence => ({
  userId: id,
  status: 'online',
  activity: channel
    ? { type: 'watching', platform: 'twitch', channel }
    : { type: 'browsing', platform: 'twitch' },
  since: NOW - 60_000,
  lastSeenAt: NOW,
})

/** Genuinely gone: the server says offline. */
const away = (id: string): Presence => ({
  userId: id,
  status: 'offline',
  activity: { type: 'idle' },
  since: NOW - 60_000,
  lastSeenAt: NOW - 60_000,
})

const meta = (login: string, live: ChannelMetadata['live']): ChannelMetadata => ({
  login,
  userId: '1',
  displayName: login.toUpperCase(),
  profileImageUrl: null,
  live,
  gameName: null,
  title: null,
  viewerCount: null,
  startedAt: null,
  fetchedAt: NOW,
})

const member = (id: string, presence: Presence) => ({ member: id, userId: id, presence })
const IDLE: Activity = { type: 'idle' }

/** The map as it is drawn, top to bottom. */
const map = (
  people: ReturnType<typeof member>[],
  metadata: Record<string, ChannelMetadata> = {},
) => socialGravity(people, IDLE, NOW, 'me', metadata)

describe('a friend on a LIVE channel', () => {
  it('is a destination, and is above the offline section', () => {
    const sections = map(
      [member('julie', online('julie', 'originangel')), member('gone', away('gone'))],
      { originangel: meta('originangel', 'live') },
    )
    const kinds = sections.map((section) => section.kind)
    expect(kinds.indexOf('destination')).toBeLessThan(kinds.indexOf('offline'))
    expect(sections.find((section) => section.channel === 'originangel')?.live).toBe('live')
  })
})

describe('a friend on an OFFLINE channel', () => {
  /** The exact reported situation. */
  const sections = () =>
    map([member('julie', online('julie', 'originangel')), member('gone', away('gone'))], {
      originangel: meta('originangel', 'offline'),
    })

  it('is still online, because the stream is not the person', () => {
    expect(effectiveStatus(online('julie', 'originangel'), NOW)).toBe('online')
  })

  it('is still a destination, not folded into offline', () => {
    const julie = sections().find((section) => section.friends.includes('julie'))
    expect(julie?.kind).toBe('destination')
  })

  it('RENDERS ABOVE THE OFFLINE SECTION', () => {
    /*
     * The defect itself. Before the fix this was the LAST section on screen -
     * below the friends who are genuinely gone - which is what made a present
     * friend read as absent.
     */
    const kinds = sections().map((section) => section.kind)
    expect(kinds.indexOf('destination')).toBeLessThan(kinds.indexOf('offline'))
  })

  it('keeps the channel, so we still know where she is', () => {
    // "Preserve useful channel context" - an ended stream is still an answer to
    // "where is she", and dropping it would trade one wrong reading for another.
    const julie = sections().find((section) => section.friends.includes('julie'))
    expect(julie?.channel).toBe('originangel')
    expect(julie?.live).toBe('offline')
  })

  it('still offers JOIN, which this change deliberately does not touch', () => {
    // Recorded so a later reader does not "tidy" it away: JOIN eligibility for
    // an ended stream was explicitly out of scope for this fix.
    const julie = sections().find((section) => section.friends.includes('julie'))
    expect(julie?.canJoin).toBe(true)
  })
})

describe('a friend who is genuinely offline', () => {
  it('is in the offline section, whatever the channel is doing', () => {
    for (const live of ['live', 'offline', 'unknown'] as const) {
      const sections = map([member('gone', away('gone'))], {
        originangel: meta('originangel', live),
      })
      const gone = sections.find((section) => section.friends.includes('gone'))
      expect(gone?.kind, `with the channel ${live}`).toBe('offline')
    }
  })
})

describe('metadata may reorder destinations, and nothing else', () => {
  it('still sinks an ended destination below a live one', () => {
    // The behaviour that was correct and had to survive the fix.
    const sections = map([member('a', online('a', 'ended')), member('b', online('b', 'running'))], {
      ended: meta('ended', 'offline'),
      running: meta('running', 'live'),
    })
    expect(
      sections.filter((section) => section.kind === 'destination').map((s) => s.channel),
    ).toEqual(['running', 'ended'])
  })

  it('never moves a destination below around or offline', () => {
    /*
     * The invariant, stated once. Whatever metadata says about any channel, a
     * person who is present outranks a person who is not.
     */
    const people = [
      member('watching', online('watching', 'ended')),
      member('around', online('around', null)),
      member('gone', away('gone')),
    ]
    for (const live of ['live', 'offline', 'unknown'] as const) {
      const kinds = map(people, { ended: meta('ended', live) }).map((section) => section.kind)
      expect(kinds, `with the channel ${live}`).toEqual(['destination', 'around', 'offline'])
    }
  })
})

describe('the card does not paint the stream state onto the people', () => {
  it('dims the stream context but not the friends on it', () => {
    /*
     * The second instance of the same conflation, found by auditing outward
     * from the ordering bug. The offline card used to carry `opacity` on the
     * whole element, so an online friend's avatar and name were faded because
     * the CHANNEL had ended.
     */
    const css = readFileSync(join(process.cwd(), 'src', 'ui', 'kickback.css'), 'utf8')
    const at = css.indexOf('.kb-gravity-card-offline')
    expect(at, 'the offline card rule should exist').toBeGreaterThan(-1)
    const selector = css.slice(at, css.indexOf('{', at))
    expect(selector).toContain('kb-gravity-people')
    expect(selector).toContain(':not(')
  })
})
