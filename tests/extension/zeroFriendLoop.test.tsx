import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { EmptyFriends } from '../../src/ui/components/AuthStates'
import { KickbackPanel } from '../../src/ui/KickbackPanel'
import { INITIAL_STATE } from '../../src/client/types'
import type { KickbackClient, KickbackState } from '../../src/client/types'

/**
 * What a stranger sees before Watchside has anything to show them.
 *
 * THE PROBLEM THIS FIXES
 *
 * Watchside becomes valuable once a social graph exists and says almost nothing
 * before then. A new account met a panel that reported it was quiet, a
 * suggestion list that rendered literally nothing, and a friend-growth surface
 * behind a button labelled "Add" — with no explanation anywhere of what the
 * product was waiting for. Every one of those is correct behaviour and none of
 * them is comprehensible.
 *
 * The states these tests separate are the whole point:
 *
 *   no friends              → explain the product, then ask for friends
 *   friends, nobody watching → the system is working; people are just offline
 *   somebody watching       → unchanged, and must stay unchanged
 *
 * Collapsing the first two is the specific regression that would undo this.
 */

/*
 * The same window stub the established gravity render tests use.
 *
 * Copied rather than shared because it is a fixture, not behaviour: a helper
 * imported by two suites becomes a thing to keep in step, and this one only has
 * to be enough for one panel to mount.
 */
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

const empty = (loading = false) => {
  installWindow()
  return renderToStaticMarkup(<EmptyFriends loading={loading} onFindFriends={() => {}} />)
}

const NOW = Date.now()

const friend = (id: string, name: string, channel: string | null) => ({
  user: { id, username: id, displayName: name, avatarUrl: null, accentColor: '#ff8452' },
  presence: {
    userId: id,
    status: 'online' as const,
    activity: channel
      ? { type: 'watching' as const, platform: 'twitch' as const, channel }
      : { type: 'idle' as const },
    since: NOW - 60_000,
    lastSeen: new Date(NOW).toISOString(),
  },
})

/**
 * The whole panel, as the established gravity tests render it.
 *
 * Rendering SocialGravity in isolation needs a prop shape this test has no
 * business knowing; the panel is also what a person actually sees, so the
 * assertions are about the product rather than about one component's contract.
 */
function panel(state: Partial<KickbackState>): string {
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
    localActivity: { type: 'idle' },
    ...state,
  } as KickbackState
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
    badges: async () => [],
  } as unknown as KickbackClient
  return renderToStaticMarkup(<KickbackPanel client={client} />)
}

const quiet = () => panel({ friends: [friend('u1', 'Alice', null)] as never })
const watching = () => panel({ friends: [friend('u1', 'Alice', 'lirik')] as never })

// ------------------------------------------------------ the zero-friend state

describe('a brand-new account is told what Watchside is for', () => {
  /**
   * The promise before the instruction. Somebody who has just installed an
   * extension they do not understand needs to know what it will do before being
   * asked to go and find people.
   */
  it('explains the product, not just that the panel is empty', () => {
    const markup = empty()
    expect(markup).toContain('See where your friends are watching')
    expect(markup).toContain('watch together')
  })

  it('says what it needs, and offers the way to give it', () => {
    const markup = empty()
    expect(markup).toContain('Add a friend or two')
    expect(markup).toContain('Find friends')
  })

  /** It must not read as an error or a fault. */
  it('never suggests something is broken', () => {
    const markup = empty().toLowerCase()
    for (const forbidden of ['error', 'failed', 'problem', 'sorry', 'unavailable']) {
      expect(markup, forbidden).not.toContain(forbidden)
    }
  })

  it('says nothing prescriptive while it is still loading', () => {
    expect(empty(true)).toContain('Loading')
    expect(empty(true)).not.toContain('Add a friend or two')
  })
})

// ------------------------------------------------- friends, nobody watching

