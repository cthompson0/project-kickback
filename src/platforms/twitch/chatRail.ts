/**
 * How much room Twitch's chat rail is taking on the right, if any.
 *
 * This is a *hint for the default position only*. Kickback never attaches to,
 * measures against, or depends on Twitch's chat for anything else, and a wrong
 * answer costs at most a slightly worse first placement - the user can drag it.
 * That is deliberate: Twitch's markup is not a contract.
 *
 * Two things learned from measuring the real page:
 *
 *   - Twitch's own `data-a-target` / `data-test-selector` hooks are far more
 *     stable than its class names, which are styled-components hashes like
 *     `Layout-sc-1xcs6mc-0 kaoNZj` and change without warning.
 *   - The rail's rectangle is not always sane. On a logged-out page it is laid
 *     out at `x === window.innerWidth`, i.e. entirely off screen, while still
 *     reporting a 340px width. Anything that trusted that number would place
 *     the panel 340px too far left for no reason.
 *
 * So every measurement is sanity-checked against the viewport, and anything
 * that fails simply reads as "no rail".
 */

/** Twitch's own hooks, most specific first. Class names are a last resort. */
const RAIL_SELECTORS = [
  '[data-test-selector="chat-room-component-layout"]',
  '[data-a-target="right-column-chat-bar"]',
  '.channel-root__right-column--expanded',
]

/** A rail wider than this is not a rail; it is a misread. */
const MAX_PLAUSIBLE_FRACTION = 0.5
const MIN_PLAUSIBLE_WIDTH = 200

/**
 * Returns the width the chat rail occupies on the right of the viewport, or 0.
 *
 * Only counts the part actually inside the viewport, so an off-screen rail
 * contributes nothing.
 */
export function measureChatRail(): number {
  const viewportWidth = window.innerWidth
  if (!viewportWidth) return 0

  for (const selector of RAIL_SELECTORS) {
    const element = document.querySelector(selector)
    if (!element) continue

    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue

    // How much of it is genuinely on screen and on the right-hand side.
    const visibleRight = Math.min(rect.right, viewportWidth)
    const visibleLeft = Math.max(rect.left, 0)
    const visible = visibleRight - visibleLeft

    if (visible < MIN_PLAUSIBLE_WIDTH) continue
    if (visible > viewportWidth * MAX_PLAUSIBLE_FRACTION) continue
    // It must actually reach the right edge, or it is not a rail.
    if (visibleRight < viewportWidth - 4) continue

    return Math.round(viewportWidth - visibleLeft)
  }

  return 0
}
