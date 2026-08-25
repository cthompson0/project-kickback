/**
 * Where the Kickback panel sits, and how big it is.
 *
 * All of it is pure arithmetic over a rectangle and a viewport, deliberately
 * kept away from the DOM. Layout bugs are the kind that only show up on
 * someone else's monitor - a saved position from a 4K screen opened on a
 * laptop, a window dragged between displays, a browser un-maximised - so the
 * rules that decide whether a rectangle is usable are worth being able to test
 * exhaustively without a browser.
 *
 * The invariant everything here protects: **the panel is always reachable.**
 * Whatever is in storage, whatever the viewport does, the result must be
 * something the user can see and grab.
 */

export interface PanelLayout {
  /** Distance from the left edge of the viewport, in CSS pixels. */
  x: number
  /** Distance from the top edge of the viewport, in CSS pixels. */
  y: number
  width: number
  height: number
}

export interface Viewport {
  width: number
  height: number
}

/** Narrow enough for a cramped laptop, wide enough for chat to breathe. */
export const MIN_WIDTH = 280
export const MAX_WIDTH = 560

/**
 * The minimum is not a taste decision - it is measured.
 *
 * With a conversation open the panel carries about 250px of chrome it cannot
 * give up: header, current activity, tabs, the group's own header, the
 * composer and the footer. Allow a smaller height than that and the composer
 * gets pushed out through the bottom of the panel, which is the one control
 * chat cannot do without. 340 leaves a usable message log underneath it all.
 */
export const MIN_HEIGHT = 340
export const MAX_HEIGHT = 1400

/** Breathing room between the panel and the edge of the viewport. */
export const EDGE_MARGIN = 8

/**
 * How much of the panel must stay within the viewport.
 *
 * Not the whole panel: dragging it half off the right edge is a legitimate
 * thing to want. But enough that the header - the drag handle - is always
 * grabbable, or the panel becomes unrecoverable without clearing storage.
 */
export const MIN_VISIBLE_X = 140
export const MIN_VISIBLE_Y = 36

/** The collapsed launcher's footprint, used when clamping in that state. */
export const LAUNCHER_SIZE = 42

/**
 * Default height is generous but not silly: tall enough that group chat is
 * comfortable, short enough to leave the page visible around it.
 */
export const DEFAULT_WIDTH = 320
export const DEFAULT_MAX_HEIGHT = 720

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), high)

/** Rounds to whole pixels and rejects anything that is not a real number. */
function px(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.round(value)
}

/**
 * Sizes the panel to the viewport.
 *
 * The viewport is the hard limit rather than MAX_*: a panel taller than the
 * window cannot be resized back, because its bottom grip is off screen.
 */
export function clampSize(
  size: { width: number; height: number },
  viewport: Viewport,
): { width: number; height: number } {
  const widthLimit = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewport.width - EDGE_MARGIN * 2))
  const heightLimit = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, viewport.height - EDGE_MARGIN * 2))
  return {
    width: clamp(Math.round(size.width), MIN_WIDTH, widthLimit),
    height: clamp(Math.round(size.height), MIN_HEIGHT, heightLimit),
  }
}

/**
 * Pulls a position back to somewhere the user can reach.
 *
 * `footprint` is the size actually on screen, which is the launcher's 42px
 * when collapsed rather than the panel's - otherwise collapsing a panel that
 * was parked at the bottom edge would leave the launcher floating in space.
 */
export function clampPosition(
  position: { x: number; y: number },
  footprint: { width: number; height: number },
  viewport: Viewport,
): { x: number; y: number } {
  // Keep at least a grabbable sliver on screen, but never demand more than the
  // panel actually has.
  const visibleX = Math.min(MIN_VISIBLE_X, footprint.width)
  const visibleY = Math.min(MIN_VISIBLE_Y, footprint.height)

  const minX = EDGE_MARGIN - (footprint.width - visibleX)
  const maxX = viewport.width - visibleX - EDGE_MARGIN
  const minY = EDGE_MARGIN
  const maxY = viewport.height - visibleY - EDGE_MARGIN

  return {
    // On a viewport narrower than the panel, min can exceed max; the left edge
    // wins, because a panel pinned left is still usable.
    x: Math.round(maxX < minX ? minX : clamp(position.x, minX, maxX)),
    y: Math.round(maxY < minY ? minY : clamp(position.y, minY, maxY)),
  }
}

