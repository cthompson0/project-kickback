import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RESIZE_EDGES } from '../../src/ui/layout/layout'

/**
 * Every direction has a grip, and every grip says what it does.
 *
 * THE BETA REPORT THIS EXISTS FOR
 *
 *   "the app is only resizeable on the bottom corners? at least the top
 *    corners too, if not the 4 sides as well for that imo"
 *   "didnt realize i could resize cuz the top wasnt letting me"
 *   "gives a hand icon for draggin the box instead"
 *
 * Those are one defect seen twice. The top of the panel is the drag handle and
 * carries `cursor: grab`, so a resize gesture there was answered with a MOVE
 * cursor - and with no grip behind it, nothing happened either. The tester
 * concluded the panel was not resizable at all.
 *
 * geometry lives in layout.test.ts; this file is about whether the geometry is
 * REACHABLE. `resizeTo` handled west and east long before this pass and neither
 * had a grip rendered, so two of the four sides were unreachable code that no
 * test noticed - which is the exact hole these assertions close.
 */

const panel = readFileSync(join(process.cwd(), 'src', 'ui', 'KickbackPanel.tsx'), 'utf8')
const css = readFileSync(join(process.cwd(), 'src', 'ui', 'kickback.css'), 'utf8')

/** Which cursor a direction should offer, by desktop convention. */
const CURSOR: Record<string, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  w: 'ew-resize',
  e: 'ew-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
}

describe('every resize direction is reachable', () => {
  it('covers all four sides and all four corners', () => {
    expect([...RESIZE_EDGES].sort()).toEqual(['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w'])
  })

  it.each([...RESIZE_EDGES])('renders a grip for %s', (edge) => {
    expect(panel).toContain(`className="kb-resize kb-resize-${edge}"`)
    expect(panel).toContain(`beginResize('${edge}')`)
  })

  it('wires no direction resizeTo cannot handle', () => {
    const wired = [...panel.matchAll(/beginResize\('([a-z]+)'\)/g)].map((m) => m[1])
    expect(wired.sort()).toEqual([...RESIZE_EDGES].sort())
  })
})

describe('every grip says what it does', () => {
  /**
   * Every declaration that reaches this class, from every rule that lists it.
   *
   * Reading the cascade rather than grepping for a string: these grips are
   * styled by grouped selectors, so `.kb-resize-ne` gets its cursor from a
   * rule whose text never contains `.kb-resize-ne {`.
   */
  function declarationsFor(cls: string): string {
    // Comments come out first. A prose comma inside one - "nw/se share one
    // axis, ne/sw the other" - otherwise splits as if it were a selector
    // separator and hides the rule that follows it.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')
    let found = ''
    for (const match of rules.matchAll(/([^{}]+){([^}]*)}/g)) {
      const selectors = match[1].split(',').map((one) => one.trim())
      if (selectors.includes(`.${cls}`)) found += match[2]
    }
    return found
  }

  it.each([...RESIZE_EDGES])('gives %s the conventional cursor', (edge) => {
    expect(declarationsFor(`kb-resize-${edge}`)).toContain(`cursor: ${CURSOR[edge]}`)
  })

  it('offers a diagonal cursor at every corner, not just the bottom two', () => {
    for (const corner of ['nw', 'ne', 'sw', 'se']) {
      expect(declarationsFor(`kb-resize-${corner}`)).toMatch(/cursor: n(wse|esw)-resize/)
    }
  })
})

describe('a control beats a grip', () => {
  /**
   * MEASURED, NOT ASSUMED.
   *
   * The north-east grip is 16px square and the collapse button sits 11px from
   * the panel's right edge, so adding that grip put it over the button's
   * corner: in Chrome, 42 of the button's 576 pixels answered a resize gesture
   * instead of a click. Raising the header's buttons above the grips took that
   * to 3, which are the button's own rounded corner.
   */
  it('puts header buttons above the grips', () => {
    const grip = /\.kb-resize \{[^}]*z-index: (\d+)/.exec(css)
    const button = /\.kb-header button \{[^}]*z-index: (\d+)/.exec(css)
    expect(grip, 'the grips should declare a z-index').toBeTruthy()
    expect(button, 'header buttons should declare a z-index').toBeTruthy()
    expect(Number(button![1])).toBeGreaterThan(Number(grip![1]))
  })

  it('gives header buttons a position, or the z-index would do nothing', () => {
    // They are flex items; without `position` the stacking order above is inert
    // and the measurement it came from would quietly stop holding.
    expect(/\.kb-header button \{[^}]*position: relative/.test(css)).toBe(true)
  })

  it('still lets the header itself drag', () => {
    expect(/\.kb-header \{[^}]*cursor: grab/.test(css)).toBe(true)
    expect(panel).toContain('className="kb-header" onPointerDown={beginDrag}')
  })
})
