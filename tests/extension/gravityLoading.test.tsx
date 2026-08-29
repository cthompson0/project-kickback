import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { KickbackPanel } from '../../src/ui/KickbackPanel'
import { createMetadataService } from '../../src/background/metadata'
import { awaitingEnrichment, gravityModel, visibleGravity } from '../../src/core/socialGravity'
import { createCallQueue, settle } from '../support/orchestration'
import { INITIAL_STATE } from '../../src/client/types'
import type { Friend, KickbackClient, KickbackState } from '../../src/client/types'
import type { Presence } from '../../src/core/types'
import type { ChannelMetadata } from '../../src/core/twitchMetadata'

/**
 * A destination should arrive COMPLETE, not arrive and then improve.
 *
 * Correctness was already fixed: every destination is discovered, requested
 * and enriched. What remained was the half second in between, during which a
 * new card rendered as a raw lowercase login with no badge, no category, no
 * viewers and no avatar, and then visibly transformed.
 *
 * The rule under test is state-driven and has no clock in it: a destination
 * with no metadata and a request OPEN is held back, because it is arriving; a
 * destination with no metadata and NO request open is drawn plain, because it
 * is not. That makes a failed fetch degrade to the card the panel has always
 * drawn rather than to a card that never appears.
 */

const NOW = 1_700_000_000_000

const friend = (id: string, name: string, presence: Presence | null): Friend => ({
  user: { id, username: id, displayName: name, avatarUrl: null, accentColor: '#ff8452' },
  presence,
})

const watching = (userId: string, channel: string): Presence => ({
  userId,
  status: 'online',
  activity: { type: 'watching', platform: 'twitch', channel },
  since: NOW - 60_000,
  // Fresh against the real clock: the staleness rule would otherwise age
  // every friend to offline and there would be no map to test.
  lastSeenAt: Date.now(),
})

const FRIEND_A = friend('a', 'Friend A', watching('a', 'lirik'))
const NAMES: Record<string, string> = {
  lirik: 'LIRIK',
  teamliquid: 'TeamLiquid',
  timthetatman: 'TimTheTatman',
}

const record = (login: string): ChannelMetadata => ({
  login,
  userId: '12345',
  displayName: NAMES[login] ?? login,
  profileImageUrl: `https://static-cdn.jtvnw.net/jtv_user_pictures/${login}.png`,
  live: 'live',
  gameName: 'Just Chatting',
  title: `${login} stream`,
  viewerCount: 1_000,
  startedAt: NOW - 3_600_000,
  fetchedAt: Date.now(),
})

const wire = (logins: string[]) => ({
  channels: logins.map((login) => ({
    login,
    userId: '12345',
    displayName: NAMES[login] ?? login,
    profileImageUrl: `https://static-cdn.jtvnw.net/jtv_user_pictures/${login}.png`,
    live: 'live',
    gameName: 'Just Chatting',
    title: `${login} stream`,
    viewerCount: 1_000,
    startedAt: NOW - 3_600_000,
  })),
})

// ---------------------------------------------------------------- rendering

function installWindow() {
  const storage: Record<string, string> = {}
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      innerWidth: 1600,
      innerHeight: 900,
      location: { pathname: '/somewhere_else', href: 'https://www.twitch.tv/somewhere_else' },
      localStorage: {
        getItem: (key: string) => storage[key] ?? null,
        setItem: (key: string, value: string) => {
          storage[key] = value
        },
        removeItem: (key: string) => {
          delete storage[key]
        },
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      matchMedia: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {} },
  })
}

function render(state: Partial<KickbackState>) {
  installWindow()
  const merged: KickbackState = {
    ...INITIAL_STATE,
    status: 'signed_in',
    identity: {
      userId: 'observer',
      displayName: 'Observer',
      avatarUrl: null,
      twitchLogin: 'observer',
      friendCode: 'KB-TEST',
      presenceVisibility: 'visible',
    },
    friends: [FRIEND_A],
    ...state,
  }
  const client = {
    getState: () => merged,
    subscribe: (listener: (s: KickbackState) => void) => {
      listener(merged)
      return () => {}
    },
    reportActivity: () => {},
    markSeen: () => {},
    markKindSeen: () => {},
    markGroupRead: () => {},
    selectSession: () => {},
    track: () => {},
    recordJoin: () => {},
    reportExposure: () => {},
    searchEmotes: async () => [],
  } as unknown as KickbackClient
  return renderToStaticMarkup(<KickbackPanel client={client} />)
}

