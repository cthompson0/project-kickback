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
        identity={signedIn.identity!}
        onSignOut={() => {}}
        onVisibilityChange={() => {}}
        preferences={{ gatheringNotifications: true }}
        onPreferencesChange={() => {}}
        mutedUserIds={[]}
        knownPeople={[]}
        onUnmute={() => {}}
        blocked={[]}
        onUnblock={() => {}}
        onResetLayout={() => {}}
      />,
    )
    expect(html).toContain('Reset layout')
    // Next to Sign out, which is where people look for panel-level controls.
    expect(html.indexOf('Reset layout')).toBeLessThan(html.indexOf('Sign out'))
  })
})
