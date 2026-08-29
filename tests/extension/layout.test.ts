import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WIDTH,
  EDGE_MARGIN,
  LAUNCHER_SIZE,
  MAX_WIDTH,
  MIN_HEIGHT,
  MIN_VISIBLE_X,
  MIN_VISIBLE_Y,
  MIN_WIDTH,
  CLICK_SLOP,
  clampCollapsed,
  clampLayout,
  clampPosition,
  clampSize,
  defaultLayout,
  dragTo,
  fitIntoViewport,
  isInteractive,
  movedBeyondSlop,
  parseStoredLayout,
  resizeTo,
  serializeLayout,
} from '../../src/ui/layout/layout'
import type { PanelLayout, Viewport } from '../../src/ui/layout/layout'

/**
 * Panel geometry.
 *
 * The property under test throughout is that **the panel stays reachable**.
 * Layout bugs are the kind nobody hits on the machine they were written on -
 * they need a saved position from a bigger monitor, a window that was
 * un-maximised, a screen that changed underneath the page. All of those are
 * one function call here.
 */

const DESKTOP: Viewport = { width: 1600, height: 900 }
const LAPTOP: Viewport = { width: 1280, height: 720 }
const TINY: Viewport = { width: 700, height: 500 }

const layout = (over: Partial<PanelLayout> = {}): PanelLayout => ({
  x: 1200,
  y: 58,
  width: 320,
  height: 600,
  ...over,
})

/** Is every pixel of this rectangle inside the viewport? */
const fullyVisible = (l: PanelLayout, v: Viewport) =>
  l.x >= 0 && l.y >= 0 && l.x + l.width <= v.width && l.y + l.height <= v.height

/** Is enough of it on screen to grab? */
const reachable = (l: PanelLayout, v: Viewport) =>
  l.x + Math.min(MIN_VISIBLE_X, l.width) <= v.width &&
  l.x + l.width >= 0 &&
  l.y >= 0 &&
  l.y + Math.min(MIN_VISIBLE_Y, l.height) <= v.height

// ------------------------------------------------------------------- size

describe('sizing', () => {
  it('holds a sensible size unchanged', () => {
    expect(clampSize({ width: 400, height: 600 }, DESKTOP)).toEqual({ width: 400, height: 600 })
  })

  it('refuses to go below the minimum', () => {
    expect(clampSize({ width: 10, height: 10 }, DESKTOP)).toEqual({
      width: MIN_WIDTH,
      height: MIN_HEIGHT,
    })
  })

  it('refuses to go above the maximum', () => {
    const size = clampSize({ width: 99_999, height: 99_999 }, DESKTOP)
    expect(size.width).toBe(MAX_WIDTH)
    expect(size.height).toBe(DESKTOP.height - EDGE_MARGIN * 2)
  })

  it('never grows taller than the window', () => {
    // A panel taller than the viewport cannot be resized back: its bottom grip
    // is off screen.
    const size = clampSize({ width: 320, height: 5000 }, LAPTOP)
    expect(size.height).toBeLessThanOrEqual(LAPTOP.height)
  })

  it('keeps the minimum even on a window smaller than the minimum', () => {
    // Better a panel that overflows a tiny window than one squashed to nothing.
    const size = clampSize({ width: 320, height: 600 }, { width: 200, height: 200 })
    expect(size).toEqual({ width: MIN_WIDTH, height: MIN_HEIGHT })
  })

  it('rounds to whole pixels', () => {
    expect(clampSize({ width: 320.7, height: 600.2 }, DESKTOP)).toEqual({
      width: 321,
      height: 600,
    })
  })
})

// --------------------------------------------------------------- position

