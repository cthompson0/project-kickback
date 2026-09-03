/** Small inline icon set. Watchside's own mark - no Twitch assets are used. */

import { MARK, variantFor } from '../../../assets/brand/geometry.mjs'

/**
 * The Watchside mark: a speech bubble with a face in it - two eyes, and a W
 * for a mouth.
 *
 * THE GEOMETRY IS NOT HERE.
 *
 * It lives in assets/brand/geometry.mjs, which is also what the toolbar icons
 * are rasterised from and what the .svg files are generated from. This
 * component maps over the same arrays rather than restating them.
 *
 * That is a change from how this used to work. The paths were typed out here
 * a second time, with a comment asking whoever edited the SVG to remember to
 * edit this too - and two definitions of one shape with nothing binding them
 * drift the first time somebody forgets. Now the panel header and the browser
 * toolbar cannot disagree, because there is only one shape.
 */
export function WatchsideMark({ size = 18 }: { size?: number }) {
  // 18px and under is the size band the solid variant exists for; see
  // SMALL_UP_TO in the geometry module.
  const mark = MARK[variantFor(size)]

  return (
    <svg width={size} height={size} viewBox="0 0 128 128" aria-hidden="true">
      <rect width="128" height="128" rx={mark.radius} fill={mark.ground} />
      {mark.fills.map((fill) => (
        <path key={fill.id} d={fill.d} fill={fill.color} />
      ))}
      {mark.strokes.map((stroke) => (
        <path
          key={stroke.id}
          d={stroke.d}
          fill="none"
          stroke={stroke.color}
          strokeWidth={stroke.width}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {mark.circles.map((circle) => (
        <circle key={circle.id} cx={circle.cx} cy={circle.cy} r={circle.r} fill={circle.fill} />
      ))}
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

/**
 * The disclosure chevron, pointing down when the thing below is open.
 *
 * THE BETA REPORT THIS EXISTS FOR: "the dropdown/collapse arrow is small and
 * difficult to see."
 *
 * It used to be the literal characters U+2303 and U+2304 - UP and DOWN
 * ARROWHEAD - set at 10px in the faintest colour in the palette. Two problems
 * at once. Those code points are not in most UI font stacks, so what actually
 * drew them was whatever fallback the browser found, at whatever weight it
 * happened to have; and 10px of --kb-faint is 3.56:1, the floor for a
 * graphical control and nothing more.
 *
 * A path cannot fall back to a different font, and it keeps its stroke weight
 * at any size. Same idiom as every other icon here.
 */
export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
      style={{ transform: open ? 'rotate(180deg)' : undefined }}
    >
      <path
        d="M3.5 5.5L7 9l3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}
