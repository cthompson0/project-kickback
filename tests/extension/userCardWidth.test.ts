import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The user card's width comes from whatever opened it.
 *
 * `.kb-usercard` is `position: absolute; left: 6px; right: 6px`, so its box is
 * resolved against the nearest POSITIONED ancestor. That makes every surface
 * that opens a card responsible for being wide enough, which is an invariant
 * nothing enforced - and Social Gravity broke it: it anchored the card to
 * `.kb-gravity-person`, a flex item in a wrapping row about as wide as one
 * avatar and a name. The popup came out ~78px, "AnoterosTV" ellipsised to
 * "Anot...", and every control wrapped onto its own line.
 *
 * These tests make the invariant explicit, for all four surfaces, so the next
 * one to open a card cannot quietly reintroduce it.
 */

const CSS = readFileSync('src/ui/kickback.css', 'utf8')

/**
 * Every declaration for a selector, from EVERY rule that names it.
 *
 * The stylesheet splits some selectors across two blocks - .kb-row has its flex
 * layout in one place and its positioning in another - so reading only the
 * first would test half a rule and then pass or fail for the wrong reason.
 */
function rule(selector: string): string {
  const blocks: string[] = []
  let at = CSS.indexOf(`${selector} {`)
  while (at >= 0) {
    blocks.push(CSS.slice(at, CSS.indexOf('}', at)))
    at = CSS.indexOf(`${selector} {`, at + 1)
  }
  if (blocks.length === 0) throw new Error(`no rule for ${selector}`)
  return blocks.join('\n')
}

function hasRule(selector: string): boolean {
  return CSS.includes(`${selector} {`)
}

/**
 * Every element a UserCard is rendered inside, and therefore every element
 * whose width the popup inherits.
 *
 * Kept as a list rather than discovered, because the point is that adding a
 * fifth surface should require a decision here.
 */
const ANCHORS = [
  { selector: '.kb-row', surface: 'PersonRow' },
  { selector: '.kb-msg', surface: 'group chat' },
  { selector: '.kb-cluster-row', surface: 'group roster' },
  { selector: '.kb-gravity-card', surface: 'Social Gravity' },
]

describe('every surface anchors the card to something panel-width', () => {
  for (const { selector, surface } of ANCHORS) {
    it(`${surface} (${selector}) is a positioning context`, () => {
      expect(rule(selector)).toContain('position: relative')
    })

    it(`${surface} (${selector}) is not a flex item in a wrapping row`, () => {
      /*
       * The specific shape that broke: a block-level element fills its parent,
       * a flex item is only as wide as its content. If an anchor is ever made
       * a flex item, the popup shrinks with it.
       */
      const declarations = rule(selector)
      expect(declarations).not.toMatch(/display:\s*(inline|inline-flex|inline-block)/)
      expect(declarations).not.toMatch(/width:\s*(min-content|max-content|fit-content|auto)/)
    })
  }

  it('does not anchor the card to a Gravity member any more', () => {
    // The regression itself. The person is still what you click; the card is
    // what the popup is measured against.
    expect(rule('.kb-gravity-person')).not.toContain('position: relative')
    expect(rule('.kb-gravity-person')).toContain('position: static')
  })

  it('keeps the member a flex item, because that is what made it narrow', () => {
    // Proof that the containing block genuinely had to move: the row this
    // person sits in wraps, so the person cannot be full width.
    expect(rule('.kb-gravity-people')).toContain('flex-wrap: wrap')
  })
})

describe('the card refuses to collapse whatever it is anchored to', () => {
  it('has a floor no anchor can take it below', () => {
    const card = rule('.kb-usercard')
    expect(card).toContain('min-width:')
    const floor = Number(card.match(/min-width:\s*(\d+)px/)?.[1])
    // Wide enough for a display name, a handle and the action row. The panel
    // itself never goes below 260px, so this never binds today.
    expect(floor).toBeGreaterThanOrEqual(200)
    expect(floor).toBeLessThan(260)
  })

  it('lets a long display name ellipsise rather than widen the card', () => {
    // The name is the flexible part; the card's width is not negotiable.
    expect(rule('.kb-usercard-name')).toContain('text-overflow: ellipsis')
    expect(rule('.kb-usercard-name')).toContain('white-space: nowrap')
    // And its container may shrink, which is what lets the ellipsis happen.
    expect(rule('.kb-usercard-id')).toContain('min-width: 0')
  })

  it('wraps its actions rather than overflowing them', () => {
    expect(rule('.kb-usercard-actions')).toContain('flex-wrap: wrap')
  })

  it('is still positioned below whatever opened it', () => {
    const card = rule('.kb-usercard')
    expect(card).toContain('position: absolute')
    expect(card).toContain('top: calc(100% + 3px)')
    // Above the card it sits on, below the panel's own chrome.
    expect(card).toMatch(/z-index:\s*\d+/)
  })
})

describe('the surfaces that were already correct are untouched', () => {
  it('leaves PersonRow, chat and the roster with no width of their own', () => {
    /*
     * These are block elements in a column: they fill the panel, which is why
     * they were never affected. A width added here would break them the same
     * way Gravity was broken.
     */
    for (const selector of ['.kb-row', '.kb-msg', '.kb-cluster-row']) {
      expect(rule(selector)).not.toMatch(/\bwidth:/)
    }
  })

  it('has no second, competing user-card rule to drift from', () => {
    // One popup, one set of rules. A Gravity-specific variant would be exactly
    // the kind of thing that looks fixed and diverges a checkpoint later.
    expect(hasRule('.kb-gravity-usercard')).toBe(false)
    expect(CSS.match(/\.kb-usercard \{/g) ?? []).toHaveLength(1)
  })
})