describe('positioning', () => {
  it('leaves a position that is already fine alone', () => {
    expect(clampPosition({ x: 400, y: 200 }, { width: 320, height: 600 }, DESKTOP)).toEqual({
      x: 400,
      y: 200,
    })
  })

  it('allows the panel to hang off the right edge, but not to vanish', () => {
    const at = clampPosition({ x: 99_999, y: 100 }, { width: 320, height: 600 }, DESKTOP)
    expect(at.x).toBeLessThan(DESKTOP.width)
    expect(at.x + MIN_VISIBLE_X).toBeLessThanOrEqual(DESKTOP.width)
  })

  it('allows the panel to hang off the left edge, but not to vanish', () => {
    const at = clampPosition({ x: -99_999, y: 100 }, { width: 320, height: 600 }, DESKTOP)
    expect(at.x + 320).toBeGreaterThanOrEqual(MIN_VISIBLE_X)
  })

  it('never lets the header go above the top of the window', () => {
    // Off the top is the one direction that is unrecoverable: there is nothing
    // left to grab.
    expect(clampPosition({ x: 100, y: -500 }, { width: 320, height: 600 }, DESKTOP).y).toBe(
      EDGE_MARGIN,
    )
  })

  it('keeps a grabbable strip when dragged off the bottom', () => {
    const at = clampPosition({ x: 100, y: 99_999 }, { width: 320, height: 600 }, DESKTOP)
    expect(at.y + MIN_VISIBLE_Y).toBeLessThanOrEqual(DESKTOP.height)
  })

  it('never demands more visible width than the panel has', () => {
    // A 42px launcher cannot show 140px of itself, so it must be allowed all
    // the way to the right margin - not stopped 140px short of the edge.
    const at = clampPosition({ x: 99_999, y: 10 }, { width: 42, height: 42 }, DESKTOP)
    expect(at.x).toBe(DESKTOP.width - 42 - EDGE_MARGIN)
  })
})

// ------------------------------------------------------------ recovery

describe('recovering an impossible saved layout', () => {
  const HOSTILE: Array<[string, PanelLayout]> = [
    ['far off the right', layout({ x: 99_999 })],
    ['far off the bottom', layout({ y: 99_999 })],
    ['far off the left', layout({ x: -99_999 })],
    ['above the top', layout({ y: -99_999 })],
    ['negative size', layout({ width: -10, height: -10 })],
    ['absurd size', layout({ width: 99_999, height: 99_999 })],
    ['from a much bigger monitor', { x: 3400, y: 1800, width: 520, height: 1300 }],
  ]

  it.each(HOSTILE)('brings back a panel saved %s', (_name, saved) => {
    const fixed = clampLayout(saved, LAPTOP)
    expect(reachable(fixed, LAPTOP)).toBe(true)
    expect(fixed.width).toBeGreaterThanOrEqual(MIN_WIDTH)
    expect(fixed.height).toBeGreaterThanOrEqual(MIN_HEIGHT)
  })

  it.each(HOSTILE)('fits a panel saved %s entirely back on screen', (_name, saved) => {
    const fixed = fitIntoViewport(saved, LAPTOP)
    expect(fullyVisible(fixed, LAPTOP)).toBe(true)
  })

  it('fits the panel back after the window shrinks', () => {
    // The case that matters most: un-maximising, or moving to a laptop screen.
    const parked = { x: 1200, y: 500, width: 400, height: 700 }
    const fitted = fitIntoViewport(parked, { width: 900, height: 600 })
    expect(fullyVisible(fitted, { width: 900, height: 600 })).toBe(true)
  })

  it('falls back to merely reachable when nothing can fit', () => {
    const fitted = fitIntoViewport(layout(), { width: 200, height: 200 })
    expect(fitted.width).toBe(MIN_WIDTH)
    // Cannot be fully visible in a 200px window; must still be grabbable.
    expect(fitted.y).toBeGreaterThanOrEqual(0)
    expect(fitted.x).toBeLessThan(200)
  })

  it('leaves a layout that already fits exactly where it is', () => {
    const fine = { x: 400, y: 100, width: 320, height: 600 }
    expect(fitIntoViewport(fine, DESKTOP)).toEqual(fine)
  })
})

// -------------------------------------------------------------- defaults

