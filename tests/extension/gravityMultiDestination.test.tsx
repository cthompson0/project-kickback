import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { KickbackPanel } from '../../src/ui/KickbackPanel'
import { SocialGravity } from '../../src/ui/components/SocialGravity'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import { expandDestinations, socialGravity, GRAVITY_THRESHOLD } from '../../src/core/socialGravity'
import { INITIAL_STATE } from '../../src/client/types'
import type { Friend, KickbackClient, KickbackState } from '../../src/client/types'
import type { Activity, Presence } from '../../src/core/types'

/**
 * One friend, three streams, on the OBSERVER'S screen.
 *
 * WHY THIS IS A PANEL TEST AND NOT A COMPONENT TEST
 *
 * The defect was not in the expansion and not in the clustering; both were
 * correct and both were tested. It was in the WIRING. KickbackPanel computed
 * the multi-destination map, handed it to the analytics exposure report, and
 * rendered `<SocialGravity friends={friends} />` beside it - a component which
 * clustered the plain singular friends list on its own. Every unit test passed
 * and the feature reached the screen at exactly one destination.
 *
 * A test of SocialGravity alone would not have caught that, because
 * SocialGravity was doing something reasonable with what it was given. So the
 * primary assertions here render the whole panel and count cards.
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

const IDLE: Activity = { type: 'idle' }

/** Friend A, at all three of the destinations from the brief. */
const FRIEND_A = friend('a', 'Friend A', watching('a', 'lirik'))
const THREE = {
  a: ['lirik', 'teamliquid', 'timthetatman'],
}

// ------------------------------------------------------------- panel setup

function installWindow(pathname = '/somewhere_else') {
  const storage: Record<string, string> = {}
  const fake = {
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
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fake })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {} },
  })
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
  Reflect.deleteProperty(globalThis, 'document')
})

