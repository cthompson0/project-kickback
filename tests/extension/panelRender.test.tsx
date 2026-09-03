import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { KickbackPanel } from '../../src/ui/KickbackPanel'
import { AccountCard } from '../../src/ui/components/AuthStates'
import { INITIAL_STATE } from '../../src/client/types'
import type { KickbackClient, KickbackState } from '../../src/client/types'

/**
 * What the panel actually puts in the DOM.
 *
 * The geometry is tested exhaustively in layout.test.ts; what is checked here
 * is that the geometry is *wired up* - that the numbers reach the element that
 * is positioned by them, that the grips exist, and that the header is a drag
 * handle. The bug that made this worth testing was exactly that gap: the
 * layout was computed perfectly, stored perfectly, and applied to an element
 * whose parent did the positioning, so the panel never moved.
 */

/**
 * The smallest window the panel will render against.
 *
 * The panel reads its collapsed flag and saved layout synchronously so it can
 * paint in the right place on the first frame, and it asks Twitch what channel
 * is open. All three want a window; none of them wants a real browser.
 */
function installWindow(storage: Record<string, string> = {}, pathname = '/lirik') {
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
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fake })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {} },
  })
  return fake
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
  Reflect.deleteProperty(globalThis, 'document')
})

function render(state: Partial<KickbackState>, storage: Record<string, string> = {}) {
  installWindow(storage)
  return renderToStaticMarkup(<KickbackPanel client={stubClient(state)} />)
}

function stubClient(state: Partial<KickbackState> = {}): KickbackClient {
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
    searchEmotes: async () => [],
  } as unknown as KickbackClient
}

const signedIn: Partial<KickbackState> = {
  status: 'signed_in',
  identity: {
    userId: 'u1',
    displayName: 'Test',
    avatarUrl: null,
    twitchLogin: 'test',
    friendCode: 'KB-TEST',
    presenceVisibility: 'visible',
  },
}