describe('default placement', () => {
  it('sits at the right-hand side, below the nav', () => {
    const at = defaultLayout(DESKTOP, { topOffset: 58, reservedRight: 0 })
    expect(at.y).toBe(58)
    expect(at.x + at.width).toBe(DESKTOP.width - EDGE_MARGIN)
    expect(at.width).toBe(DEFAULT_WIDTH)
  })

  it('steps aside for a Twitch chat rail', () => {
    const at = defaultLayout(DESKTOP, { topOffset: 58, reservedRight: 340 })
    // Clear of the rail entirely.
    expect(at.x + at.width).toBeLessThanOrEqual(DESKTOP.width - 340)
  })

  it('ignores the rail rather than going off screen on a narrow window', () => {
    // 600px of window cannot hold a 340px rail and the panel beside it, so
    // the hint has to be abandoned: overlapping chat beats being off screen.
    const cramped = { width: 600, height: 700 }
    const at = defaultLayout(cramped, { topOffset: 58, reservedRight: 340 })
    expect(at.x).toBeGreaterThanOrEqual(0)
    expect(fullyVisible(at, cramped)).toBe(true)
  })

  it('still steps aside on a window with room for both', () => {
    const at = defaultLayout(TINY, { topOffset: 58, reservedRight: 200 })
    expect(at.x + at.width).toBeLessThanOrEqual(TINY.width - 200)
    expect(fullyVisible(at, TINY)).toBe(true)
  })

  it('is taller when there is more window to use', () => {
    const short = defaultLayout({ width: 1600, height: 620 }, { topOffset: 58, reservedRight: 0 })
    const tall = defaultLayout({ width: 1600, height: 1400 }, { topOffset: 58, reservedRight: 0 })
    expect(tall.height).toBeGreaterThan(short.height)
  })

  it('does not run off the bottom of a short window', () => {
    const at = defaultLayout({ width: 1600, height: 620 }, { topOffset: 58, reservedRight: 0 })
    expect(at.y + at.height).toBeLessThanOrEqual(620)
  })

  it('refuses to be pushed a long way down by a huge nav measurement', () => {
    const at = defaultLayout(DESKTOP, { topOffset: 5000, reservedRight: 0 })
    expect(at.y).toBeLessThanOrEqual(DESKTOP.height / 3)
  })

  it('is always fully visible, for any plausible window', () => {
    for (const width of [700, 900, 1280, 1600, 2560, 3840]) {
      for (const height of [500, 720, 900, 1440, 2160]) {
        const viewport = { width, height }
        for (const rail of [0, 340]) {
          const at = defaultLayout(viewport, { topOffset: 58, reservedRight: rail })
          expect(fullyVisible(at, viewport)).toBe(true)
        }
      }
    }
  })
})

// -------------------------------------------------------------- storage

describe('reading a saved layout', () => {
  it('round-trips a layout', () => {
    const saved = layout()
    expect(parseStoredLayout(serializeLayout(saved, true))).toEqual({
      layout: saved,
      sized: true,
    })
  })

  it('remembers whether the user resized, in both directions', () => {
    // This flag decides whether the height is a commitment or a ceiling, so it
    // has to survive a round trip rather than being re-guessed on load.
    const saved = layout()
    expect(parseStoredLayout(serializeLayout(saved, false))?.sized).toBe(false)
    expect(parseStoredLayout(serializeLayout(saved, true))?.sized).toBe(true)
  })

  it('treats a layout saved before the flag existed as deliberate', () => {
    // Anything already in storage was put there by someone moving or resizing
    // the panel, so their geometry is honoured rather than quietly downgraded.
    const legacy = '{"v":1,"x":100,"y":50,"width":320,"height":600}'
    expect(parseStoredLayout(legacy)?.sized).toBe(true)
    expect(parseStoredLayout(legacy)?.layout).toEqual({ x: 100, y: 50, width: 320, height: 600 })
  })

  it('discards anything that is not a layout', () => {
    const rubbish = [
      null,
      '',
      'not json at all',
      '{}',
      '[]',
      '{"x":1,"y":2,"width":3}',
      // Right shape, no version: written by some future or past build.
      '{"x":1,"y":2,"width":300,"height":400}',
      '{"v":1,"x":"1","y":2,"width":300,"height":400}',
      '{"v":1,"x":null,"y":2,"width":300,"height":400}',
      '{"v":2,"x":1,"y":2,"width":300,"height":400}',
      '{"v":1,"x":1,"y":2,"width":0,"height":400}',
    ]
    for (const raw of rubbish) {
      expect(parseStoredLayout(raw)).toBeNull()
    }
  })

  it('discards NaN and Infinity rather than positioning by them', () => {
    // JSON.stringify turns both into null, but a hand-edited value could be
    // anything - and a NaN coordinate makes the panel disappear completely.
    expect(parseStoredLayout('{"v":1,"x":null,"y":0,"width":300,"height":400}')).toBeNull()
    expect(parseStoredLayout('{"v":1,"x":1e999,"y":0,"width":300,"height":400}')).toBeNull()
  })
})