/** Size first, then position: where it can go depends on how big it is. */
export function clampLayout(layout: PanelLayout, viewport: Viewport): PanelLayout {
  const size = clampSize(layout, viewport)
  const position = clampPosition(layout, size, viewport)
  return { ...size, ...position }
}

/**
 * Pulls the panel fully back into view, if it can fit.
 *
 * The looser `clampLayout` only guarantees a grabbable sliver, which is the
 * right rule *during a drag*: parking the panel half off the edge is a
 * legitimate thing to want, and snapping it back would fight the user.
 *
 * It is the wrong rule when the viewport changes underneath them. Shrinking
 * the window, un-maximising, or moving to a smaller monitor can leave most of
 * the panel below the fold with its resize grips out of reach - and the user
 * did not ask for that, the window did. So the two cases get two rules.
 */
export function fitIntoViewport(layout: PanelLayout, viewport: Viewport): PanelLayout {
  const size = clampSize(layout, viewport)

  const maxX = viewport.width - size.width - EDGE_MARGIN
  const maxY = viewport.height - size.height - EDGE_MARGIN

  // If it genuinely cannot fit, fall back to keeping it reachable.
  if (maxX < EDGE_MARGIN || maxY < EDGE_MARGIN) {
    return { ...size, ...clampPosition(layout, size, viewport) }
  }

  return {
    ...size,
    x: Math.round(clamp(layout.x, EDGE_MARGIN, maxX)),
    y: Math.round(clamp(layout.y, EDGE_MARGIN, maxY)),
  }
}

/** Clamps for the collapsed launcher, whose footprint is not the panel's. */
export function clampCollapsed(layout: PanelLayout, viewport: Viewport): { x: number; y: number } {
  return clampPosition(layout, { width: LAUNCHER_SIZE, height: LAUNCHER_SIZE }, viewport)
}

export interface DefaultPlacement {
  /** Bottom of Twitch's top nav, so the panel does not cover it. */
  topOffset: number
  /**
   * Width of a Twitch chat rail that is genuinely on screen, or 0.
   *
   * Measured by the caller and treated as a hint only: if Twitch's layout is
   * unreadable the hint is 0 and the panel simply sits at the right edge.
   */
  reservedRight: number
}

/**
 * Where the panel goes when the user has never moved it.
 *
 * Right-hand side, below the nav, and to the left of Twitch's chat rail when
 * there is one - so the default view does not cover the thing most people are
 * reading. On a viewport too narrow for both, the rail hint is abandoned
 * rather than pushing the panel off screen: overlapping chat beats being
 * unreachable.
 */
export function defaultLayout(viewport: Viewport, placement: DefaultPlacement): PanelLayout {
  const top = clamp(Math.round(placement.topOffset), EDGE_MARGIN, Math.max(EDGE_MARGIN, viewport.height / 3))

  const size = clampSize(
    {
      width: DEFAULT_WIDTH,
      height: Math.min(DEFAULT_MAX_HEIGHT, viewport.height - top - EDGE_MARGIN),
    },
    viewport,
  )

  const beside = viewport.width - EDGE_MARGIN - size.width - Math.max(0, placement.reservedRight)
  const atEdge = viewport.width - EDGE_MARGIN - size.width
  // Only honour the rail hint if doing so still leaves the panel on screen.
  const x = beside >= EDGE_MARGIN ? beside : atEdge

  return clampLayout({ ...size, x, y: top }, viewport)
}

// ------------------------------------------------------------- persistence

const STORAGE_VERSION = 1

interface StoredLayout extends PanelLayout {
  v: number
  sized?: boolean
}

/**
 * A layout as it comes back out of storage.
 *
 * `sized` records whether the user has ever resized the panel themselves, and
 * it matters because it decides whether the height is a *budget* or a
 * *commitment*. Before anyone resizes, the panel is content-height up to the
 * default, so a short friends list is not a tall empty box. Once someone drags
 * a grip, the height they chose is what the panel is, whatever it is showing -
 * including a sign-in card or an error.
 */
export interface StoredLayoutRecord {
  layout: PanelLayout
  sized: boolean
}

/**
 * Reads a layout out of whatever was in storage.
 *
 * Storage is not trusted: it may hold a layout written by an older version, by
 * a different screen, or by nothing at all. Anything that is not four real
 * numbers is discarded in favour of the default, because a half-valid layout
 * is how a panel ends up somewhere it cannot be grabbed.
 */