describe('the panel carries its own geometry', () => {
  it('positions and sizes itself from custom properties', () => {
    const html = render(signedIn)
    // All four must land on the element that is actually positioned.
    expect(html).toMatch(/class="kb-panel[^"]*"[^>]*style="[^"]*--kb-x:/)
    expect(html).toContain('--kb-y:')
    expect(html).toContain('--kb-w:')
    expect(html).toContain('--kb-h:')
  })

  it('places the geometry on the panel, not on an ancestor', () => {
    // The parent .kb-root is a plain full-viewport layer; custom properties
    // set on the panel would never reach it, because they inherit downwards.
    const html = render(signedIn)
    const panelTag = html.slice(html.indexOf('<div class="kb-panel'))
    expect(panelTag.slice(0, panelTag.indexOf('>'))).toContain('--kb-x:')
  })

  it('offers a grip on both bottom corners and the bottom edge', () => {
    const html = render(signedIn)
    // Both corners, because the panel can be parked on either side of the
    // window and only one of them is the natural one there.
    expect(html).toContain('kb-resize-sw')
    expect(html).toContain('kb-resize-se')
    expect(html).toContain('kb-resize-s"')
  })

  it('renders a header to drag by', () => {
    const html = render(signedIn)
    expect(html).toContain('kb-header')
  })
})

describe('the collapsed launcher', () => {
  const collapsed = (state: Partial<KickbackState>) =>
    render(state, { 'kickback:collapsed': '1' })

  it('is positioned by the same geometry as the panel', () => {
    const html = collapsed(signedIn)
    expect(html).toContain('kb-launcher')
    expect(html).toContain('--kb-x:')
    expect(html).toContain('--kb-y:')
  })

  it('still shows an unread badge after the panel has been moved', () => {
    const html = collapsed({
      ...signedIn,
      unread: [{ key: 'k', kind: 'friend_request', count: 2 }],
    })
    expect(html).toContain('kb-launcher-badge')
    expect(html).toContain('kb-launcher')
  })

  it('renders no panel chrome at all', () => {
    const html = collapsed(signedIn)
    expect(html).not.toContain('kb-resize')
    expect(html).not.toContain('kb-header')
  })
})

describe('resetting the layout', () => {
  it('is offered in the account card', () => {
    installWindow()
    const html = renderToStaticMarkup(
      <AccountCard
        // The badge shelf reads through the client; an empty one renders nothing.
        client={{ badges: async () => [] } as unknown as KickbackClient}
        identity={signedIn.identity!}
        onSignOut={() => {}}
        onDeleted={() => {}}
        measurementReadiness={null}
        onVisibilityChange={() => {}}
        preferences={{ gatheringNotifications: true }}
        onPreferencesChange={() => {}}
        mutedUserIds={[]}
        knownPeople={[]}
        onUnmute={() => {}}
        blocked={[]}
        onUnblock={() => {}}
        onFeedback={() => {}}
        onClose={() => {}}
      onResetLayout={() => {}}
      />,
    )
    expect(html).toContain('Reset layout')
    // Next to Sign out, which is where people look for panel-level controls.
    expect(html.indexOf('Reset layout')).toBeLessThan(html.indexOf('Sign out'))
  })
})

describe('the launcher badge means what a badge means', () => {
  /**
   * THE BETA REPORT THIS EXISTS FOR.
   *
   *   "the number badge made me think i had 2 notifications"
   *
   * It was showing how many friends were watching the same channel. A small
   * numeric bubble on a top-nav control means "this many things are waiting
   * for you" - it is what every other control up there means by it - so
   * passive presence was borrowing the language of unread items and the
   * tester read it exactly as the convention told them to.
   *
   * The distinction already existed in the state: `unread` is requests and
   * gatherings, things a person can act on. That half keeps its number. The
   * presence half becomes a dot.
   */
  const collapsed = (state: Partial<KickbackState>) =>
    render(state, { 'kickback:collapsed': '1' })

  /** A friend watching the same channel the test window is on. */
  const watchingHere = (id: string) => ({
    user: { id, username: id, displayName: id, avatarUrl: null },
    presence: {
      userId: id,
      status: 'online' as const,
      activity: { type: 'watching' as const, platform: 'twitch' as const, channel: 'lirik' },
      since: Date.now(),
    },
  })

  it('shows a dot, not a count, when friends are simply present', () => {
    const html = collapsed({
      ...signedIn,
      friends: [watchingHere('a'), watchingHere('b')] as never,
    })

    expect(html).toContain('kb-launcher-here')
    // The exact defect: no digit rendered onto the launcher.
    expect(html).not.toContain('kb-launcher-badge')
    expect(html).not.toMatch(/kb-launcher-here[^>]*>\s*\d/)
  })

  it('still puts a number on things that are actually waiting', () => {
    const html = collapsed({
      ...signedIn,
      unread: [{ key: 'k', kind: 'friend_request', count: 2 }],
    })

    expect(html).toContain('kb-launcher-badge-request')
    expect(html).toContain('>1<')
    expect(html).not.toContain('kb-launcher-here')
  })

  it('never shows both at once', () => {
    const html = collapsed({
      ...signedIn,
      friends: [watchingHere('a')] as never,
      unread: [{ key: 'k', kind: 'friend_request', count: 1 }],
    })

    expect(html).toContain('kb-launcher-badge-request')
    expect(html).not.toContain('kb-launcher-here')
  })

  it('says in words what the dot cannot', () => {
    /*
     * Removing the numeral must not remove the information. The title is the
     * button's accessible name, so this is also the only thing a screen
     * reader gets - it used to say "Open Watchside" no matter what.
     */
    const present = collapsed({
      ...signedIn,
      friends: [watchingHere('a'), watchingHere('b')] as never,
    })
    expect(present).toContain('2 friends here')

    const one = collapsed({ ...signedIn, friends: [watchingHere('a')] as never })
    expect(one).toContain('1 friend here')

    const waiting = collapsed({
      ...signedIn,
      unread: [{ key: 'k', kind: 'friend_request', count: 1 }],
    })
    expect(waiting).toContain('1 waiting')

    const quiet = collapsed(signedIn)
    expect(quiet).toContain('Open Watchside')
    expect(quiet).not.toContain('here')
  })
})