// -------------------------------------------------------------- dragging

describe('dragging', () => {
  const start = { layout: layout({ x: 400, y: 200 }), pointer: { x: 500, y: 250 } }

  it('moves by exactly the distance the pointer moved', () => {
    const moved = dragTo(start, { x: 560, y: 300 }, DESKTOP)
    expect(moved).toMatchObject({ x: 460, y: 250 })
  })

  it('keeps the size while moving', () => {
    const moved = dragTo(start, { x: 900, y: 600 }, DESKTOP)
    expect(moved.width).toBe(start.layout.width)
    expect(moved.height).toBe(start.layout.height)
  })

  it('is measured from where the gesture began, not accumulated', () => {
    // Accumulating clamped deltas is how a panel gets stuck against an edge:
    // the movement that would free it has already been thrown away.
    const far = dragTo(start, { x: 99_999, y: 99_999 }, DESKTOP)
    const back = dragTo(start, { x: 500, y: 250 }, DESKTOP)
    expect(far.x).not.toBe(back.x)
    expect(back).toMatchObject({ x: 400, y: 200 })
  })

  it('cannot be dragged out of reach in any direction', () => {
    for (const pointer of [
      { x: 99_999, y: 200 },
      { x: -99_999, y: 200 },
      { x: 500, y: 99_999 },
      { x: 500, y: -99_999 },
    ]) {
      expect(reachable(dragTo(start, pointer, DESKTOP), DESKTOP)).toBe(true)
    }
  })

  it('uses the launcher footprint when collapsed', () => {
    // A 42px launcher may go much closer to the right edge than a 320px panel.
    const launcher = { width: LAUNCHER_SIZE, height: LAUNCHER_SIZE }
    const far = dragTo(start, { x: 99_999, y: 200 }, DESKTOP, launcher)
    const panel = dragTo(start, { x: 99_999, y: 200 }, DESKTOP)
    expect(far.x).toBeGreaterThan(panel.x)
    expect(far.x + LAUNCHER_SIZE).toBeLessThanOrEqual(DESKTOP.width)
  })
})

describe('what starts a drag', () => {
  /** A minimal stand-in for the header's DOM, without needing a DOM library. */
  const fakeElement = (matches: string | null): Element =>
    ({ closest: (selector: string) => (matches && selector.includes(matches) ? {} : null) }) as
      unknown as Element

  it('does not start from a button', () => {
    expect(isInteractive(fakeElement('button'))).toBe(true)
  })

  it('does not start from an input', () => {
    expect(isInteractive(fakeElement('input'))).toBe(true)
  })

  it('does not start from anything opted out', () => {
    expect(isInteractive(fakeElement('data-kb-nodrag'))).toBe(true)
  })

  it('does start from plain header space', () => {
    expect(isInteractive(fakeElement(null))).toBe(false)
  })

  it('treats a missing element as not interactive', () => {
    expect(isInteractive(null)).toBe(false)
  })
})

// -------------------------------------------------------------- resizing