export function parseStoredLayout(raw: string | null): StoredLayoutRecord | null {
  if (!raw) return null

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }

  const candidate = value as Partial<StoredLayout>
  if (candidate?.v !== STORAGE_VERSION) return null

  const x = px(candidate.x)
  const y = px(candidate.y)
  const width = px(candidate.width)
  const height = px(candidate.height)
  if (x === null || y === null || width === null || height === null) return null
  if (width <= 0 || height <= 0) return null

  return {
    layout: { x, y, width, height },
    // A layout written before this field existed came from a user who moved or
    // resized the panel, so treat their geometry as deliberate.
    sized: candidate.sized !== false,
  }
}

export function serializeLayout(layout: PanelLayout, sized: boolean): string {
  return JSON.stringify({ v: STORAGE_VERSION, ...layout, sized } satisfies StoredLayout)
}

// -------------------------------------------------------------- gestures

export interface Point {
  x: number
  y: number
}

/**
 * Moves the panel by the distance the pointer has travelled.
 *
 * Deliberately computed from where the gesture *started* rather than
 * accumulated frame by frame: clamping an accumulated delta makes the panel
 * stick to an edge and refuse to come back, because the movement that would
 * free it was already thrown away.
 */
export function dragTo(
  start: { layout: PanelLayout; pointer: Point },
  pointer: Point,
  viewport: Viewport,
  footprint?: { width: number; height: number },
): PanelLayout {
  const moved = {
    x: start.layout.x + (pointer.x - start.pointer.x),
    y: start.layout.y + (pointer.y - start.pointer.y),
  }
  const size = footprint ?? start.layout
  return { ...start.layout, ...clampPosition(moved, size, viewport) }
}

/** Which edge or corner a resize gesture is pulling. */
export type ResizeEdge = 's' | 'w' | 'e' | 'sw' | 'se'

/**
 * Resizes the panel by dragging one edge or corner.
 *
 * Pulling a left edge moves x and changes width together, which is the part
 * that is easy to get subtly wrong: the opposite edge must stay exactly where
 * it was, even once the size hits its minimum.
 */
export function resizeTo(
  start: { layout: PanelLayout; pointer: Point },
  pointer: Point,
  viewport: Viewport,
  edge: ResizeEdge,
): PanelLayout {
  const dx = pointer.x - start.pointer.x
  const dy = pointer.y - start.pointer.y

  let { x, width, height } = start.layout
  const { y } = start.layout

  if (edge.includes('e')) width = start.layout.width + dx
  if (edge.includes('w')) width = start.layout.width - dx
  if (edge.includes('s')) height = start.layout.height + dy

  // Never let a resize push the panel past the bottom or right of the viewport.
  const available = clampSize(
    {
      width: edge.includes('w') ? width : Math.min(width, viewport.width - x - EDGE_MARGIN),
      height: Math.min(height, viewport.height - y - EDGE_MARGIN),
    },
    viewport,
  )

  if (edge.includes('w')) {
    // The right edge is the anchor, so x absorbs whatever the width could not.
    const right = start.layout.x + start.layout.width
    x = right - available.width
    if (x < EDGE_MARGIN) {
      x = EDGE_MARGIN
      available.width = right - EDGE_MARGIN
    }
  }

  return clampLayout({ x, y, width: available.width, height: available.height }, viewport)
}

/**
 * How far a pointer may travel before the gesture stops being a click.
 *
 * The collapsed launcher is a button AND a handle, so something has to decide
 * which one a given press was. A few pixels is enough to separate a deliberate
 * move from the wobble in an ordinary click - people are not perfectly still on
 * a mouse, and on a trackpad they are less still than that.
 */
export const CLICK_SLOP = 4

/** Whether a gesture has travelled far enough to be a drag rather than a click. */
export function movedBeyondSlop(start: Point, pointer: Point): boolean {
  return (
    Math.abs(pointer.x - start.x) > CLICK_SLOP || Math.abs(pointer.y - start.y) > CLICK_SLOP
  )
}

/**
 * True when a drag should not start from this element.
 *
 * The header carries controls as well as empty space, and a drag that begins
 * on the minimise button would mean the button never fires.
 */
export function isInteractive(element: Element | null): boolean {
  if (!element) return false
  return element.closest('button, a, input, textarea, select, [data-kb-nodrag]') !== null
}