const cards = (html: string) =>
  html
    .split('<div class="kb-gravity-card')
    .slice(1)
    .map((chunk) => {
      const end = chunk.indexOf('kb-gravity-people')
      return end === -1 ? chunk : chunk.slice(0, end)
    })

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
  Reflect.deleteProperty(globalThis, 'document')
})

// ------------------------------------------------------- the required cases

describe('CASE 1 — a second destination appears while its metadata is pending', () => {
  const state = {
    friendDestinations: { a: ['lirik', 'teamliquid'] },
    channelMetadata: { lirik: record('lirik') },
  }

  it('keeps the card that is already complete', () => {
    const html = render({ ...state, channelMetadataPending: ['teamliquid'] })
    expect(html).toContain('LIRIK')
    expect(html).toContain('Just Chatting')
  })

  it('does not draw the bare one', () => {
    const html = render({ ...state, channelMetadataPending: ['teamliquid'] })
    expect(html).not.toContain('teamliquid')
    expect(cards(html)).toHaveLength(1)
  })

  it('draws it complete once the metadata resolves', () => {
    const html = render({
      friendDestinations: { a: ['lirik', 'teamliquid'] },
      channelMetadata: { lirik: record('lirik'), teamliquid: record('teamliquid') },
      channelMetadataPending: [],
    })
    expect(cards(html)).toHaveLength(2)
    expect(html).toContain('TeamLiquid')
    expect(html).not.toContain('>teamliquid<')
  })

  /** Holding one card back must never hold the map back. */
  it('does not block the rest of the panel', () => {
    const other = friend('b', 'Friend B', watching('b', 'lirik'))
    const html = render({
      friends: [FRIEND_A, other],
      ...state,
      channelMetadataPending: ['teamliquid'],
    })
    expect(html).toContain('LIRIK')
    expect(html).toContain('Friend A')
    expect(html).toContain('Friend B')
  })
})

describe('CASE 2 — three destinations resolving out of order', () => {
  const destinations = { a: ['lirik', 'teamliquid', 'timthetatman'] }

  /** B first. Only B is drawn; A and C are still on their way. */
  it('draws each card the moment it is complete, and no others', () => {
    const afterB = render({
      friendDestinations: destinations,
      channelMetadata: { teamliquid: record('teamliquid') },
      channelMetadataPending: ['lirik', 'timthetatman'],
    })
    expect(cards(afterB)).toHaveLength(1)
    expect(afterB).toContain('TeamLiquid')

    const afterA = render({
      friendDestinations: destinations,
      channelMetadata: { teamliquid: record('teamliquid'), lirik: record('lirik') },
      channelMetadataPending: ['timthetatman'],
    })
    expect(cards(afterA)).toHaveLength(2)

    const afterC = render({
      friendDestinations: destinations,
      channelMetadata: {
        teamliquid: record('teamliquid'),
        lirik: record('lirik'),
        timthetatman: record('timthetatman'),
      },
      channelMetadataPending: [],
    })
    expect(cards(afterC)).toHaveLength(3)
  })

  it('shows no bare intermediate card at any step', () => {
    for (const [meta, pending] of [
      [{ teamliquid: record('teamliquid') }, ['lirik', 'timthetatman']],
      [{ teamliquid: record('teamliquid'), lirik: record('lirik') }, ['timthetatman']],
    ] as const) {
      const html = render({
        friendDestinations: destinations,
        channelMetadata: meta,
        channelMetadataPending: pending,
      })
      for (const login of pending) expect(html).not.toContain(`>${login}<`)
    }
  })
})

describe('CASE 3 — metadata never arrives', () => {
  /**
   * Nothing in flight means nothing is coming. The card is drawn plain, which
   * is exactly the card this panel drew before metadata existed - a deliberate
   * degraded state rather than an accident.
   */
  it('draws the plain card once no request is open', () => {
    const html = render({
      friendDestinations: { a: ['lirik', 'teamliquid'] },
      channelMetadata: { lirik: record('lirik') },
      channelMetadataPending: [],
    })
    expect(cards(html)).toHaveLength(2)
    expect(html).toContain('teamliquid')
    // Plain: no badge, no category, no viewers.
    const bare = cards(html).find((card) => card.includes('teamliquid')) ?? ''
    expect(bare).not.toContain('LIVE')
    expect(bare).not.toContain('viewers')
  })

  it('leaves the panel usable with no metadata at all', () => {
    const html = render({
      friendDestinations: { a: ['lirik', 'teamliquid'] },
      channelMetadata: {},
      channelMetadataPending: [],
    })
    expect(cards(html)).toHaveLength(2)
    expect(html).toContain('Friend A')
    expect(html).toContain('JOIN')
  })

  /** No indefinite global loading state: there is no spinner to get stuck. */
  it('never renders a loading placeholder', () => {
    const html = render({
      friendDestinations: { a: ['lirik', 'teamliquid'] },
      channelMetadata: {},
      channelMetadataPending: ['lirik', 'teamliquid'],
    })
    expect(html).not.toContain('kb-gravity-card')
    expect(html).not.toContain('Loading')
    // The friends themselves are still reachable through the panel.
    expect(html).toContain('Friends')
  })
})

