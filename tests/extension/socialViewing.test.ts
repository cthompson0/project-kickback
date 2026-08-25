import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  canWatchTogether,
  isSocialViewing,
  watchTogetherState,
} from '../../src/core/socialViewing'
import { ACTIVITY_TTL_MS } from '../../src/core/together'
import { roomActivity } from '../../src/core/roomMessages'
import type { TogetherReaction } from '../../src/core/together'
import { COMBO_MIN_DISPLAY } from '../../src/core/combos'
import { STALE_TOLERANCE_MS } from '../../src/core/twitchMetadata'
import type { ChannelMetadata } from '../../src/core/twitchMetadata'

/**
 * The offline bug, and the one rule that answers it.
 *
 * Two accounts sat on twitch.tv/lirik with no stream running, and Kickback
 * said "HERE · OFFLINE · 1 friend watching with you" - with a Stream Room
 * behind it, a reaction subscription, and an open watching_together interval
 * that would eventually have claimed they watched a stream together for
 * however long they left the tab open.
 *
 * Nothing was individually broken. Presence reported the page, and every layer
 * downstream treated "on /lirik" as "watching LIRIK" because presence was the
 * only thing any of them asked. This file pins the separation that fixes it,
 * and the ephemeral activity model the corrected UX draws with.
 */

const NOW = 1_700_000_000_000

const meta = (over: Partial<ChannelMetadata> = {}): ChannelMetadata => ({
  login: 'lirik',
  userId: null,
  displayName: 'LIRIK',
  profileImageUrl: null,
  live: 'live',
  gameName: null,
  title: null,
  viewerCount: null,
  startedAt: null,
  fetchedAt: NOW,
  ...over,
})

describe('social viewing eligibility', () => {
  it('is live, and nothing else', () => {
    expect(isSocialViewing('live')).toBe(true)
    expect(isSocialViewing('offline')).toBe(false)
    expect(isSocialViewing('unknown')).toBe(false)
  })

  it('treats an unanswered channel as not eligible', () => {
    /*
     * The deliberate half.
     *
     * A cold cache, a Twitch outage and a channel nobody has asked about yet
     * all look the same, and treating any of them as live would invent
     * certainty in the one place we cannot repair it: a report claiming people
     * watched something together when nobody knows there was anything to
     * watch. The cost is a false negative, which is visible and recovers on
     * the next refresh.
     */
    expect(canWatchTogether('lirik', {}, NOW)).toBe(false)
    expect(canWatchTogether('lirik', undefined, NOW)).toBe(false)
  })

  it('is eligible on a live channel', () => {
    expect(canWatchTogether('lirik', { lirik: meta() }, NOW)).toBe(true)
  })

  it('is not eligible on a channel whose stream ended', () => {
    expect(canWatchTogether('lirik', { lirik: meta({ live: 'offline' }) }, NOW)).toBe(false)
  })

  it('stops trusting a record too old to be evidence', () => {
    // The same freshness rule the Gravity card draws with: past the tolerance
    // a record says nothing about now, so it cannot make anybody eligible.
    const stale = { lirik: meta({ fetchedAt: NOW - STALE_TOLERANCE_MS - 1 }) }
    expect(canWatchTogether('lirik', stale, NOW)).toBe(false)
    expect(watchTogetherState('lirik', stale, NOW)).toBe('unknown')
  })

  it('accepts the channel in any casing, because presence and metadata differ', () => {
    expect(canWatchTogether('LIRIK', { lirik: meta() }, NOW)).toBe(true)
  })

  it('is not eligible nowhere', () => {
    expect(canWatchTogether(null, { lirik: meta() }, NOW)).toBe(false)
    expect(watchTogetherState(null, { lirik: meta() }, NOW)).toBe('unknown')
  })

  it('still distinguishes ended from unknown, so the card can say OFFLINE', () => {
    /*
     * Eligibility is a boolean; what the panel SAYS is not. A stream that has
     * ended is a fact worth showing, and hiding the label was explicitly not
     * the fix.
     */
    expect(watchTogetherState('lirik', { lirik: meta({ live: 'offline' }) }, NOW)).toBe('offline')
    expect(watchTogetherState('lirik', {}, NOW)).toBe('unknown')
  })
})

