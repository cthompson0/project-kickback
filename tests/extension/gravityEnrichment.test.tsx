import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { KickbackPanel } from '../../src/ui/KickbackPanel'
import {
  gravityChannels,
  gravityModel,
  gravityOpportunities,
} from '../../src/core/socialGravity'
import { INITIAL_STATE } from '../../src/client/types'
import type { Friend, KickbackClient, KickbackState } from '../../src/client/types'
import type { Presence } from '../../src/core/types'
import type { ChannelMetadata } from '../../src/core/twitchMetadata'

/**
 * Multi-destination Gravity cards must be as COMPLETE as singular ones.
 *
 * The second browser regression: three cards rendered, and two of them were
 * bare - raw lowercase logins, no live badge, no category, no viewer count, no
 * avatar. The map was right; nobody had asked Twitch about two of the three
 * channels, because the worker still derived the enrichment set from
 * `presence.channel` alone.
 *
 * So these tests assert PRESENTATION, per destination, with realistic metadata
 * fixtures - and assert that no field leaks from one destination to another,
 * which is the failure mode a shared lookup would produce.
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
  lastSeenAt: Date.now(),
})

const FRIEND_A = friend('a', 'Friend A', watching('a', 'lirik'))
const THREE = { a: ['lirik', 'teamliquid', 'timthetatman'] }

/** Realistic Twitch records, deliberately all different from each other. */
const meta = (
  login: string,
  displayName: string,
  gameName: string | null,
  viewerCount: number | null,
  live: ChannelMetadata['live'] = 'live',
): ChannelMetadata => ({
  login,
  userId: `id-${login}`,
  displayName,
  profileImageUrl: `https://static-cdn.jtvnw.net/jtv_user_pictures/${login}.png`,
  live,
  gameName,
  title: `${displayName} is streaming ${gameName ?? 'something'}`,
  viewerCount,
  startedAt: NOW - 3_600_000,
  fetchedAt: Date.now(),
})

const METADATA: Record<string, ChannelMetadata> = {
  lirik: meta('lirik', 'LIRIK', 'Escape from Tarkov', 12_400),
  teamliquid: meta('teamliquid', 'TeamLiquid', 'Counter-Strike 2', 3_150),
  timthetatman: meta('timthetatman', 'TimTheTatman', null, null, 'offline'),
}

// ------------------------------------------------------------- panel setup

function installWindow(pathname = '/somewhere_else') {
  const storage: Record<string, string> = {}
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      innerWidth: 1600,
      innerHeight: 900,
      location: { pathname, href: `https://www.twitch.tv${pathname}` },
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

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
  Reflect.deleteProperty(globalThis, 'document')
})

const OBSERVER: Partial<KickbackState> = {
  status: 'signed_in',
  identity: {
    userId: 'observer',
    displayName: 'Observer',
    avatarUrl: null,
    twitchLogin: 'observer',
    friendCode: 'KB-TEST',
    presenceVisibility: 'visible',
  },
}