// ------------------------------------------------------------- the rule itself

describe('the readiness rule', () => {
  const model = (destinations: Record<string, string[]>, metadata: Record<string, ChannelMetadata>) =>
    gravityModel({
      friends: [{ member: FRIEND_A, presence: FRIEND_A.presence, userId: 'a' }],
      destinations,
      localActivity: { type: 'idle' },
      selfId: 'observer',
      metadata,
      now: NOW,
    })

  it('holds a pending destination with no metadata', () => {
    const sections = model({ a: ['lirik'] }, {})
    expect(awaitingEnrichment(sections[0], {}, ['lirik'])).toBe(true)
  })

  it('does not hold one that already has metadata', () => {
    const metadata = { lirik: record('lirik') }
    const sections = model({ a: ['lirik'] }, metadata)
    expect(awaitingEnrichment(sections[0], metadata, ['lirik'])).toBe(false)
  })

  it('does not hold one nobody is fetching', () => {
    const sections = model({ a: ['lirik'] }, {})
    expect(awaitingEnrichment(sections[0], {}, [])).toBe(false)
  })

  /** HERE is where the viewer already is; hiding it would remove their people. */
  it('never holds back the viewer’s own channel', () => {
    const sections = gravityModel({
      friends: [{ member: FRIEND_A, presence: FRIEND_A.presence, userId: 'a' }],
      destinations: { a: ['lirik'] },
      localActivity: { type: 'watching', platform: 'twitch', channel: 'lirik' },
      selfId: 'observer',
      metadata: {},
      now: NOW,
    })
    const here = sections.find((section) => section.kind === 'here')
    expect(here).toBeDefined()
    expect(awaitingEnrichment(here!, {}, ['lirik'])).toBe(false)
  })

  it('never holds back the quiet sections', () => {
    const offline = friend('c', 'Friend C', null)
    const sections = gravityModel({
      friends: [{ member: offline, presence: null, userId: 'c' }],
      destinations: {},
      localActivity: { type: 'idle' },
      selfId: 'observer',
      metadata: {},
      now: NOW,
    })
    for (const section of sections) {
      expect(awaitingEnrichment(section, {}, ['anything'])).toBe(false)
    }
  })

  it('changes nothing when nothing is pending', () => {
    const sections = model({ a: ['lirik', 'teamliquid'] }, {})
    expect(visibleGravity(sections, {}, [])).toEqual(sections)
  })
})

// --------------------------------------- the pending set the worker publishes

describe('the pending set comes from the metadata service', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists a channel while its request is open, and drops it when it lands', async () => {
    const queue = createCallQueue<string[], unknown>()
    const metadata = createMetadataService({
      fetcher: { fetch: (logins: string[]) => queue.fn(logins) },
      onChange: () => {},
      onError: () => {},
    })

    metadata.want(['lirik', 'teamliquid'])
    expect(metadata.inFlightChannels().sort()).toEqual(['lirik', 'teamliquid'])

    queue.drain((logins: string[]) => wire(logins))
    await settle()

    expect(metadata.inFlightChannels()).toEqual([])
    expect(Object.keys(metadata.snapshot()).sort()).toEqual(['lirik', 'teamliquid'])
  })

  /** A failure clears the pending flag, which is what un-hides the card. */
  it('drops a channel from pending when its request fails', async () => {
    const queue = createCallQueue<string[], unknown>()
    const metadata = createMetadataService({
      fetcher: { fetch: (logins: string[]) => queue.fn(logins) },
      onChange: () => {},
      onError: () => {},
    })

    metadata.want(['teamliquid'])
    expect(metadata.inFlightChannels()).toEqual(['teamliquid'])

    queue.rejectNext()
    await settle()

    expect(metadata.inFlightChannels()).toEqual([])
    expect(metadata.snapshot()).toEqual({})
  })
})