function stubClient(state: Partial<KickbackState>): KickbackClient {
  const merged: KickbackState = { ...INITIAL_STATE, ...state }
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

function renderPanel(state: Partial<KickbackState>, pathname = '/somewhere_else') {
  installWindow(pathname)
  return renderToStaticMarkup(<KickbackPanel client={stubClient({ ...OBSERVER, ...state })} />)
}

/** The rendered destination cards, one string each. */
function cards(html: string): string[] {
  return html.split('kb-gravity-card').slice(1)
}

// ------------------------------------------------ the observer's whole panel

describe('the panel renders a friend at every destination', () => {
  it('shows all three destinations, not just the legacy primary', () => {
    const html = renderPanel({ friends: [FRIEND_A], friendDestinations: THREE })

    expect(html).toContain('lirik')
    expect(html).toContain('teamliquid')
    expect(html).toContain('timthetatman')
  })

  /** The assertion the browser evidence was actually about: three separate cards. */
  it('gives each destination its own card', () => {
    const html = renderPanel({ friends: [FRIEND_A], friendDestinations: THREE })
    const named = cards(html).filter((card) =>
      ['lirik', 'teamliquid', 'timthetatman'].some((channel) => card.includes(channel)),
    )
    expect(named.length).toBeGreaterThanOrEqual(3)
  })

  it('draws three destination cards for one friend', () => {
    const html = renderPanel({ friends: [FRIEND_A], friendDestinations: THREE })
    expect(cards(html).length).toBeGreaterThanOrEqual(3)
  })

  /**
   * The exact shape of the defect: destinations present in state, absent from
   * the screen. If the panel ever stops passing them down, this fails.
   */
  it('does not collapse the friend to their single presence channel', () => {
    const withDestinations = renderPanel({ friends: [FRIEND_A], friendDestinations: THREE })
    const without = renderPanel({ friends: [FRIEND_A], friendDestinations: {} })

    expect(without).not.toContain('teamliquid')
    expect(without).toContain('lirik')
    // The only difference is the destination data, and it must be visible.
    expect(withDestinations).not.toBe(without)
  })

  it('still renders a friend who has no destination rows', () => {
    // A v0.4.1 client publishes only presence.channel and appears in no
    // destination read. They must not vanish from the map.
    const html = renderPanel({ friends: [FRIEND_A], friendDestinations: {} })
    expect(html).toContain('lirik')
    expect(html).toContain('Friend A')
  })

  it('puts the friend on HERE as well when the viewer is on one of them', () => {
    const html = renderPanel({ friends: [FRIEND_A], friendDestinations: THREE }, '/teamliquid')
    // Present at all three; one of them is where the viewer already is.
    expect(html).toContain('lirik')
    expect(html).toContain('timthetatman')
    expect(html).toContain('watching with you')
  })

  it('groups two friends who share one of several destinations', () => {
    const b = friend('b', 'Friend B', watching('b', 'teamliquid'))
    const html = renderPanel({
      friends: [FRIEND_A, b],
      friendDestinations: { ...THREE, b: ['teamliquid'] },
    })
    // Two people on teamliquid is a gathering, and the flame says so.
    expect(html).toContain('2 friends')
  })
})

// ------------------------------------------------------- the component alone

describe('SocialGravity consumes the destinations it is given', () => {
  const wrap = (node: React.ReactNode) =>
    renderToStaticMarkup(<ChannelNameProvider people={[]} seen={{}}>{node}</ChannelNameProvider>)

  const stub = () =>
    ({
      sendFriendRequest: async () => 'req',
      removeFriend: async () => {},
      track: () => {},
      recordJoin: () => {},
      reportExposure: () => {},
    }) as unknown as KickbackClient

  const cardContext = {
    selfId: 'observer',
    viewerActivity: IDLE,
    friendIds: new Set(['a']),
    outgoingRequestIds: new Set<string>(),
  }

  it('renders one card per destination', () => {
    const html = wrap(
      <SocialGravity
        friends={[FRIEND_A]}
        destinations={THREE}
        localActivity={IDLE}
        onRemove={() => {}}
        client={stub()}
        cardContext={cardContext}
      />,
    )
    expect(html).toContain('lirik')
    expect(html).toContain('teamliquid')
    expect(html).toContain('timthetatman')
  })

  /** Omitting the prop must behave exactly as it did before 0025. */
  it('renders the singular map when given no destinations', () => {
    const html = wrap(
      <SocialGravity
        friends={[FRIEND_A]}
        localActivity={IDLE}
        onRemove={() => {}}
        client={stub()}
        cardContext={cardContext}
      />,
    )
    expect(html).toContain('lirik')
    expect(html).not.toContain('teamliquid')
  })
})

// --------------------------------------------------- input and qualification

describe('what reaches Gravity, and what it does with it', () => {
  const input = () =>
    expandDestinations(
      [{ member: FRIEND_A, presence: FRIEND_A.presence, userId: 'a' }],
      THREE,
    )

  it('arrives as three friend-destination relationships', () => {
    expect(input()).toHaveLength(3)
    expect(
      input().map((entry) =>
        entry.presence?.activity.type === 'watching' ? entry.presence.activity.channel : null,
      ),
    ).toEqual(['lirik', 'teamliquid', 'timthetatman'])
  })

  it('carries one presence per destination, all the same person', () => {
    for (const entry of input()) expect(entry.userId).toBe('a')
  })

  /**
   * The qualification rule, stated as a test so it cannot be misremembered.
   *
   * There is no minimum. Every channel with at least one visible friend is a
   * section, and GRAVITY_THRESHOLD only decides whether it is *emphasised* as
   * a gathering. A single friend at a destination is still a destination.
   */
  it('makes every destination a section, with no minimum', () => {
    const sections = socialGravity(input(), IDLE, Date.now(), 'observer')
    const destinations = sections.filter((section) => section.kind === 'destination')
    expect(destinations.map((section) => section.channel).sort()).toEqual([
      'lirik',
      'teamliquid',
      'timthetatman',
    ])
    for (const section of destinations) expect(section.count).toBe(1)
  })

  it('ranks all three as joinable opportunities', () => {
    const sections = socialGravity(input(), IDLE, Date.now(), 'observer')
    expect(sections.filter((section) => section.canJoin)).toHaveLength(3)
    expect(sections.filter((section) => section.rank !== null).map((s) => s.rank)).toEqual([
      1, 2, 3,
    ])
  })

  it('needs two people before a destination reads as a gathering', () => {
    expect(GRAVITY_THRESHOLD).toBe(2)
  })
})
