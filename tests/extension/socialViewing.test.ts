import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  canSessionForm,
  canWatchLiveTogether,
  isLiveSharedWatch,
  watchTogetherState,
} from '../../src/core/socialViewing'
import { ACTIVITY_TTL_MS } from '../../src/core/together'
import { roomActivity } from '../../src/core/roomMessages'
import type { TogetherReaction } from '../../src/core/together'
import { COMBO_MIN_DISPLAY } from '../../src/core/combos'
import { STALE_TOLERANCE_MS } from '../../src/core/twitchMetadata'
import type { ChannelMetadata } from '../../src/core/twitchMetadata'

/**
 * Two rules that were once one boolean, and the bug at each end of it.
 *
 * TOO NARROW, THEN TOO BROAD
 *
 * Two accounts once sat on twitch.tv/lirik with no stream running and Kickback
 * reported them watching together - a room, reactions, and an open shared-watch
 * interval that would eventually have claimed an hour of co-viewing nothing.
 * Requiring an authoritative LIVE status before any of it formed fixed that.
 *
 * It also broke the product. Requiring a broadcast before people are allowed to
 * talk means a stream ending ends the conversation happening around it, which
 * is backwards: the stream stops and everybody is still sitting there. And it
 * made every session hostage to a metadata refresh, which is how a viewer could
 * see a friend on their HERE card and be offered nowhere to go.
 *
 * So it is two rules now, and this file pins both - including the thing each
 * one must NOT do.
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

describe('a social session needs people, not a broadcast', () => {
  it('forms wherever somebody is here with you', () => {
    expect(canSessionForm('lirik', 1)).toBe(true)
    expect(canSessionForm('lirik', 4)).toBe(true)
  })

  it('does not form alone, or nowhere', () => {
    expect(canSessionForm('lirik', 0)).toBe(false)
    expect(canSessionForm(null, 3)).toBe(false)
    expect(canSessionForm('', 3)).toBe(false)
  })

  it('takes no opinion from metadata at all', () => {
    /*
     * The whole point of the split. There is no argument from live status that
     * can conjure a session or take one away - a stream ending must not end the
     * conversation around it.
     */
    const source = readFileSync('src/core/socialViewing.ts', 'utf8')
    const fn = source.slice(source.indexOf('export function canSessionForm'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body).not.toContain('metadata')
    expect(body).not.toContain('live')
  })
})

describe('a live shared watch needs a broadcast', () => {
  it('is live, and nothing else', () => {
    expect(isLiveSharedWatch('live')).toBe(true)
    expect(isLiveSharedWatch('offline')).toBe(false)
    expect(isLiveSharedWatch('unknown')).toBe(false)
  })

  it('treats an unanswered channel as not eligible', () => {
    /*
     * The deliberate half, and it costs nothing a person can see any more: if
     * this is wrong a duration is conservative, and nobody loses a session.
     */
    expect(canWatchLiveTogether('lirik', {}, NOW)).toBe(false)
    expect(canWatchLiveTogether('lirik', undefined, NOW)).toBe(false)
  })

  it('is eligible on a live channel, and not on one that ended', () => {
    expect(canWatchLiveTogether('lirik', { lirik: meta() }, NOW)).toBe(true)
    expect(canWatchLiveTogether('lirik', { lirik: meta({ live: 'offline' }) }, NOW)).toBe(false)
  })

  it('stops trusting a record too old to be evidence', () => {
    const stale = { lirik: meta({ fetchedAt: NOW - STALE_TOLERANCE_MS - 1 }) }
    expect(canWatchLiveTogether('lirik', stale, NOW)).toBe(false)
    expect(watchTogetherState('lirik', stale, NOW)).toBe('unknown')
  })

  it('accepts the channel in any casing, because presence and metadata differ', () => {
    expect(canWatchLiveTogether('LIRIK', { lirik: meta() }, NOW)).toBe(true)
  })

  it('is not eligible nowhere', () => {
    expect(canWatchLiveTogether(null, { lirik: meta() }, NOW)).toBe(false)
    expect(watchTogetherState(null, { lirik: meta() }, NOW)).toBe('unknown')
  })

  it('still distinguishes ended from unknown, so the card can say OFFLINE', () => {
    expect(watchTogetherState('lirik', { lirik: meta({ live: 'offline' }) }, NOW)).toBe('offline')
    expect(watchTogetherState('lirik', {}, NOW)).toBe('unknown')
  })
})

