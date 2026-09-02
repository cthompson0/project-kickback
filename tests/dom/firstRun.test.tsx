import { describe, expect, it } from 'vitest'
import { flush, mount } from './harness'
import { KickbackPanel } from '../../src/ui/KickbackPanel'
import { INITIAL_STATE } from '../../src/client/types'
import type { KickbackClient, KickbackState } from '../../src/client/types'

/**
 * What a stranger reads, in the order they read it.
 *
 * THE FAILURE THIS GUARDS AGAINST
 *
 * M5A rewrote the zero-friend state carefully and it is genuinely good. The
 * SIGNED-OUT card, which every person meets one screen EARLIER, said "See who's
 * around." - four words naming neither Twitch, nor friends, nor watching, shown
 * to somebody who arrived from a listing promising the opposite and who is about
 * to be asked to approve a Twitch authorisation.
 *
 * That is the shape of first-run rot: each screen is written well in isolation,
 * nobody reads them in sequence, and the weakest one is the first. So these
 * assertions are about the SEQUENCE - what is answered by the time a person has
 * to decide something.
 *
 * They deliberately assert MEANING, not exact sentences. Copy should be free to
 * improve; what must not happen is a screen quietly losing the question it
 * answers.
 */

function clientFor(state: Partial<KickbackState>): KickbackClient {
  const full = { ...INITIAL_STATE, ...state }
  return {
    getState: () => full,
    subscribe: (listener: (s: KickbackState) => void) => {
      listener(full)
      return () => {}
    },
    signIn: () => {},
    signOut: () => {},
    retry: () => {},
    track: () => {},
    recordJoin: () => {},
    reportExposure: () => {},
    reportActivity: () => {},
    reportInvite: () => {},
    reportCampaign: () => {},
    selectSession: () => {},
    markKindSeen: () => {},
    markGroupRead: () => {},
    suggestFriends: async () => [],
    inviteCode: async () => '0123456789ABCDEFGHJKMN',
    referralSummary: async () => ({ successful: 0, pending: 0 }),
    badges: async () => [],
    badgeCatalog: async () => [],
    searchUsers: async () => [],
  } as unknown as KickbackClient
}

/** Everything a person could actually read, with hidden text excluded. */
function reads(state: Partial<KickbackState>): string {
  const view = mount(<KickbackPanel client={clientFor(state)} />)
  flush()
  try {
    const out: string[] = []
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = (node.textContent ?? '').trim()
        if (text) out.push(text)
        return
      }
      const el = node as HTMLElement
      /*
       * Hidden in EITHER sense. A mutation that added `hidden` to the sign-in
       * note went undetected against an earlier version of this walker, because
       * the text was still in the DOM - which is exactly the failure a person
       * would experience and the test would not. `hidden` and aria-hidden both
       * mean "nobody reads this".
       */
      if (el.hasAttribute?.('hidden')) return
      if (el.getAttribute?.('aria-hidden') === 'true') return
      for (const child of Array.from(node.childNodes)) walk(child)
    }
    walk(view.container)
    return out.join(' ')
  } finally {
    view.unmount()
  }
}

const IDENTITY = {
  userId: 'u1',
  displayName: 'Sam',
  twitchLogin: 'sam',
  avatarUrl: null,
  friendCode: 'ABCD-EFGH',
  presenceVisibility: 'friends',
} as never

describe('the signed-out card, which is the first screen anybody sees', () => {
  const text = () => reads({ status: 'signed_out' })

  it('says what Watchside does before asking for anything', () => {
    /*
     * The specific regression: a headline that describes no product. It must
     * name what happens - friends, watching, and joining them - not a mood.
     */
    const copy = text().toLowerCase()
    expect(copy, 'the first screen never mentions friends').toContain('friend')
    expect(copy, 'the first screen never mentions Twitch').toContain('twitch')
    expect(copy).toMatch(/watching|watch/)
  })

  it('does not go back to saying only that somebody is around', () => {
    expect(text().toLowerCase()).not.toMatch(/^.{0,80}see who.s around\.?\s*continue/i)
  })

  it('answers why it wants a Twitch sign-in, before Twitch asks', () => {
    /*
     * The next screen is Twitch's consent page, which asks to view the channels
     * you follow. A stranger meeting that with no preparation is a stranger who
     * cancels - so the answer has to be on this side of the click.
     */
    const copy = text().toLowerCase()
    expect(copy).toMatch(/sign in with twitch|continue with twitch/)
    expect(copy, 'nothing reassures them about the password').toContain('password')
  })

  it('still offers exactly one action', () => {
    // "Signing in should not feel like onboarding" is the rule this screen was
    // written to, and it survives: one button, no tour, no carousel.
    const view = mount(<KickbackPanel client={clientFor({ status: 'signed_out' })} />)
    flush()
    try {
      const buttons = Array.from(view.container.querySelectorAll('.kb-signin button'))
      expect(buttons).toHaveLength(1)
    } finally {
      view.unmount()
    }
  })
})

describe('the zero-friend state, which is the second', () => {
  const text = () => reads({ status: 'signed_in', identity: IDENTITY, friends: [] })

  it('leads with what Watchside does rather than with what is missing', () => {
    expect(text()).toContain('See where your friends are watching')
  })

  it('explains what will happen once a friend is watching', () => {
    const copy = text().toLowerCase()
    expect(copy).toMatch(/show up here|they show up/)
    expect(copy).toMatch(/jump in|join/)
  })

  it('offers a next action rather than a dead end', () => {
    expect(text()).toContain('Find friends')
  })
})

describe('friends present but nobody watching', () => {
  const withFriends = {
    status: 'signed_in' as const,
    identity: IDENTITY,
    friends: [
      {
        user: { id: 'f1', username: 'alex', displayName: 'Alex' },
        presence: {
          userId: 'f1',
          status: 'online',
          activity: { kind: 'idle' },
          since: Date.now() - 60_000,
          updatedAt: Date.now(),
        },
      },
    ] as never,
  }

  it('says the map is quiet rather than looking broken', () => {
    /*
     * The state that used to be indistinguishable from having no friends at
     * all. A stranger here must understand that Watchside is working and there
     * is simply nothing on.
     */
    const copy = reads(withFriends).toLowerCase()
    expect(copy).toMatch(/nobody is watching anything right now/)
    expect(copy, 'it does not say what will change').toMatch(/when a friend starts watching/)
  })

  it('does not ask them to find friends again when they have some', () => {
    // Repeating the zero-friend ask here would read as "you did it wrong".
    expect(reads(withFriends)).not.toContain('Add a friend or two and it starts working')
  })
})

describe('the failure state a stranger can actually meet', () => {
  it('names the problem, keeps it human, and offers a retry', () => {
    const copy = reads({
      status: 'error',
      error: 'Watchside can’t reach its server right now.',
    })
    expect(copy).toContain('Watchside is offline')
    expect(copy).toContain('Try again')
    // No infrastructure words, no stack shapes - see src/core/errors.ts.
    expect(copy.toLowerCase()).not.toMatch(/supabase|postgres|typeerror|fetch failed|undefined/)
  })
})
