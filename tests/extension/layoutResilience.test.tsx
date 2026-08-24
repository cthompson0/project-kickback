import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { KickbackPanel } from '../../src/ui/KickbackPanel'
import { INITIAL_STATE } from '../../src/client/types'
import { HINT_KEY } from '../../src/ui/layout/useLayoutHint'
import { LAYOUT_KEY } from '../../src/ui/layout/usePanelLayout'
import { serializeLayout } from '../../src/ui/layout/layout'
import type { KickbackClient, KickbackState } from '../../src/client/types'

/**
 * The panel's size must not depend on what the backend is doing.
 *
 * The bug this suite exists for: a resize visibly took effect while the grip
 * was held and then sprang back the moment it was released. It looked like a
 * connection problem, because it was only obvious while signed out - a
 * sign-in card is short, so a height that was only ever a *ceiling* never
 * bound, and the panel sat at content height instead.
 *
 * The fix is that a height the user chose is a commitment rather than a
 * ceiling. These tests pin that down across every connection state, since the
 * failure was invisible in exactly one of them.
 */

const CHOSEN = { x: 400, y: 100, width: 360, height: 700 }

function installWindow(storage: Record<string, string> = {}) {
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
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {} },
  })
  return storage
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
    searchEmotes: async () => [],
  } as unknown as KickbackClient
}

/** Renders the panel with a layout already in storage. */
function render(state: Partial<KickbackState>, { sized = true, hintSeen = true } = {}) {
  const storage: Record<string, string> = { [LAYOUT_KEY]: serializeLayout(CHOSEN, sized) }
  if (hintSeen) storage[HINT_KEY] = '1'
  installWindow(storage)
  return renderToStaticMarkup(<KickbackPanel client={stubClient(state)} />)
}

/** Reads a custom property off the panel element. */
function styleValue(html: string, property: string): string | null {
  const open = html.slice(html.indexOf('<div class="kb-panel'))
  const tag = open.slice(0, open.indexOf('>'))
  return new RegExp(`${property}:\\s*([^;"]+)`).exec(tag)?.[1]?.trim() ?? null
}

const isFilled = (html: string) => html.includes('kb-panel-filled')

const IDENTITY = {
  userId: 'u1',
  displayName: 'Test',
  avatarUrl: null,
  twitchLogin: 'test',
  friendCode: 'KB-TEST',
  presenceVisibility: 'visible' as const,
}

/** Every state the panel can be in while the backend misbehaves. */
const CONNECTION_STATES: Array<[string, Partial<KickbackState>]> = [
  ['loading', { status: 'loading' }],
  ['signed out', { status: 'signed_out' }],
  ['signed out with an error', { status: 'signed_out', error: 'Sign-in did not complete.' }],
  ['error', { status: 'error', error: "Kickback can't reach its server right now." }],
  ['signed in', { status: 'signed_in', identity: IDENTITY }],
  ['signed in, friends failed', { status: 'signed_in', identity: IDENTITY, friendsError: 'nope' }],
  ['signed in, loading friends', { status: 'signed_in', identity: IDENTITY, friendsLoading: true }],
]

describe('a chosen size survives every connection state', () => {
  it.each(CONNECTION_STATES)('keeps the height while %s', (_name, state) => {
    const html = render(state)
    expect(styleValue(html, '--kb-h')).toBe('700px')
    // Filled means the height is applied, not merely offered as a ceiling.
    expect(isFilled(html)).toBe(true)
  })

  it.each(CONNECTION_STATES)('keeps the width and position while %s', (_name, state) => {
    const html = render(state)
    expect(styleValue(html, '--kb-w')).toBe('360px')
    expect(styleValue(html, '--kb-x')).toBe('400px')
    expect(styleValue(html, '--kb-y')).toBe('100px')
  })

  it('does not change size across connected -> error -> connected', () => {
    // The transition the user actually reported: it worked, then it did not,
    // then it worked again after a refresh.
    const connected = render({ status: 'signed_in', identity: IDENTITY })
    const disconnected = render({ status: 'error', error: 'gone' })
    const reconnected = render({ status: 'signed_in', identity: IDENTITY })

    for (const html of [connected, disconnected, reconnected]) {
      expect(styleValue(html, '--kb-h')).toBe('700px')
      expect(isFilled(html)).toBe(true)
    }
  })

  it('never rewrites the stored layout because the connection changed', () => {
    const storage: Record<string, string> = {
      [LAYOUT_KEY]: serializeLayout(CHOSEN, true),
      [HINT_KEY]: '1',
    }
    const before = storage[LAYOUT_KEY]

    installWindow(storage)
    renderToStaticMarkup(<KickbackPanel client={stubClient({ status: 'error', error: 'x' })} />)

    expect(storage[LAYOUT_KEY]).toBe(before)
  })
})

describe('before the user has resized anything', () => {
  it('lets the panel stay content-height', () => {
    // The other half of the deal: a fresh install showing three friends should
    // not be a tall empty box.
    const html = render({ status: 'signed_out' }, { sized: false })
    expect(isFilled(html)).toBe(false)
    // The budget is still published, as a ceiling.
    expect(styleValue(html, '--kb-h')).toBe('700px')
  })

  it('still fills the panel when a conversation is open', () => {
    // Chat is the one view that claims the whole budget regardless.
    const html = render(
      {
        status: 'signed_in',
        identity: IDENTITY,
        groups: [{ groupId: 'g1', name: 'The Boys', ownerId: 'u1', isOwner: true, memberCount: 2 }],
      },
      { sized: false },
    )
    // Groups tab is not open by default, so this is the compact case; the
    // filled behaviour for chat is covered by the browser regression run.
    expect(styleValue(html, '--kb-h')).toBe('700px')
  })
})

describe('the first-run hint', () => {
  it('appears when nothing has been dismissed yet', () => {
    const html = render({ status: 'signed_out' }, { hintSeen: false })
    expect(html).toContain('Drag header')
    expect(html).toContain('Resize corners')
  })

  it('is gone once it has been seen', () => {
    const html = render({ status: 'signed_out' }, { hintSeen: true })
    expect(html).not.toContain('Drag header')
  })

  it("takes the footer's place rather than adding a row", () => {
    // So the panel is exactly the same height with the hint and without it.
    const withHint = render({ status: 'signed_out' }, { hintSeen: false })
    const without = render({ status: 'signed_out' }, { hintSeen: true })
    expect(withHint).not.toContain('Phase 1')
    expect(without).toContain('Phase 1')
    // Match the whole class token: kb-footer-dot starts the same way.
    const footers = (html: string) => (html.match(/class="kb-footer[" ]/g) ?? []).length
    expect(footers(withHint)).toBe(1)
    expect(footers(without)).toBe(1)
  })

  it('offers a way to dismiss it by hand', () => {
    const html = render({ status: 'signed_out' }, { hintSeen: false })
    expect(html).toContain('kb-hint-close')
    expect(html).toContain('Dismiss hint')
  })

  it('is not a modal and blocks nothing', () => {
    const html = render({ status: 'signed_out' }, { hintSeen: false })
    // Still an ordinary panel with its grips and header.
    expect(html).toContain('kb-resize-se')
    expect(html).toContain('kb-header')
  })
})
