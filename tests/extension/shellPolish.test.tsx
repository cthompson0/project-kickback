import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { UserCard } from '../../src/ui/components/UserCard'
import type { UserCardContext } from '../../src/ui/components/UserCard'
import { AccountCard } from '../../src/ui/components/AuthStates'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import type { KickbackClient } from '../../src/client/types'
import type { Presence, User } from '../../src/core/types'

/**
 * The shell around Kickback: the surfaces it paints, and the ways out of them.
 *
 * All three of these came out of somebody actually using the thing rather than
 * out of a design. A card that let the page show through its own text. A
 * settings panel whose only exit was pressing the avatar that opened it. A
 * management list that was fine at one entry and would have been a scrolling
 * wall at fifty. None of them broke a test; all of them were obvious in a
 * screenshot.
 */

const NOW = 1_700_000_000_000

const THEM: User = {
  id: 'them',
  username: 'anoterostv',
  displayName: 'AnoterosTV',
  avatarUrl: null,
  accentColor: '#ff8452',
}

const IDENTITY = {
  userId: 'me',
  displayName: 'MySelf',
  twitchLogin: 'myself',
  friendCode: 'ABC123',
  avatarUrl: null,
  presenceVisibility: 'visible' as const,
}

const browsing = (): Presence => ({
  userId: 'them',
  status: 'online',
  activity: { type: 'browsing', platform: 'twitch' },
  since: NOW,
  lastSeenAt: Date.now(),
})

function stubClient(): KickbackClient {
  return {
    blockUser: async () => {},
    unblockUser: async () => {},
    setUserMuted: () => {},
    removeFriend: async () => {},
    sendFriendRequest: async () => 'req',
  } as unknown as KickbackClient
}

function context(overrides: Partial<UserCardContext> = {}): UserCardContext {
  return {
    selfId: 'me',
    viewerActivity: { type: 'idle' },
    friendIds: new Set(['them']),
    outgoingRequestIds: new Set(),
    ...overrides,
  }
}

function card(ctx: UserCardContext = context()) {
  return renderToStaticMarkup(
    <ChannelNameProvider people={[]} seen={{}}>
      <UserCard
        user={THEM}
        presence={browsing()}
        client={stubClient()}
        context={ctx}
        onClose={() => {}}
      />
    </ChannelNameProvider>,
  )
}

function installWindow() {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      innerWidth: 1600,
      innerHeight: 900,
      location: { pathname: '/lirik', href: 'https://www.twitch.tv/lirik' },
      addEventListener: () => {},
      removeEventListener: () => {},
      matchMedia: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelector: () => null,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  })
}

function account(
  blocked: { user: { id: string; displayName: string } }[],
  muted: string[] = [],
  calls: string[] = [],
) {
  installWindow()
  return renderToStaticMarkup(
    <AccountCard
      identity={IDENTITY}
      onSignOut={() => calls.push('signOut')}
      onVisibilityChange={() => calls.push('visibility')}
      preferences={{ gatheringNotifications: true }}
      onPreferencesChange={() => calls.push('preferences')}
      mutedUserIds={muted}
      knownPeople={muted.map((id) => ({ id, displayName: `Muted ${id}` }))}
      onUnmute={() => calls.push('unmute')}
      blocked={blocked}
      onUnblock={() => calls.push('unblock')}
      onClose={() => calls.push('close')}
      onResetLayout={() => calls.push('reset')}
    />,
  )
}

// -------------------------------------------------------- the card surface

