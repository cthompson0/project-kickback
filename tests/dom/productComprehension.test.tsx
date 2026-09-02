import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { mount } from './harness'
import { BadgeShelf } from '../../src/ui/components/BadgeShelf'
import type { KickbackClient } from '../../src/client/types'

/**
 * Whether the product explains itself.
 *
 * These are comprehension guarantees rather than behaviour ones: nothing here
 * changes what Watchside does, only whether somebody can tell what it did and
 * what is still possible. They are mounted rather than rendered as markup
 * because every one of them depends on an effect resolving.
 */

const earned = (key: string, name: string, displayed = false) => ({
  key,
  name,
  description: `Brought friends to Watchside (${key}).`,
  icon: '🔗',
  issuer: 'kickback' as const,
  displayed,
})

const definition = (key: string, name: string) => ({
  key,
  name,
  description: `Brought friends to Watchside (${key}).`,
  icon: '🌱',
  issuer: 'kickback' as const,
})

async function shelf(badges: unknown[], catalog: unknown[]) {
  const client = {
    badges: async () => badges,
    badgeCatalog: async () => catalog,
    setDisplayedBadge: async () => {},
  } as unknown as KickbackClient

  const view = mount(<BadgeShelf client={client} />)
  await act(async () => {
    await Promise.resolve()
  })
  return view
}

describe('badges say what is possible, not only what happened', () => {
  const LADDER = [
    definition('referrer_1', 'Connector'),
    definition('referrer_5', 'Recruiter'),
    definition('referrer_10', 'Cultivator'),
  ]

  /**
   * THE M4.5 FINDING.
   *
   * Only earned badges were ever shown, so there was no way to learn that any
   * of this existed or how it happened.
   */
  it('shows the ladder to somebody who has earned nothing', async () => {
    const view = await shelf([], LADDER)
    const text = view.container.textContent ?? ''

    expect(text).toContain('Still to earn')
    expect(text).toContain('Connector')
    expect(text).toContain('Cultivator')
    expect(text).toContain('earned when friends you invited start using Watchside')
    view.unmount()
  })

  it('separates what is earned from what is not', async () => {
    const view = await shelf([earned('referrer_1', 'Connector')], LADDER)
    const text = view.container.textContent ?? ''

    expect(text).toContain('Watchside badges')
    expect(text).toContain('Still to earn')
    // The earned one is pressable; the unearned ones are not.
    const buttons = [...view.container.querySelectorAll('button')]
    expect(buttons.map((button) => button.textContent)).toContain('🔗Connector')
    const locked = [...view.container.querySelectorAll('.kb-badge-locked')]
    expect(locked).toHaveLength(2)
    for (const node of locked) expect(node.tagName).toBe('SPAN')
    view.unmount()
  })

  /**
   * Locked state must not be carried by colour alone - the tooltip says it in
   * words, so it survives a greyscale screen or a colour-blind reader.
   */
  it('says "not earned yet" in words, not only in grey', async () => {
    const view = await shelf([], LADDER)
    const locked = view.container.querySelector('.kb-badge-locked')!
    expect(locked.getAttribute('title')).toContain('not earned yet')
    view.unmount()
  })

  /** No pressure, no target, no counter. A ladder is not a quota. */
  it('applies no pressure to go and invite people', async () => {
    const view = await shelf([earned('referrer_1', 'Connector')], LADDER)
    const text = (view.container.textContent ?? '').toLowerCase()
    for (const forbidden of ['more to go', 'only', 'just', 'unlock', 'progress', 'keep going']) {
      expect(text, forbidden).not.toContain(forbidden)
    }
    view.unmount()
  })

  /** Nothing earned and nothing earnable is not a section worth having. */
  it('shows nothing at all when there is no ladder either', async () => {
    const view = await shelf([], [])
    expect(view.container.textContent).toBe('')
    view.unmount()
  })

  it('still works when the catalogue cannot be loaded', async () => {
    const client = {
      badges: async () => [earned('referrer_1', 'Connector')],
      badgeCatalog: async () => {
        throw new Error('down')
      },
      setDisplayedBadge: async () => {},
    } as unknown as KickbackClient

    const view = mount(<BadgeShelf client={client} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(view.container.textContent).toContain('Connector')
    expect(view.container.textContent).not.toContain('Still to earn')
    view.unmount()
  })

  /** The brand fix from M5A, checked where a user would actually read it. */
  it('carries no Kickback branding in what it shows', async () => {
    const view = await shelf([earned('referrer_1', 'Connector')], LADDER)
    const html = view.container.innerHTML
    expect(html).not.toContain('Kickback')
    view.unmount()
  })
})
