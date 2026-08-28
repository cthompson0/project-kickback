import { beforeEach, describe, expect, it } from 'vitest'
import { useState } from 'react'
import { act } from 'react'
import { useStorageSync } from '../../src/ui/useStorageSync'
import { flush, mount } from './harness'

/**
 * The panel is one thing, so it should be in one place.
 *
 * Collapsed state and geometry have always been in localStorage, which is
 * origin-scoped and therefore already shared by every twitch.tv tab. What was
 * missing is that nothing listened: the value was read once in a useState
 * initialiser, so a NEW tab inherited it and an already-open tab never moved.
 * That is what made the panel feel tab-local. See
 * docs/reports/friends-beta-investigation-2026-08-27.md §4 (#7).
 *
 * These tests drive the hook rather than the whole panel, because the hook is
 * the whole of the behaviour and mounting KickbackPanel would drag in a client,
 * a layout and an analytics provider to prove one listener works.
 */

function Probe({ storageKey }: { storageKey: string }) {
  const [value, setValue] = useState<string | null>('initial')
  useStorageSync(storageKey, setValue)
  return <span data-testid="value">{value === null ? '<null>' : value}</span>
}

function shown(container: HTMLElement): string {
  return container.querySelector('[data-testid="value"]')?.textContent ?? ''
}

/** A write from ANOTHER tab. The real event never fires in the writing tab. */
function storageEvent(init: Partial<StorageEventInit>): StorageEvent {
  return new StorageEvent('storage', {
    storageArea: window.localStorage,
    ...init,
  })
}

describe('cross-tab panel state', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.localStorage.clear()
  })

  it('applies a value another tab wrote', () => {
    const view = mount(<Probe storageKey="kickback:collapsed" />)
    expect(shown(view.container)).toBe('initial')

    act(() => {
      window.dispatchEvent(storageEvent({ key: 'kickback:collapsed', newValue: '1' }))
    })
    flush()

    expect(shown(view.container)).toBe('1')
    view.unmount()
  })

  it('ignores a different key', () => {
    const view = mount(<Probe storageKey="kickback:collapsed" />)

    act(() => {
      window.dispatchEvent(storageEvent({ key: 'kickback:layout', newValue: 'x' }))
    })
    flush()

    expect(shown(view.container)).toBe('initial')
    view.unmount()
  })

  /** A null key means the whole area was cleared, which concerns every key. */
  it('treats a cleared storage area as a reset', () => {
    const view = mount(<Probe storageKey="kickback:collapsed" />)

    act(() => {
      window.dispatchEvent(storageEvent({ key: null, newValue: null }))
    })
    flush()

    expect(shown(view.container)).toBe('<null>')
    view.unmount()
  })

  it('ignores an event from a different storage area', () => {
    const view = mount(<Probe storageKey="kickback:collapsed" />)

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'kickback:collapsed',
          newValue: '1',
          storageArea: window.sessionStorage,
        }),
      )
    })
    flush()

    expect(shown(view.container)).toBe('initial')
    view.unmount()
  })

  it('stops listening once the panel is gone', () => {
    const view = mount(<Probe storageKey="kickback:collapsed" />)
    view.unmount()

    // No listener, so nothing to update and nothing to throw. A leaked
    // listener on an unmounted tree is how a "cannot update unmounted
    // component" warning becomes a real memory leak in a long Twitch session.
    expect(() => {
      window.dispatchEvent(storageEvent({ key: 'kickback:collapsed', newValue: '1' }))
    }).not.toThrow()
  })
})