describe('the worker asks the one question everywhere', () => {
  /*
   * Read from the source, because the bug was not in any single decision - it
   * was four places independently deciding the same thing from presence alone.
   * What matters is that none of them has its own answer any more.
   */
  const WORKER = readFileSync('src/background/index.ts', 'utf8')

  it('has exactly one definition of social viewing', () => {
    expect(WORKER).toContain('function socialChannel()')
    expect(WORKER).toContain('canWatchTogether')
    expect((WORKER.match(/canWatchTogether\(/g) ?? []).length).toBe(1)
  })

  it('gates the room and the reaction inbox on it', () => {
    expect(WORKER).toContain(`const here = socialChannel()
  together.setChannel(here)
  room.want(here)`)
  })

  it('gates the shared-watch analytics lifecycle on it', () => {
    /*
     * The half that would have outlived the UI. A wrong panel is embarrassing
     * for as long as it is on screen; a wrong watching_together_started is in
     * the database forever.
     */
    expect(WORKER).toContain(`const channel = socialChannel()
  analytics.noteTogether({ channel, otherCount: coWatcherCount(channel) })`)
  })

  it('counts co-watchers against the same channel it reports', () => {
    // Passing one channel and counting against another is how the two halves
    // of a single claim come to disagree.
    expect(WORKER).toContain('function coWatcherCount(channel: string | null): number')
    expect(WORKER).not.toContain('coWatcherCount()')
  })

  it('leaves raw presence alone', () => {
    /*
     * Presence is hardened and reports where a browser is. It is not asked to
     * become an opinion about streams, and the Friends list still says a
     * friend is on an offline channel - because they are.
     */
    expect(WORKER).toContain('presenceReporter.setActivity(tabActivity.effective())')
    expect(WORKER).not.toContain('presenceReporter.setActivity(socialChannel')
  })

  it('has a bounded path in both directions without a new timer', () => {
    /*
     * A stream ending or starting arrives as a metadata refresh, which the
     * service already performs on the existing schedule. No second polling
     * loop was added for this.
     */
    const onChange = WORKER.slice(WORKER.indexOf('onChange: () => {'))
    expect(onChange.slice(0, 200)).toContain('pushActivity()')
    expect(onChange.slice(0, 200)).toContain('updateTogether()')
    expect(WORKER).not.toContain('setInterval')
  })
})

// ------------------------------------------------------------ what is live

const reaction = (over: Partial<TogetherReaction> = {}): TogetherReaction => ({
  id: `r-${over.senderId ?? 'jake'}-${over.at ?? NOW}`,
  senderId: 'jake',
  channel: 'lirik',
  reaction: 'lol',
  at: NOW,
  ...over,
})

const nameOf = (userId: string) => userId

describe('the activity a room and its card both draw', () => {
  it('is nothing when nothing has happened', () => {
    expect(roomActivity([], [], 'lirik', nameOf, NOW)).toBeNull()
  })

  it('reports a single reaction as a run of one', () => {
    const activity = roomActivity([reaction()], [], 'lirik', nameOf, NOW)
    expect(activity?.emote.id).toBe('lol')
    expect(activity?.count).toBe(1)
    expect(activity!.count).toBeLessThan(COMBO_MIN_DISPLAY)
  })

  it('counts different people agreeing', () => {
    const activity = roomActivity(
      [reaction({ senderId: 'jake' }), reaction({ senderId: 'matt', at: NOW + 100 })],
      [],
      'lirik',
      nameOf,
      NOW + 200,
    )
    expect(activity?.count).toBe(2)
  })

  it('does not count one person pressing the same button', () => {
    const activity = roomActivity(
      [
        reaction({ senderId: 'jake', at: NOW }),
        reaction({ senderId: 'jake', at: NOW + 50 }),
        reaction({ senderId: 'jake', at: NOW + 100 }),
      ],
      [],
      'lirik',
      nameOf,
      NOW + 200,
    )
    expect(activity?.count).toBe(1)
  })

  it('starts a new run when the emote changes', () => {
    const activity = roomActivity(
      [
        reaction({ senderId: 'jake', reaction: 'lol', at: NOW }),
        reaction({ senderId: 'matt', reaction: 'lol', at: NOW + 50 }),
        reaction({ senderId: 'jake', reaction: 'fire', at: NOW + 100 }),
      ],
      [],
      'lirik',
      nameOf,
      NOW + 200,
    )
    expect(activity?.emote.id).toBe('fire')
    expect(activity?.count).toBe(1)
  })

  it('vanishes completely once everything has aged out', () => {
    /*
     * Ephemeral means gone. No timestamp, no "recently", no last-known combo
     * kept so the row does not change height - the row holds its own height.
     * If it is on screen, it is happening.
     */
    const reactions = [reaction({ senderId: 'jake' }), reaction({ senderId: 'matt', at: NOW + 10 })]
    expect(roomActivity(reactions, [], 'lirik', nameOf, NOW + 10)?.count).toBe(2)
    expect(roomActivity(reactions, [], 'lirik', nameOf, NOW + ACTIVITY_TTL_MS + 11)).toBeNull()
  })

  it('shrinks as contributors age out rather than freezing', () => {
    // The run is whatever is still live, recomputed - not a number that was
    // once true and is now decoration.
    const reactions = [
      reaction({ senderId: 'jake', at: NOW }),
      reaction({ senderId: 'matt', at: NOW + ACTIVITY_TTL_MS - 1 }),
    ]
    expect(roomActivity(reactions, [], 'lirik', nameOf, NOW)?.count).toBe(2)
    expect(roomActivity(reactions, [], 'lirik', nameOf, NOW + ACTIVITY_TTL_MS)?.count).toBe(1)
  })

  it('belongs to one channel', () => {
    expect(roomActivity([reaction({ channel: 'xqc' })], [], 'lirik', nameOf, NOW)).toBeNull()
    expect(roomActivity([reaction()], [], null, nameOf, NOW)).toBeNull()
  })
})

describe('there is one combo engine', () => {
  const TOGETHER = readFileSync('src/core/together.ts', 'utf8')
  const ROOM = readFileSync('src/ui/components/StreamSession.tsx', 'utf8')
  const CARD = readFileSync('src/ui/components/Together.tsx', 'utf8')

  it('is scanCombos, reached through activeCombo', () => {
    /*
     * roomActivity lives beside the messages now rather than beside the
     * reactions, because it reads BOTH - which is also what broke the import
     * cycle the merge would otherwise have created.
     */
    const STREAM = readFileSync('src/core/roomMessages.ts', 'utf8')
    expect(STREAM).toContain("import { activeCombo } from './combos'")
    expect(STREAM).toContain('export function comboStream(')
    expect(STREAM).toContain('export function roomActivity(')
  })

  it('is not reimplemented by either surface', () => {
    /*
     * Both surfaces ASK the engine; neither counts anything.
     *
     * The session calls scanCombos for the annotations beside each message,
     * exactly as group chat does - that is using the engine, not duplicating
     * it. What neither may do is decide for itself what a run is, so what is
     * asserted is that both go through roomActivity for "what is happening
     * now" and that the deleted burst aggregator has not come back.
     */
    for (const [name, source] of [['room', ROOM], ['card', CARD]] as const) {
      expect(source, name).toContain('roomActivity')
      expect(source, name).not.toContain('reactionBursts')
      expect(source, name).not.toContain('function scanCombos')
    }
    // And the one merged stream both of them are counted over.
    expect(ROOM).toContain('comboStream')
  })

  it('kept the burst aggregator deleted', () => {
    expect(TOGETHER).not.toContain('reactionBursts')
    expect(TOGETHER).not.toContain('export function isCombo')
  })
})
