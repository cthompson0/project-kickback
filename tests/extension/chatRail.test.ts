import { afterEach, describe, expect, it, vi } from 'vitest'
import { measureChatRail } from '../../src/platforms/twitch/chatRail'

/**
 * The Twitch chat rail hint.
 *
 * This is the one piece of Kickback that looks at Twitch's own markup, so it
 * is also the one piece most likely to be wrong one day. What is tested here
 * is not that it finds the rail - Twitch decides that - but that it is honest
 * when it cannot, because a confidently wrong measurement moves the panel
 * somewhere strange for no reason.
 *
 * The case in the middle is real, not hypothetical: measured against the live
 * site, a logged-out channel page lays the rail out at `x === innerWidth`,
 * entirely off screen, while still reporting a 340px width.
 */

interface FakeRect {
  left: number
  width: number
  height: number
}

/** Installs a fake document exposing one element with the given rect. */
function withRail(rect: FakeRect | null, viewportWidth = 1600) {
  const element = rect
    ? {
        getBoundingClientRect: () => ({
          left: rect.left,
          right: rect.left + rect.width,
          width: rect.width,
          height: rect.height,
        }),
      }
    : null

  vi.stubGlobal('window', { innerWidth: viewportWidth })
  vi.stubGlobal('document', { querySelector: () => element })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('measuring the chat rail', () => {
  it('reports the width of a rail sitting against the right edge', () => {
    withRail({ left: 1260, width: 340, height: 700 })
    expect(measureChatRail()).toBe(340)
  })

  it('reports nothing when there is no rail at all', () => {
    withRail(null)
    expect(measureChatRail()).toBe(0)
  })

  it('reports nothing for a collapsed rail', () => {
    // Twitch collapses chat to a 0x0 box rather than removing it.
    withRail({ left: 0, width: 0, height: 0 })
    expect(measureChatRail()).toBe(0)
  })

  it('reports nothing for a rail laid out beyond the right edge', () => {
    // Observed on the live site: left === innerWidth, width 340, off screen.
    withRail({ left: 1600, width: 340, height: 621 })
    expect(measureChatRail()).toBe(0)
  })

  it('reports nothing for something that does not reach the right edge', () => {
    // A 340px box floating in the middle of the page is not the chat rail.
    withRail({ left: 600, width: 340, height: 700 })
    expect(measureChatRail()).toBe(0)
  })

  it('reports nothing for a box implausibly wide to be a rail', () => {
    // If Twitch's markup changes under us, a match on the wrong element must
    // not shove the panel most of the way across the screen.
    withRail({ left: 200, width: 1400, height: 700 })
    expect(measureChatRail()).toBe(0)
  })

  it('reports nothing for a sliver too narrow to be a rail', () => {
    withRail({ left: 1580, width: 20, height: 700 })
    expect(measureChatRail()).toBe(0)
  })

  it('counts only the part actually on screen', () => {
    // A rail hanging off the right edge contributes what is visible, not its
    // full width.
    withRail({ left: 1400, width: 340, height: 700 })
    expect(measureChatRail()).toBe(200)
  })

  it('reports nothing when there is no viewport to measure against', () => {
    vi.stubGlobal('window', { innerWidth: 0 })
    vi.stubGlobal('document', { querySelector: () => null })
    expect(measureChatRail()).toBe(0)
  })
})
