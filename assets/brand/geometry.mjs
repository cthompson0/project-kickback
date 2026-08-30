/**
 * THE ONE DEFINITION OF THE WATCHSIDE MARK.
 *
 * Everything that draws the mark reads this file:
 *
 *   scripts/render-icons.mjs   rasterises it into public/icons/*.png
 *   scripts/render-brand.mjs   writes assets/brand/*.svg from it
 *   src/ui/components/Icons.tsx  renders it as JSX inside the panel
 *
 * WHY A MODULE RATHER THAN AN SVG FILE
 *
 * It used to be an SVG file, and the React component had the same paths typed
 * out again by hand. Two definitions of one shape with nothing binding them is
 * a drift waiting to happen: editing the file and forgetting the component
 * leaves the toolbar icon and the panel header showing different logos, and
 * nothing fails. So the geometry became data, the .svg files became BUILD
 * OUTPUT, and the component maps over the same arrays the rasteriser does.
 *
 * WHAT THE MARK IS
 *
 * A speech bubble with a face in it: two eyes, and a W for a mouth. The W is
 * the letter and the smile at once, which is what stops it reading as a
 * generic chat icon with a monogram dropped inside.
 *
 * TWO VARIANTS, BECAUSE ONE CANNOT DO BOTH JOBS
 *
 * At 16px the outlined bubble is a 1.4px ring and each eye lands on under a
 * device pixel, so the full mark greys into a smudge - measured, not assumed;
 * the renders are in the F7 report. The small variant therefore inverts:
 * the bubble becomes a solid silhouette, the W is knocked out of it, and the
 * eyes are dropped. A filled shape survives where a fine line does not.
 *
 * NOT Twitch's logo, and deliberately NOT Twitch purple (#9146FF).
 */

/** The dark ground every icon sits on, so contrast holds on any toolbar. */
export const GROUND = '#0B0B0E'

/** The canonical primary. One step off Twitch purple, on purpose. */
export const VIOLET = '#A855F7'

/** Corner radius on the 128 grid. Close to Chrome's own icon masking. */
export const CORNER = 28

/**
 * The full mark: outlined bubble, eyes, W. For 32px and above.
 *
 * The bubble and its tail are ONE path so the outline is a continuous stroke
 * rather than a box with a triangle stuck on the side.
 */
const FULL = {
  ground: GROUND,
  radius: CORNER,
  strokes: [
    {
      id: 'bubble',
      d: 'M40 102 H92 a20 20 0 0 0 20-20 V42 a20 20 0 0 0-20-20 H36 a20 20 0 0 0-20 20 v40 a20 20 0 0 0 20 20 h2 v14 z',
      width: 11,
      color: VIOLET,
    },
    {
      // Heavier than the bubble, so the letter is what the eye lands on.
      id: 'w',
      d: 'M42 66 L50 86 L64 72 L78 86 L86 66',
      width: 12,
      color: VIOLET,
    },
  ],
  circles: [
    { id: 'eye-left', cx: 52, cy: 49, r: 6, fill: VIOLET },
    { id: 'eye-right', cx: 80, cy: 49, r: 6, fill: VIOLET },
  ],
  fills: [],
}

/**
 * The small mark: solid bubble, W knocked out. For 16px.
 *
 * Wider stance and a heavier stroke than the full mark, because at these sizes
 * the silhouette is the entire mark.
 */
const SMALL = {
  ground: GROUND,
  radius: CORNER,
  fills: [
    {
      id: 'bubble-solid',
      d: 'M36 106 H92 a24 24 0 0 0 24-24 V38 a24 24 0 0 0-24-24 H36 a24 24 0 0 0-24 24 v44 a24 24 0 0 0 24 24 h0 v16 z',
      color: VIOLET,
    },
  ],
  strokes: [
    { id: 'w', d: 'M34 46 L46 82 L64 62 L82 82 L94 46', width: 15, color: GROUND },
  ],
  circles: [],
}

export const MARK = { full: FULL, small: SMALL }

/**
 * The crossover, decided by rendering rather than by taste.
 *
 * Both variants were rasterised at 16, 32 and 48 and magnified pixel by pixel.
 * At 32 the full mark is unambiguously legible - both eyes resolve, the W is
 * clean, the tail is visible - so it wins there, because it is the variant that
 * carries the face and the face is what makes the mark ours. At 16 it is not
 * close: the ring mushes and the eyes vanish. So 16 is the only size the small
 * variant draws.
 */
export const SMALL_UP_TO = 16

/**
 * Every size the brand renders, and which tree each one lands in.
 *
 * Here rather than in the renderer because a test that wants to assert "all
 * expected icons exist" must be able to import this without launching a
 * browser - render-icons.mjs executes on import by design.
 *
 * 16/32/48/128 are the extension icons the manifests name. 64 is what Windows
 * and several launchers actually pick. 512 and 1024 are for store listings and
 * social avatars, where a rescaled 128 would look soft.
 */
export const EXTENSION_SIZES = [16, 32, 48, 128]
export const BRAND_SIZES = [64, 512, 1024]
export const ICON_SIZES = [...EXTENSION_SIZES, ...BRAND_SIZES].sort((a, b) => a - b)

/** Where a given size is written. */
export function iconPath(size) {
  return EXTENSION_SIZES.includes(size)
    ? `public/icons/icon-${size}.png`
    : `assets/brand/icons/icon-${size}.png`
}

export function variantFor(size) {
  return size <= SMALL_UP_TO ? 'small' : 'full'
}

/**
 * The mark as an SVG string.
 *
 * `ground: false` omits the rounded-square backdrop, which is what the social
 * templates and the wordmark lockup want - there the mark sits on a surface
 * that already has its own background.
 */
export function markSvg(variant = 'full', { ground = true, size = 128 } = {}) {
  const mark = MARK[variant]
  if (!mark) throw new Error(`Unknown mark variant: ${variant}`)

  const parts = []
  if (ground) {
    parts.push(`<rect width="128" height="128" rx="${mark.radius}" fill="${mark.ground}" />`)
  }
  for (const fill of mark.fills) {
    parts.push(`<path d="${fill.d}" fill="${fill.color}" />`)
  }
  for (const stroke of mark.strokes) {
    parts.push(
      `<path d="${stroke.d}" fill="none" stroke="${stroke.color}" stroke-width="${stroke.width}" stroke-linecap="round" stroke-linejoin="round" />`,
    )
  }
  for (const circle of mark.circles) {
    parts.push(`<circle cx="${circle.cx}" cy="${circle.cy}" r="${circle.r}" fill="${circle.fill}" />`)
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="${size}" height="${size}" role="img" aria-label="Watchside">` +
    `<title>Watchside</title>` +
    parts.join('') +
    `</svg>`
  )
}
