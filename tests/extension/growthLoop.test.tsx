import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { KickbackPanel } from '../../src/ui/KickbackPanel'
import {
  INVITE_LANDING_BASE,
  INVITE_PARAM,
  codeFromUrl,
  inviteLinkFor,
  isInviteCode,
  normalizeInviteCode,
} from '../../src/core/invites'
import { mutualBucket } from '../../src/core/analytics'
import { INITIAL_STATE } from '../../src/client/types'
import type { KickbackClient, KickbackState } from '../../src/client/types'
import type { FriendSuggestion } from '../../src/background/supabaseBackend'

/**
 * The growth loop on the client: how a code gets in, and what the panel shows.
 *
 * The server rules - who may be suggested, what counts as a successful
 * referral, who may award a badge - are proven against real PostgreSQL in
 * tests/db/growthLoop.test.ts. What is left for here is the wiring: the URL
 * contract that carries a code from a shared link into the extension without a
 * new permission, and whether the surfaces actually render.
 */

const CODE = 'ABCDEFGHJKMNPQRSTVWXYZ'.slice(0, 22)

// ------------------------------------------------------------ the URL contract

describe('invite codes travel by URL', () => {
  it('accepts a well-formed code', () => {
    expect(isInviteCode(CODE)).toBe(true)
  })

  it('rejects the ambiguous letters friend codes also exclude', () => {
    // I, L, O and U are absent so a code read aloud cannot become a different
    // valid code.
    expect(isInviteCode('IIIIIIIIIIIIIIIIIIIIII')).toBe(false)
    expect(isInviteCode('OOOOOOOOOOOOOOOOOOOOOO')).toBe(false)
  })

  it('rejects the wrong length', () => {
    expect(isInviteCode(CODE.slice(0, 21))).toBe(false)
    expect(isInviteCode(`${CODE}A`)).toBe(false)
  })

  it('builds a link people can share', () => {
    const link = inviteLinkFor(CODE)
    expect(link.startsWith(INVITE_LANDING_BASE)).toBe(true)
    expect(link).toContain(CODE)
  })

  /** The landing page's continue button, carrying the code to Twitch. */
  it('reads the code back off a Twitch URL', () => {
    expect(codeFromUrl(`https://www.twitch.tv/?${INVITE_PARAM}=${CODE}`)).toBe(CODE)
  })

  it('reads the code off the landing link itself', () => {
    expect(codeFromUrl(inviteLinkFor(CODE))).toBe(CODE)
  })

  it('ignores an ordinary Twitch URL', () => {
    expect(codeFromUrl('https://www.twitch.tv/lirik')).toBeNull()
    expect(codeFromUrl('https://www.twitch.tv/lirik?referrer=raid')).toBeNull()
  })

  it('ignores a parameter that is not a code', () => {
    expect(codeFromUrl(`https://www.twitch.tv/?${INVITE_PARAM}=nope`)).toBeNull()
  })

  /** A malformed escape is somebody else's URL, not a crash. */
  it('survives a broken percent-escape', () => {
    expect(() => codeFromUrl(`https://www.twitch.tv/?${INVITE_PARAM}=%E0%A4%A`)).not.toThrow()
    expect(codeFromUrl(`https://www.twitch.tv/?${INVITE_PARAM}=%E0%A4%A`)).toBeNull()
  })

  it('finds the code among other parameters', () => {
    expect(codeFromUrl(`https://www.twitch.tv/lirik?a=1&${INVITE_PARAM}=${CODE}&b=2`)).toBe(CODE)
  })

  // ---------------------------------------------------- what people paste

  it('accepts the code in lower case', () => {
    expect(normalizeInviteCode(CODE.toLowerCase())).toBe(CODE)
  })

  it('accepts the code with whitespace around it', () => {
    expect(normalizeInviteCode(`  ${CODE}  `)).toBe(CODE)
  })

  it('accepts a whole pasted link', () => {
    expect(normalizeInviteCode(inviteLinkFor(CODE))).toBe(CODE)
  })

  it('refuses anything that is not a code', () => {
    expect(normalizeInviteCode('')).toBeNull()
    expect(normalizeInviteCode('hello')).toBeNull()
    expect(normalizeInviteCode('https://example.com/')).toBeNull()
  })
})