describe('the user card is a surface, not a filter', () => {
  const css = readFileSync(join(process.cwd(), 'src', 'ui', 'kickback.css'), 'utf8')

  const rule = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`)
    if (at < 0) throw new Error(`no rule for ${selector}`)
    return css.slice(at, css.indexOf('\n}', at))
  }

  it('paints an opaque background', () => {
    /*
     * THE BUG. The card used --kb-bg, which is 97% opaque and is paired with a
     * backdrop blur on the panel. That is the right recipe against a video page
     * and the wrong one over our own text: opened on a busy Gravity card, 3% of
     * unblurred names and channels came through behind its own names and
     * channels, and text ghosting under text does not read as translucency - it
     * reads as broken rendering.
     */
    expect(rule('.kb-usercard')).toContain('var(--kb-bg-popover)')
    expect(rule('.kb-usercard')).not.toContain('var(--kb-bg)')

    const token = css.match(/--kb-bg-popover:\s*([^;]+);/)?.[1]?.trim()
    expect(token).toBeTruthy()
    // No alpha channel in any form. A hex triple or a bare rgb(), nothing else.
    expect(token).not.toMatch(/rgba|hsla|\/\s*[\d.]+%?\s*\)/)
    expect(token).toMatch(/^#[0-9a-f]{6}$|^rgb\(/i)
  })

  it('still sits above the content it covers', () => {
    // Opacity is only half of it: a card painted solid and stacked underneath
    // would be worse than the bug it replaced.
    expect(rule('.kb-usercard')).toContain('z-index')
  })

  it('escapes the scrolling body it is laid out in', () => {
    /*
     * The opaque background was necessary and was not sufficient.
     *
     * The card is laid out below its cluster, inside .kb-body - and a scroll
     * container clips its absolutely-positioned descendants. On a panel nobody
     * has resized, the body can be shorter than the card, so the card was
     * cropped to nothing and the names behind it stayed readable. That looked
     * exactly like transparency and was not.
     *
     * These are the two halves of the fix that a refactor must not quietly
     * drop. What it actually LOOKS like is asserted in a real browser, by the
     * card-coverage scenario in scripts/verify-test-lab.mjs - a stylesheet
     * cannot answer "is the card what you see", which is why the defect
     * survived a suite that only read CSS.
     */
    const source = readFileSync(
      join(process.cwd(), 'src', 'ui', 'components', 'UserCard.tsx'),
      'utf8',
    )
    expect(source).toContain("card.style.position = 'fixed'")
    // Clamped to the panel, so escaping the body never means escaping Kickback.
    expect(source).toContain(".closest('.kb-panel')")
    expect(source).toContain('ResizeObserver')
  })

  it('keeps every action it had', () => {
    const html = card()
    for (const action of ['Profile', '>Mute<', 'Remove friend', '>Block<']) {
      expect(html).toContain(action)
    }
  })

  it('still asks before blocking', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'ui', 'components', 'UserCard.tsx'),
      'utf8',
    )
    expect(source).toContain('kb-usercard-confirm')
    expect(source).not.toMatch(/\bconfirm\(/)
    // And the confirmation is not on screen until it is asked for.
    expect(card()).not.toContain('kb-usercard-confirm')
  })
})

// ------------------------------------------------------ closing the account

describe('the account panel can be dismissed', () => {
  it('offers a close control with an accessible name', () => {
    const html = account([])
    expect(html).toContain('aria-label="Close account panel"')
    // A real button, so it is focusable and reachable by keyboard without help.
    expect(html).toMatch(/<button[^>]*class="kb-account-close"/)
  })

  it('changes nothing by existing', () => {
    /*
     * Closing a settings view should be the one action in it that cannot cost
     * you anything - not a sign-out, not a layout reset, not an account change.
     * So the control owns no state and calls one thing.
     */
    const calls: string[] = []
    const html = account([], [], calls)
    expect(calls).toEqual([])
    expect(html).toContain('kb-account-close')
    expect(html).toContain('Sign out')
    expect(html).toContain('Reset layout')
  })

  it('lets Escape through to whatever is open in front of it', () => {
    /*
     * Both the user card and the account panel listen for Escape. The card
     * listens in CAPTURE and marks the event handled; the panel listens in
     * bubble and stands down when it was. One press closes the innermost thing,
     * which is what a person pressing Escape means by it.
     */
    const cardSource = readFileSync(
      join(process.cwd(), 'src', 'ui', 'components', 'UserCard.tsx'),
      'utf8',
    )
    expect(cardSource).toContain("window.addEventListener('keydown', onKey, true)")
    expect(cardSource).toContain('event.preventDefault()')

    const panelSource = readFileSync(join(process.cwd(), 'src', 'ui', 'KickbackPanel.tsx'), 'utf8')
    expect(panelSource).toContain('event.defaultPrevented')
    expect(panelSource).toContain('setAccountOpen(false)')
  })
})

// ------------------------------------------------ rosters that stay bounded

describe('the management lists do not grow the panel forever', () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      user: { id: `u${index}`, displayName: `Person ${index}` },
    }))

  it('scrolls inside itself rather than pushing Sign out off the bottom', () => {
    const html = account(many(60))
    expect(html).toContain('kb-manage-scroll')
    // Everyone is still rendered and still reversible - the cap is on height,
    // not on who is listed.
    expect(html).toContain('Person 59')
    expect((html.match(/Unblock/g) ?? []).length).toBe(60)
    expect(html).toContain('Sign out')
  })

  it('bounds the muted roster the same way', () => {
    const muted = Array.from({ length: 40 }, (_, index) => `u${index}`)
    const html = account([], muted)
    expect((html.match(/kb-manage-scroll/g) ?? []).length).toBe(1)
    expect((html.match(/Unmute/g) ?? []).length).toBe(40)
  })

  it('looks no different at one', () => {
    // The common case must be untouched: below the cap nothing scrolls and
    // nothing about the list reads as constrained.
    const html = account(many(1))
    expect(html).toContain('Blocked · 1')
    expect(html).toContain('Person 0')
  })

  it('keeps the two rosters separate', () => {
    const html = account(many(2), ['m1', 'm2'])
    expect(html).toContain('Muted · 2')
    expect(html).toContain('Blocked · 2')
    expect(html.indexOf('Muted ·')).toBeLessThan(html.indexOf('Blocked ·'))
  })
})