describe('resizing', () => {
  const start = { layout: layout({ x: 400, y: 100, width: 320, height: 500 }), pointer: { x: 720, y: 600 } }

  it('grows from the bottom edge', () => {
    expect(resizeTo(start, { x: 720, y: 700 }, DESKTOP, 's').height).toBe(600)
  })

  it('grows from the right edge', () => {
    expect(resizeTo(start, { x: 820, y: 600 }, DESKTOP, 'e').width).toBe(420)
  })

  it('grows from the bottom-right corner in both directions', () => {
    const resized = resizeTo(start, { x: 820, y: 700 }, DESKTOP, 'se')
    expect(resized).toMatchObject({ width: 420, height: 600, x: 400, y: 100 })
  })

  it('grows leftwards from the left edge, holding the right edge still', () => {
    const resized = resizeTo(start, { x: 620, y: 600 }, DESKTOP, 'w')
    expect(resized.width).toBe(420)
    expect(resized.x).toBe(300)
    // The property that is easy to get wrong: the far edge must not move.
    expect(resized.x + resized.width).toBe(start.layout.x + start.layout.width)
  })

  it('holds the right edge still even once the minimum width is reached', () => {
    const resized = resizeTo(start, { x: 99_999, y: 600 }, DESKTOP, 'w')
    expect(resized.width).toBe(MIN_WIDTH)
    expect(resized.x + resized.width).toBe(start.layout.x + start.layout.width)
  })

  it('never shrinks below the minimum', () => {
    const resized = resizeTo(start, { x: 0, y: 0 }, DESKTOP, 'se')
    expect(resized.width).toBe(MIN_WIDTH)
    expect(resized.height).toBe(MIN_HEIGHT)
  })

  it('never grows past the maximum', () => {
    const resized = resizeTo(start, { x: 99_999, y: 99_999 }, DESKTOP, 'se')
    expect(resized.width).toBeLessThanOrEqual(MAX_WIDTH)
    expect(resized.height).toBeLessThanOrEqual(DESKTOP.height)
  })

  it('cannot be dragged out through the bottom of the window', () => {
    const resized = resizeTo(start, { x: 720, y: 99_999 }, DESKTOP, 's')
    expect(resized.y + resized.height).toBeLessThanOrEqual(DESKTOP.height)
  })

  it('cannot be dragged out through the right of the window', () => {
    const near = { layout: layout({ x: 1200, y: 100, width: 320, height: 500 }), pointer: { x: 1520, y: 600 } }
    const resized = resizeTo(near, { x: 99_999, y: 600 }, DESKTOP, 'e')
    expect(resized.x + resized.width).toBeLessThanOrEqual(DESKTOP.width)
  })

  it('cannot push the left edge off the left of the window', () => {
    const near = { layout: layout({ x: 40, y: 100, width: 320, height: 500 }), pointer: { x: 40, y: 600 } }
    const resized = resizeTo(near, { x: -99_999, y: 600 }, DESKTOP, 'w')
    expect(resized.x).toBeGreaterThanOrEqual(0)
  })

  it('leaves the panel usable whatever the gesture', () => {
    for (const edge of ['s', 'e', 'w', 'sw', 'se'] as const) {
      for (const pointer of [
        { x: 99_999, y: 99_999 },
        { x: -99_999, y: -99_999 },
        { x: 0, y: 99_999 },
      ]) {
        const resized = resizeTo(start, pointer, LAPTOP, edge)
        expect(resized.width).toBeGreaterThanOrEqual(MIN_WIDTH)
        expect(resized.height).toBeGreaterThanOrEqual(MIN_HEIGHT)
        expect(reachable(resized, LAPTOP)).toBe(true)
      }
    }
  })
})

// ------------------------------------------------------------- collapsed

describe('the collapsed launcher', () => {
  it('stays where the panel was', () => {
    const at = clampCollapsed(layout({ x: 600, y: 300 }), DESKTOP)
    expect(at).toEqual({ x: 600, y: 300 })
  })

  it('comes back into view when the panel was parked off the bottom', () => {
    // A panel may hang off the bottom edge legitimately; a 42px launcher
    // inherited from that position would be floating in nothing.
    const parked = layout({ x: 600, y: 860, height: 600 })
    const at = clampCollapsed(parked, DESKTOP)
    expect(at.y + LAUNCHER_SIZE).toBeLessThanOrEqual(DESKTOP.height)
  })

  it('comes back into view when the panel was parked off the right', () => {
    const at = clampCollapsed(layout({ x: 1560, width: 320 }), DESKTOP)
    expect(at.x + LAUNCHER_SIZE).toBeLessThanOrEqual(DESKTOP.width)
  })

  it('is always fully visible', () => {
    for (const viewport of [DESKTOP, LAPTOP, TINY]) {
      for (const parked of [
        layout({ x: -900, y: -900 }),
        layout({ x: 99_999, y: 99_999 }),
        layout({ x: 0, y: 0 }),
      ]) {
        const at = clampCollapsed(parked, viewport)
        expect(at.x).toBeGreaterThanOrEqual(0)
        expect(at.y).toBeGreaterThanOrEqual(0)
        expect(at.x + LAUNCHER_SIZE).toBeLessThanOrEqual(viewport.width)
        expect(at.y + LAUNCHER_SIZE).toBeLessThanOrEqual(viewport.height)
      }
    }
  })
})

