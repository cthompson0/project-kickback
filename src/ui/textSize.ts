/**
 * The text-size preference.
 *
 * WHY IT LIVES HERE AND NOT IN THE WORKER
 *
 * Watchside keeps two kinds of persisted state, and this is deliberately the
 * second kind. Behaviour - "should this machine raise a notification" - lives
 * in background/preferences.ts, in chrome.storage.local, and arrives over the
 * port whenever it arrives. Anything the FIRST PAINT depends on lives in
 * localStorage and is read synchronously, which is why the panel's geometry
 * and its collapsed flag are already there.
 *
 * Text size is firmly the second kind. Delivered a frame late it would mean
 * every Twitch page load draws the panel at the default size and then visibly
 * reflows to the size the user actually asked for - and the person most likely
 * to notice that is the person who turned the setting on.
 *
 * localStorage is origin-scoped, so every twitch.tv tab already shares this;
 * useStorageSync is what makes an OPEN tab follow a change made in another.
 *
 * WHY A MULTIPLIER RATHER THAN A SET OF SIZES
 *
 * Every font-size in kickback.css is `calc(Npx * var(--kb-text-scale, 1))`, so
 * the whole preference is one number. Nothing else moves: not padding, not
 * icons, not hit targets, not the panel's geometry. That is the difference
 * between this and `zoom`, which would give a bigger panel rather than more
 * readable text.
 */

export const TEXT_SIZE_KEY = 'kickback:textSize'

export type TextSize = 'default' | 'large' | 'xlarge'

/**
 * The scales, and why there are three of them.
 *
 * 1.15 and 1.3 are far enough apart to be worth choosing between and close
 * enough that the layout holds at the panel's 280px minimum width, which was
 * measured rather than assumed.
 *
 * There is deliberately no "Small". It was offered as an option and declined:
 * the brief that asked for this warns against adding sizes for symmetry, the
 * panel is already compact, and shrinking its text would work directly against
 * the legibility complaints that produced this feature in the first place.
 */
export const TEXT_SIZES: ReadonlyArray<{ id: TextSize; label: string; scale: number }> = [
  { id: 'default', label: 'Default', scale: 1 },
  { id: 'large', label: 'Large', scale: 1.15 },
  { id: 'xlarge', label: 'Extra Large', scale: 1.3 },
]

export const DEFAULT_TEXT_SIZE: TextSize = 'default'

/** The multiplier for a size, or the default's, for anything unrecognised. */
export function scaleFor(size: TextSize): number {
  return TEXT_SIZES.find((entry) => entry.id === size)?.scale ?? 1
}

/**
 * A stored value, or the default.
 *
 * Anything unrecognised falls back rather than throwing or rendering at zero:
 * this is read during the first paint, and a bad value in storage - an older
 * build, a hand-edited key, a half-written write - must not be able to stop
 * the panel drawing.
 */
export function parseTextSize(raw: string | null): TextSize {
  return TEXT_SIZES.some((entry) => entry.id === raw)
    ? (raw as TextSize)
    : DEFAULT_TEXT_SIZE
}

/** Read it now, synchronously, because the first frame depends on it. */
export function readTextSize(): TextSize {
  if (typeof window === 'undefined') return DEFAULT_TEXT_SIZE
  try {
    return parseTextSize(window.localStorage.getItem(TEXT_SIZE_KEY))
  } catch {
    // Storage can throw outright when the browser has it disabled. A panel
    // that draws at the default size is fine; one that does not draw is not.
    return DEFAULT_TEXT_SIZE
  }
}

export function writeTextSize(size: TextSize): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(TEXT_SIZE_KEY, size)
  } catch {
    // The preference is then session-only, which is the graceful half of the
    // failure. Nothing else here depends on the write having landed.
  }
}