describe('the worker keeps the two apart', () => {
  const WORKER = readFileSync('src/background/index.ts', 'utf8')

  it('has one function per question, named for the question', () => {
    expect(WORKER).toContain('function sessionChannel()')
    expect(WORKER).toContain('function liveWatchChannel()')
  })

  it('gives the room, the inbox and the conversation the SESSION rule', () => {
    expect(WORKER).toContain(`const here = sessionChannel()
  together.setChannel(here)
  room.want(here)`)
    expect(WORKER).toContain('roomChat.setChannel(here)')
  })

  it('gives ONLY the analytics lifecycle the live rule', () => {
    /*
     * The half that would outlive a wrong answer. A wrong panel is
     * embarrassing while it is on screen; a wrong watching_together_started is
     * in the database forever.
     */
    expect(WORKER).toContain(`const channel = liveWatchChannel()
  analytics.noteTogether({ channel, otherCount: coWatcherCount(channel) })`)
    // Its own doc line, its definition, the analytics call, and the
    // diagnostic that exists so a future disagreement is answerable in one line.
    expect((WORKER.match(/liveWatchChannel\(\)/g) ?? []).length).toBe(4)
  })

  it('asks the live question in exactly one place', () => {
    expect((WORKER.match(/canWatchLiveTogether\(/g) ?? []).length).toBe(1)
  })

  it('leaves raw presence alone', () => {
    expect(WORKER).toContain('presenceReporter.setActivity(tabActivity.effective())')
    expect(WORKER).not.toContain('presenceReporter.setActivity(sessionChannel')
  })

  it('adds no polling loop', () => {
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
  receivedAt: over.at ?? NOW,
  ...over,
})

const nameOf = (userId: string) => userId

describe('the activity a session and its card both draw', () => {
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
    const reactions = [reaction({ senderId: 'jake' }), reaction({ senderId: 'matt', at: NOW + 10 })]
    expect(roomActivity(reactions, [], 'lirik', nameOf, NOW + 10)?.count).toBe(2)
    expect(roomActivity(reactions, [], 'lirik', nameOf, NOW + ACTIVITY_TTL_MS + 11)).toBeNull()
  })

  it('shrinks as contributors age out rather than freezing', () => {
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
  const STREAM = readFileSync('src/core/roomMessages.ts', 'utf8')
  const ROOM = readFileSync('src/ui/components/StreamSession.tsx', 'utf8')
  const CARD = readFileSync('src/ui/components/SocialGravity.tsx', 'utf8')

  it('is scanCombos, reached through activeCombo, over one merged stream', () => {
    expect(STREAM).toContain("import { activeCombo } from './combos'")
    expect(STREAM).toContain('export function comboStream(')
    expect(STREAM).toContain('export function roomActivity(')
  })

  it('is asked, never reimplemented, by either surface', () => {
    for (const [name, source] of [['session', ROOM], ['card', CARD]] as const) {
      expect(source, name).toContain('roomActivity')
      expect(source, name).not.toContain('reactionBursts')
      expect(source, name).not.toContain('function scanCombos')
    }
  })

  it('kept the burst aggregator deleted', () => {
    const TOGETHER = readFileSync('src/core/together.ts', 'utf8')
    expect(TOGETHER).not.toContain('reactionBursts')
    expect(TOGETHER).not.toContain('export function isCombo')
  })
})