function stubClient(state: Partial<KickbackState>): KickbackClient {
  const merged: KickbackState = { ...INITIAL_STATE, ...OBSERVER, ...state }
  return {
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
}

function renderPanel(state: Partial<KickbackState>, pathname = '/somewhere_else') {
  installWindow(pathname)
  return renderToStaticMarkup(<KickbackPanel client={stubClient(state)} />)
}

/**
 * The rendered destination cards, one bounded string each.
 *
 * Split on the opening tag rather than the class name, because the modifier
 * classes (`kb-gravity-card-offline`, `-here`, `-strong`) contain it too and
 * would count one card twice. Each slice is then cut at the people list, which
 * every card has - giving a comparable region that holds exactly the channel
 * identity and the enrichment, and none of the surrounding document.
 */
function cards(html: string): string[] {
  return html
    .split('<div class="kb-gravity-card')
    .slice(1)
    .map((chunk) => {
      const end = chunk.indexOf('kb-gravity-people')
      return end === -1 ? chunk : chunk.slice(0, end)
    })
}

/** The one card that names this channel. */
function cardFor(html: string, displayName: string): string {
  const found = cards(html).filter((card) => card.includes(`>${displayName}<`))
  expect(found).toHaveLength(1)
  return found[0]
}

const ENRICHED: Partial<KickbackState> = {
  friends: [FRIEND_A],
  friendDestinations: THREE,
  channelMetadata: METADATA,
}

// -------------------------------------------------- per-destination polish

describe('every multi-destination card is fully enriched', () => {
  it('uses Twitch capitalisation, not the raw login', () => {
    const html = renderPanel(ENRICHED)

    expect(html).toContain('LIRIK')
    expect(html).toContain('TeamLiquid')
    expect(html).toContain('TimTheTatman')
    // The bare lowercase logins must not be what the card is titled with.
    expect(html).not.toContain('>lirik<')
    expect(html).not.toContain('>teamliquid<')
    expect(html).not.toContain('>timthetatman<')
  })

  it('shows each destination its own category', () => {
    const html = renderPanel(ENRICHED)
    expect(cardFor(html, 'LIRIK')).toContain('Escape from Tarkov')
    expect(cardFor(html, 'TeamLiquid')).toContain('Counter-Strike 2')
  })

  it('shows each destination its own viewer count', () => {
    const html = renderPanel(ENRICHED)
    // formatViewers abbreviates; the card must carry the exact number in the
    // title attribute regardless of how it is shortened on screen.
    expect(cardFor(html, 'LIRIK')).toContain('12400 viewers')
    expect(cardFor(html, 'TeamLiquid')).toContain('3150 viewers')
  })

  it('shows the correct live state per destination', () => {
    const html = renderPanel(ENRICHED)
    expect(cardFor(html, 'LIRIK')).toContain('LIVE')
    expect(cardFor(html, 'TeamLiquid')).toContain('LIVE')
    // Twitch says this one has ended, and the card says so before JOIN.
    expect(cardFor(html, 'TimTheTatman')).toContain('OFFLINE')
  })

  it('carries each destination its own avatar', () => {
    const html = renderPanel(ENRICHED)
    for (const login of ['lirik', 'teamliquid', 'timthetatman']) {
      expect(html).toContain(`jtv_user_pictures/${login}.png`)
    }
  })

  it('offers a JOIN to each destination', () => {
    const html = renderPanel(ENRICHED)
    for (const name of ['LIRIK', 'TeamLiquid', 'TimTheTatman']) {
      expect(cardFor(html, name)).toContain('JOIN')
    }
  })

  /** The failure a shared lookup would produce. */
  it('does not leak metadata between destinations', () => {
    const html = renderPanel(ENRICHED)

    const lirik = cardFor(html, 'LIRIK')
    expect(lirik).not.toContain('Counter-Strike 2')
    expect(lirik).not.toContain('3150 viewers')

    const liquid = cardFor(html, 'TeamLiquid')
    expect(liquid).not.toContain('Escape from Tarkov')
    expect(liquid).not.toContain('12400 viewers')

    // The offline one has no category and no viewer count at all.
    const tim = cardFor(html, 'TimTheTatman')
    expect(tim).not.toContain('Escape from Tarkov')
    expect(tim).not.toContain('Counter-Strike 2')
    expect(tim).not.toContain('viewers')
  })

  /**
   * A cold cache must degrade exactly as it always did - silence, not a
   * placeholder - which is what makes an unenriched card recognisable rather
   * than merely ugly.
   */
  it('renders the pre-metadata card when nothing is known', () => {
    const html = renderPanel({ friends: [FRIEND_A], friendDestinations: THREE })
    expect(html).toContain('lirik')
    expect(html).not.toContain('LIVE')
    expect(html).not.toContain('OFFLINE')
    expect(html).not.toContain('viewers')
  })
})

// ------------------------------------- singular is unchanged by all of this

describe('singular Gravity is behaviourally unchanged', () => {
  const singular: Partial<KickbackState> = {
    friends: [FRIEND_A],
    friendDestinations: {},
    channelMetadata: METADATA,
  }

  it('renders one enriched card for a friend with no destination rows', () => {
    const html = renderPanel(singular)
    expect(cards(html)).toHaveLength(1)
    const card = cardFor(html, 'LIRIK')
    expect(card).toContain('Escape from Tarkov')
    expect(card).toContain('12400 viewers')
    expect(card).toContain('LIVE')
    expect(card).toContain('JOIN')
  })

  /**
   * The same friend, the same metadata, with and without destination data.
   * The card for their primary destination must be identical either way -
   * multi-destination is ADDITIVE, and this is what that means concretely.
   */
  it('draws the primary card identically with and without destinations', () => {
    const before = cardFor(renderPanel(singular), 'LIRIK')
    const after = cardFor(renderPanel(ENRICHED), 'LIRIK')
    expect(after).toBe(before)
  })
})

// ------------------------------------------- the enrichment set the worker asks for

describe('enrichment is requested for every destination on the map', () => {
  const members = [{ member: FRIEND_A, presence: FRIEND_A.presence, userId: 'a' }]

  /**
   * The regression, stated as the difference between the two derivations.
   *
   * The worker used to enumerate presence.activity.channel and nothing else.
   * With one friend at three destinations that asks Twitch about ONE of them,
   * and the other two render bare. gravityChannels is the derivation the map
   * itself is built from, so the two cannot disagree.
   */
  it('the old singular derivation misses two of three', () => {
    const singularDerivation = members.flatMap((entry) =>
      entry.presence?.activity.type === 'watching' ? [entry.presence.activity.channel] : [],
    )
    expect(singularDerivation).toEqual(['lirik'])
  })

  it('gravityChannels asks about all three', () => {
    expect(gravityChannels(members, THREE).sort()).toEqual([
      'lirik',
      'teamliquid',
      'timthetatman',
    ])
  })

  /** Exactly the channels the map will name - no more, no fewer. */
  it('matches the channels the model actually renders', () => {
    const sections = gravityModel({
      friends: members,
      destinations: THREE,
      localActivity: { type: 'idle' },
      selfId: 'observer',
      metadata: METADATA,
      now: Date.now(),
    })
    const rendered = sections
      .filter((section) => section.channel !== null)
      .map((section) => section.channel as string)

    expect(gravityChannels(members, THREE).sort()).toEqual(rendered.sort())
  })

  it('asks for nothing when a friend has no destinations and is not watching', () => {
    const idle = friend('b', 'Friend B', null)
    expect(gravityChannels([{ member: idle, presence: null, userId: 'b' }], {})).toEqual([])
  })

  /** The worker derives its enrichment set from this, and not by hand. */
  it('is what the worker uses', () => {
    const WORKER = readFileSync('src/background/index.ts', 'utf8')
    const wantMetadata = WORKER.slice(
      WORKER.indexOf('function wantMetadata('),
      WORKER.indexOf('function wantMetadata(') + 1_400,
    )
    expect(wantMetadata).toContain('gravityChannels(')
    // The derivation that caused the regression must not come back.
    expect(wantMetadata).not.toContain("activity?.type === 'watching'")
  })
})

// ---------------------------------------- analytics and the screen agree

describe('analytics and the rendered map cannot disagree', () => {
  /**
   * The invariant the previous regression violated: analytics reported three
   * Gravity impressions while the screen showed one.
   *
   * Both now come from gravityModel, and the exposure report is a PROJECTION
   * of it via gravityOpportunities rather than a second derivation. This
   * asserts the two agree on the actual DOM.
   */
  it('reports exactly the destinations that rendered', () => {
    const html = renderPanel(ENRICHED)

    const model = gravityModel({
      friends: [{ member: FRIEND_A, presence: FRIEND_A.presence, userId: 'a' }],
      destinations: THREE,
      localActivity: { type: 'idle' },
      selfId: 'observer',
      metadata: METADATA,
    })
    const reported = gravityOpportunities(model).map((section) => section.channel)

    expect(reported.sort()).toEqual(['lirik', 'teamliquid', 'timthetatman'])
    // One card on screen per reported opportunity.
    expect(cards(html)).toHaveLength(reported.length)
    for (const channel of reported) {
      expect(html).toContain(METADATA[channel].displayName as string)
    }
  })

  it('reports one when one renders', () => {
    const html = renderPanel({
      friends: [FRIEND_A],
      friendDestinations: {},
      channelMetadata: METADATA,
    })
    const model = gravityModel({
      friends: [{ member: FRIEND_A, presence: FRIEND_A.presence, userId: 'a' }],
      destinations: {},
      localActivity: { type: 'idle' },
      selfId: 'observer',
      metadata: METADATA,
    })
    expect(gravityOpportunities(model)).toHaveLength(1)
    expect(cards(html)).toHaveLength(1)
  })
})
