/** Small inline icon set. Watchside's own mark - no Twitch assets are used. */

/**
 * The Watchside mark: two people leaning together to form a W.
 *
 * The geometry is the same as assets/brand/watchside-mark.svg, which is what
 * the toolbar icons are rasterised from - one shape, two renderers, so the
 * panel header and the browser toolbar can never drift apart. Keep them in
 * step by hand; there is deliberately no build step generating this from the
 * SVG, because a component that cannot be read is worse than one that must be
 * remembered.
 *
 * The orange and purple strokes are each half a person; the white centre is
 * what completes the letter. Neither side is a W on its own, which is the
 * whole idea.
 */
export function WatchsideMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" aria-hidden="true">
      <rect width="128" height="128" rx="28" fill="#0F172A" />
      <g fill="none" strokeWidth="15" strokeLinecap="round" strokeLinejoin="round">
        <path d="M27 44 L45 92" stroke="#FF8A00" />
        <path d="M45 92 L64 56 L83 92" stroke="#FFFFFF" />
        <path d="M83 92 L101 44" stroke="#6366F1" />
      </g>
      <circle cx="27" cy="26" r="11" fill="#FF8A00" />
      <circle cx="101" cy="26" r="11" fill="#6366F1" />
    </svg>
  )
}

export function MinimizeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3 7h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

export function BackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M8.5 3L4.5 7l4 4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}

export function ChatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M2 3.5h10v6H6.5L4 11.5V9.5H2z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}
