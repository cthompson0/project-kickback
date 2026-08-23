/**
 * Works out where the Kickback panel should sit.
 *
 * Twitch's top navigation is not always at the top of the viewport - a consent
 * or promo banner can push it down - so a hardcoded offset would cover Twitch
 * UI the user needs. We measure the bottom of the top-level <nav> instead, which
 * is a stable, shallow anchor, and fall back to a sensible constant if it is
 * missing (theatre mode, unusual pages).
 */

const FALLBACK_TOP_PX = 58
const GAP_PX = 8
const POLL_INTERVAL_MS = 1000

function measureTopOffset(): number {
  const nav = document.querySelector('nav')
  if (!nav) return FALLBACK_TOP_PX

  const { bottom, height } = nav.getBoundingClientRect()
  if (height === 0) return FALLBACK_TOP_PX

  // Never push the panel more than a third of the way down the viewport.
  const limit = Math.max(FALLBACK_TOP_PX, window.innerHeight / 3)
  return Math.min(Math.max(bottom + GAP_PX, GAP_PX), limit)
}

/** Calls back with the panel's top offset in px whenever it changes. */
export function watchTopOffset(listener: (topPx: number) => void): () => void {
  let current = measureTopOffset()
  listener(current)

  const check = () => {
    const next = measureTopOffset()
    if (Math.abs(next - current) >= 1) {
      current = next
      listener(current)
    }
  }

  const interval = window.setInterval(check, POLL_INTERVAL_MS)
  window.addEventListener('resize', check)

  return () => {
    window.clearInterval(interval)
    window.removeEventListener('resize', check)
  }
}