// ------------------------------------------------------------ mutual buckets

describe('social proof is bucketed, never raw', () => {
  it('buckets one, a few, and many', () => {
    expect(mutualBucket(1)).toBe('one')
    expect(mutualBucket(2)).toBe('two_to_three')
    expect(mutualBucket(3)).toBe('two_to_three')
    expect(mutualBucket(4)).toBe('four_plus')
    expect(mutualBucket(40)).toBe('four_plus')
  })

  it('treats zero as the smallest bucket rather than throwing', () => {
    expect(mutualBucket(0)).toBe('one')
  })
})

// --------------------------------------------------------------- the panel

function installWindow() {
  const storage: Record<string, string> = {}
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      innerWidth: 1600,
      innerHeight: 900,
      location: { pathname: '/lirik', href: 'https://www.twitch.tv/lirik' },
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
      setTimeout: () => 0,
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

const SUGGESTIONS: FriendSuggestion[] = [
  {
    userId: 'mike',
    displayName: 'Mike',
    avatarUrl: null,
    twitchLogin: 'mike_tv',
    mutualCount: 1,
  },
  {
    userId: 'jen',
    displayName: 'Jen',
    avatarUrl: null,
    twitchLogin: 'jen_tv',
    mutualCount: 3,
  },
]

function render(state: Partial<KickbackState> = {}) {
  installWindow()
  const merged: KickbackState = {
    ...INITIAL_STATE,
    status: 'signed_in',
    identity: {
      userId: 'me',
      displayName: 'Me',
      avatarUrl: null,
      twitchLogin: 'me',
      friendCode: 'KB-TEST',
      presenceVisibility: 'visible',
    },
    ...state,
  }
  const client = {
    getState: () => merged,
    subscribe: (listener: (s: KickbackState) => void) => {
      listener(merged)
      return () => {}
    },
    reportActivity: () => {},
    reportInvite: () => {},
    markSeen: () => {},
    markKindSeen: () => {},
    markGroupRead: () => {},
    selectSession: () => {},
    track: () => {},
    recordJoin: () => {},
    reportExposure: () => {},
    searchEmotes: async () => [],
    suggestFriends: async () => SUGGESTIONS,
    inviteCode: async () => CODE,
    referralSummary: async () => ({ successful: 2, pending: 0 }),
    badges: async () => [],
    setDisplayedBadge: async () => {},
    claimInvite: async () => 'attributed',
    sendFriendRequest: async () => 'sent',
  } as unknown as KickbackClient
  return renderToStaticMarkup(<KickbackPanel client={client} />)
}

/**
 * The growth surfaces live under Find friends, which is behind a button, so a
 * server-rendered panel shows the friends list rather than them. What is
 * asserted here is that the panel renders at all with the new state fields and
 * does not leak an invite code into the ordinary view.
 */
describe('the panel carries the growth state without showing it', () => {
  it('renders with a referral count present', () => {
    const html = render({ referralCount: 2 })
    expect(html).toContain('kb-panel')
  })

  /** An invite code is not something to paint on the main surface. */
  it('does not put the invite code on the friends list', () => {
    expect(render({ referralCount: 2 })).not.toContain(CODE)
  })

  it('renders with a displayed badge present', () => {
    const html = render({
      displayedBadge: {
        key: 'referrer_1',
        name: 'Connector',
        description: 'Brought a friend to Watchside.',
        icon: '🔗',
        issuer: 'kickback',
        displayed: true,
      },
    })
    expect(html).toContain('kb-panel')
  })
})

// ------------------------------------------------------ gathering emphasis

describe('a gathering reads differently from one friend', () => {
  const CSS = readFileSync('src/ui/kickback.css', 'utf8')

  it('gives a gathering its own accent edge', () => {
    expect(CSS).toContain('.kb-gravity-card-strong')
    const block = CSS.slice(CSS.lastIndexOf('.kb-gravity-card-strong'))
    expect(block).toContain('border-left')
  })

  it('has a treatment for the spelled-out count', () => {
    expect(CSS).toContain('.kb-gravity-count-strong')
  })
})
