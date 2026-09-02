import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { flush, mount } from './harness'
import { KickbackPanel } from '../../src/ui/KickbackPanel'
import { createDemoClient } from '../../src/client/demo'

/**
 * The accessibility floor for a public beta.
 *
 * M5B left a contrast audit and a screen-reader pass unfinished and said so.
 * This closes the part that a machine can decide, which is most of it: whether
 * every control a person can reach has a name, whether state is exposed rather
 * than only drawn, and whether anything focusable is unreachable or out of
 * order.
 *
 * WHAT THIS IS NOT. It is not a WCAG certification and no such claim is made.
 * Contrast ratios are checked separately against the token palette, and neither
 * that nor this substitutes for one real pass with a screen reader - which is
 * recorded as a narrow final acceptance item rather than pretended away.
 *
 * WHY IT MOUNTS THE WHOLE PANEL. Component-level assertions pass while the
 * assembled product is unusable; the interesting failures are the button that
 * lost its label when it moved into a row, and the dialog that traps nothing.
 * The demo client is the only client that can drive every surface without a
 * backend, so it is what the audit walks.
 */

/** Everything a keyboard or a screen reader can land on. */
const FOCUSABLE =
  'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"]), [role="button"]'

/**
 * The name a screen reader would announce, by the parts of the accname
 * algorithm that actually apply here: aria-label, then aria-labelledby, then
 * text content, then title, then an image's alt.
 *
 * Deliberately not a full accname implementation - this covers what the panel
 * uses, and a control whose name depends on anything subtler than this is a
 * control whose name is too clever.
 */
function accessibleName(el: Element): string {
  const label = el.getAttribute('aria-label')
  if (label && label.trim()) return label.trim()

  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim()
    if (parts) return parts
  }

  // Text that is hidden from the accessibility tree does not name anything.
  const visible = Array.from(el.querySelectorAll('[aria-hidden="true"]'))
  const clone = el.cloneNode(true) as Element
  for (const hidden of Array.from(clone.querySelectorAll('[aria-hidden="true"]'))) {
    hidden.remove()
  }
  void visible
  const text = (clone.textContent ?? '').trim()
  if (text) return text

  const title = el.getAttribute('title')
  if (title && title.trim()) return title.trim()

  const img = el.querySelector('img[alt]')
  const alt = img?.getAttribute('alt')
  if (alt && alt.trim()) return alt.trim()

  return ''
}

function describeEl(el: Element): string {
  const cls = el.getAttribute('class') ?? ''
  const testid = el.getAttribute('data-testid') ?? ''
  return `<${el.tagName.toLowerCase()}${testid ? ` data-testid="${testid}"` : ''}${
    cls ? ` class="${cls}"` : ''
  }>`
}

function panel() {
  const view = mount(<KickbackPanel client={createDemoClient()} />)
  flush()
  return view
}

describe('every control a person can reach has a name', () => {
  it('names every focusable element in the assembled panel', () => {
    /*
     * The failure this catches is an icon-only button - the commonest
     * accessibility defect in a compact panel, and one that is invisible to
     * everybody who can see the icon.
     */
    const view = panel()
    try {
      const unnamed = Array.from(view.container.querySelectorAll(FOCUSABLE))
        .filter((el) => !el.hasAttribute('disabled'))
        .filter((el) => accessibleName(el) === '')
        .map(describeEl)

      expect(unnamed, `unnamed controls: ${unnamed.join(', ')}`).toEqual([])
    } finally {
      view.unmount()
    }
  })

  it('gives every text input a label of some kind', () => {
    const view = panel()
    try {
      const unlabelled = Array.from(
        view.container.querySelectorAll('input:not([type="hidden"]), textarea'),
      )
        .filter((el) => {
          if (el.getAttribute('aria-label')?.trim()) return false
          if (el.getAttribute('aria-labelledby')?.trim()) return false
          if (el.getAttribute('placeholder')?.trim()) return false
          const id = el.getAttribute('id')
          if (id && view.container.querySelector(`label[for="${id}"]`)) return false
          return !el.closest('label')
        })
        .map(describeEl)

      expect(unlabelled, `unlabelled inputs: ${unlabelled.join(', ')}`).toEqual([])
    } finally {
      view.unmount()
    }
  })
})

describe('focus order is the reading order', () => {
  it('uses no positive tabindex anywhere', () => {
    /*
     * A positive tabindex jumps the element ahead of everything in the document,
     * which reorders the whole page and not just this panel. There is no case
     * in a panel where it is the right answer.
     */
    const view = panel()
    try {
      const positive = Array.from(view.container.querySelectorAll('[tabindex]'))
        .filter((el) => Number(el.getAttribute('tabindex')) > 0)
        .map(describeEl)
      expect(positive).toEqual([])
    } finally {
      view.unmount()
    }
  })

  it('does not leave a focusable element hidden from assistive technology', () => {
    // Focusable but aria-hidden is the worst combination: a keyboard lands on
    // something a screen reader refuses to describe.
    const view = panel()
    try {
      const trapped = Array.from(view.container.querySelectorAll(FOCUSABLE))
        .filter((el) => el.closest('[aria-hidden="true"]'))
        .map(describeEl)
      expect(trapped).toEqual([])
    } finally {
      view.unmount()
    }
  })
})