// ------------------------------------------------- dragging the launcher

describe('telling a launcher drag from a launcher click', () => {
  /*
   * The collapsed launcher is a button AND a handle, so something has to decide
   * which one a given press was. A click always follows a press, so without this
   * distinction every drag would also open the panel - and moving Watchside out
   * of the way would be the one gesture that puts it back in the way.
   */
  it('treats a still press as a click', () => {
    expect(movedBeyondSlop({ x: 100, y: 100 }, { x: 100, y: 100 })).toBe(false)
  })

  it('forgives the wobble in an ordinary click', () => {
    // Nobody is perfectly still on a mouse, and on a trackpad they are less
    // still than that.
    expect(movedBeyondSlop({ x: 100, y: 100 }, { x: 100 + CLICK_SLOP, y: 100 })).toBe(false)
    expect(movedBeyondSlop({ x: 100, y: 100 }, { x: 100, y: 100 - CLICK_SLOP })).toBe(false)
  })

  it('calls anything further a drag, in any direction', () => {
    const past = CLICK_SLOP + 1
    expect(movedBeyondSlop({ x: 100, y: 100 }, { x: 100 + past, y: 100 })).toBe(true)
    expect(movedBeyondSlop({ x: 100, y: 100 }, { x: 100 - past, y: 100 })).toBe(true)
    expect(movedBeyondSlop({ x: 100, y: 100 }, { x: 100, y: 100 + past })).toBe(true)
    expect(movedBeyondSlop({ x: 100, y: 100 }, { x: 100, y: 100 - past })).toBe(true)
  })
})

describe('where a dragged launcher may be left', () => {
  const LAUNCHER = { width: LAUNCHER_SIZE, height: LAUNCHER_SIZE }

  it('moves with the pointer', () => {
    const start = { layout: layout({ x: 600, y: 300 }), pointer: { x: 610, y: 310 } }
    const moved = dragTo(start, { x: 400, y: 500 }, DESKTOP, LAUNCHER)
    // The pointer started 10px inside the launcher, and that offset is kept.
    expect(moved.x).toBe(390)
    expect(moved.y).toBe(490)
  })

  it('cannot be thrown off screen', () => {
    for (const viewport of [DESKTOP, LAPTOP, TINY]) {
      for (const target of [
        { x: -5_000, y: -5_000 },
        { x: 5_000, y: 5_000 },
        { x: 5_000, y: -5_000 },
      ]) {
        const start = { layout: layout({ x: 600, y: 300 }), pointer: { x: 600, y: 300 } }
        const moved = dragTo(start, target, viewport, LAUNCHER)
        expect(moved.x).toBeGreaterThanOrEqual(0)
        expect(moved.y).toBeGreaterThanOrEqual(0)
        expect(moved.x + LAUNCHER_SIZE).toBeLessThanOrEqual(viewport.width)
        expect(moved.y + LAUNCHER_SIZE).toBeLessThanOrEqual(viewport.height)
      }
    }
  })

  it('leaves a panel that opens there still reachable', () => {
    /*
     * The one thing a launcher drag can do that a panel drag cannot: a 42px
     * launcher sits in the bottom-right corner quite happily, and the 320px
     * panel that opens from it cannot. Expanding re-applies the panel's own
     * clamp, which is a no-op for every position a panel drag produced.
     */
    const corner = dragTo(
      { layout: layout({ x: 600, y: 300 }), pointer: { x: 600, y: 300 } },
      { x: 5_000, y: 5_000 },
      DESKTOP,
      LAUNCHER,
    )
    const expanded = clampPosition(corner, corner, DESKTOP)
    expect(expanded.x + MIN_VISIBLE_X).toBeLessThanOrEqual(DESKTOP.width)
    expect(expanded.y + MIN_VISIBLE_Y).toBeLessThanOrEqual(DESKTOP.height)
  })

  it('leaves a position a panel drag chose exactly alone', () => {
    const parked = clampLayout(layout({ x: 1400, y: 700 }), DESKTOP)
    expect(clampPosition(parked, parked, DESKTOP)).toEqual({ x: parked.x, y: parked.y })
  })
})