describe('friends but nobody watching is a different state entirely', () => {
  /**
   * THE DISTINCTION THAT MATTERS MOST.
   *
   * Somebody who has just added their first friend needs to know the system is
   * working. Showing them the zero-friend message would tell them the opposite.
   */
  it('says the map is quiet rather than asking for friends again', () => {
    const markup = quiet()
    expect(markup).toContain('Nobody is watching anything right now')
    expect(markup).toContain('jump in')
  })

  it('does not repeat the zero-friend messaging', () => {
    const markup = quiet()
    expect(markup).not.toContain('Add a friend or two')
    expect(markup).not.toContain('See where your friends are watching')
  })

  it('is the opposite state from the zero-friend one, not a variation of it', () => {
    // Nothing they share should let one be mistaken for the other.
    expect(quiet()).not.toContain('Find friends')
    expect(empty()).not.toContain('Nobody is watching anything right now')
  })
})

describe('somebody watching is unchanged', () => {
  /**
   * The idle explanation must disappear the moment there is anything real to
   * show. A permanent caption above live cards would be noise.
   */
  it('drops the idle explanation once a friend is on a channel', () => {
    const markup = watching()
    expect(markup).not.toContain('Nobody is watching anything right now')
  })
})

// ------------------------------------------------- the friend-growth entrance

describe('the way to find friends is reachable without guessing', () => {
  const PANEL = readFileSync('src/ui/KickbackPanel.tsx', 'utf8')

  /**
   * The button is the only permanent door to search, suggestions and invites.
   * Its visible label has to stay short - four tabs have to survive the 280px
   * minimum width - so the full name lives in the accessible name.
   */
  it('names itself for anybody who cannot see the icon', () => {
    const button = PANEL.slice(PANEL.indexOf('kb-add-btn'), PANEL.indexOf('+ Add'))
    expect(button).toContain('aria-label="Add friends"')
    expect(button).toContain('title="Add friends"')
    expect(button).toContain('aria-expanded')
  })

  /** The zero state carries the discovery weight the short label cannot. */
  it('is reachable from the zero-friend state without using the button', () => {
    expect(empty()).toContain('Find friends')
  })

  it('is a real button, so keyboard and screen readers get it for free', () => {
    const button = PANEL.slice(PANEL.indexOf('kb-add-btn') - 200, PANEL.indexOf('+ Add'))
    expect(button).toContain('type="button"')
  })
})

// ------------------------------------------------------------- suggestions

describe('suggestions never vanish inside the surface built to show them', () => {
  const SOURCE = readFileSync('src/ui/components/GrowFriends.tsx', 'utf8')

  /**
   * THE REGRESSION THIS PREVENTS.
   *
   * The component used to return null for an empty list, so a user who had
   * deliberately opened find-friends could not tell whether the feature was
   * empty, broken or absent - and it is empty exactly when they are new,
   * because suggestions come from friends of friends.
   */
  it('says why it is empty rather than disappearing', () => {
    const branch = SOURCE.slice(
      SOURCE.indexOf('if (suggestions.length === 0)'),
      SOURCE.indexOf('return (\n    <div className="kb-suggestions">'),
    )
    expect(branch).toContain('Nobody to suggest yet')
    expect(branch).toContain('friends already')
    // And it points at the two things that work from a standing start.
    expect(branch).toContain('Search')
    expect(branch).toContain('invite')
  })

  /** Loading is not the same as empty, and must not flash the empty copy. */
  it('shows nothing at all while still loading', () => {
    expect(SOURCE).toContain('if (!suggestions) return null')
  })

  /**
   * The impression must mean somebody could see something. It used to fire at
   * the fetch, counting every empty result as an impression of a surface that
   * renders nothing.
   */
  it('records an impression from the render, not the fetch', () => {
    const worker = readFileSync('src/background/index.ts', 'utf8')
    const fetchFn = worker.slice(
      worker.indexOf('suggestFriends: async () => {'),
      worker.indexOf('inviteCode: async () => {'),
    )
    expect(fetchFn).not.toContain('friend_suggestion_impression')

    expect(SOURCE).toContain("client.track('friend_suggestion_impression'")
    // Guarded so an empty list emits nothing.
    expect(SOURCE).toContain('if (!suggestions || suggestions.length === 0) return')
  })

  /** A re-render is not a second impression. */
  it('cannot emit twice for one open of the surface', () => {
    expect(SOURCE).toContain('const seen = useRef(false)')
    expect(SOURCE).toContain('if (seen.current) return')
    expect(SOURCE).toContain('seen.current = true')
  })
})