describe('state is exposed, not only drawn', () => {
  it('marks the selected tab as pressed or selected', () => {
    /*
     * Which tab is active is carried by colour and weight for a sighted user.
     * Without an exposed state it is carried by nothing at all for anybody else.
     */
    const view = panel()
    try {
      const tabs = Array.from(view.container.querySelectorAll('.kb-tab, [role="tab"]'))
      expect(tabs.length).toBeGreaterThan(0)

      const stated = tabs.filter(
        (tab) =>
          tab.hasAttribute('aria-selected') ||
          tab.hasAttribute('aria-pressed') ||
          tab.hasAttribute('aria-current'),
      )
      expect(stated.length, 'tabs carrying no exposed selected state').toBe(tabs.length)
    } finally {
      view.unmount()
    }
  })

  it('marks anything that expands as expanded or collapsed', () => {
    const view = panel()
    try {
      // Any control whose whole job is to open something must say whether it is
      // open. Where none exists in this state, the assertion is vacuous and
      // harmless; where one does, it must be stated.
      const openers = Array.from(view.container.querySelectorAll('[aria-controls]'))
      for (const opener of openers) {
        expect(
          opener.hasAttribute('aria-expanded'),
          `${describeEl(opener)} controls something but never says whether it is open`,
        ).toBe(true)
      }
    } finally {
      view.unmount()
    }
  })
})

describe('the panel has a structure, not just a shape', () => {
  it('gives the panel an accessible landmark or label', () => {
    const view = panel()
    try {
      const root = view.container.firstElementChild
      expect(root).not.toBeNull()
      const labelled =
        view.container.querySelector('[role="region"], [role="complementary"], aside, section') ??
        (root?.hasAttribute('aria-label') ? root : null)
      expect(
        labelled,
        'the panel is an unlabelled div, so it is announced as nothing in particular',
      ).not.toBeNull()
    } finally {
      view.unmount()
    }
  })

  it('does not skip heading levels where headings are used', () => {
    const view = panel()
    try {
      const levels = Array.from(view.container.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) =>
        Number(h.tagName.slice(1)),
      )
      for (let i = 1; i < levels.length; i += 1) {
        expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1)
      }
    } finally {
      view.unmount()
    }
  })
})

/**
 * The Stream Room lifecycle event, which had been registered and emitted by
 * nothing since 0020.
 *
 * `automatic_room_entered` fires when the contextual tab BECOMES AVAILABLE,
 * whether or not anybody looks at it. Whether the tab is ever actually opened -
 * the entire navigation bet behind Stream Rooms - was unmeasured, which for a
 * feature whose open question is "would anybody miss this" was the one number
 * worth having.
 */
describe('opening a Stream Room is recorded', () => {
  it('emits automatic_room_opened once per opening, not per render', async () => {
    const tracked: Array<{ name: string; props: Record<string, unknown> }> = []
    const client = {
      ...createDemoClient(),
      track: (name: string, props: Record<string, unknown>) => {
        tracked.push({ name, props })
      },
    } as unknown as Parameters<typeof KickbackPanel>[0]['client']

    const view = mount(<KickbackPanel client={client} />)
    flush()
    try {
      const opens = tracked.filter((e) => e.name === 'automatic_room_opened')
      // The demo client may or may not present a session; what must hold either
      // way is that no opening is double-counted.
      const perChannel = new Map<string, number>()
      for (const open of opens) {
        const channel = String(open.props.channel ?? 'unknown')
        perChannel.set(channel, (perChannel.get(channel) ?? 0) + 1)
      }
      for (const [channel, count] of perChannel) {
        expect(count, `${channel} counted more than once for one opening`).toBe(1)
      }

      // Re-rendering the same state must not emit again.
      const before = tracked.filter((e) => e.name === 'automatic_room_opened').length
      view.render(<KickbackPanel client={client} />)
      flush()
      expect(tracked.filter((e) => e.name === 'automatic_room_opened')).toHaveLength(before)
    } finally {
      view.unmount()
    }
  })

  it('is wired to the surface actually being open, not merely available', () => {
    /*
     * Read from source rather than simulated, because the distinction is the
     * whole point of the event and a test that only counted emissions would
     * pass just as well if it fired on availability.
     */
    const panel = readFileSync('src/ui/KickbackPanel.tsx', 'utf8')
    expect(panel).toContain('automatic_room_opened')
    expect(panel).toMatch(/open={sessionOpen}/)
    // Availability is a different variable and must not be the trigger.
    expect(panel).not.toMatch(/open={sessionAvailable}/)
  })
})
