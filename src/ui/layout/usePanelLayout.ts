import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  LAUNCHER_SIZE,
  clampCollapsed,
  clampPosition,
  defaultLayout,
  dragTo,
  fitIntoViewport,
  isInteractive,
  movedBeyondSlop,
  parseStoredLayout,
  resizeTo,
  serializeLayout,
} from './layout'
import type { PanelLayout, Point, ResizeEdge, StoredLayoutRecord, Viewport } from './layout'

/**
 * The panel's position and size, wired to the browser.
 *
 * The arithmetic all lives in ./layout.ts; this is the part that has to talk to
 * pointers, storage and the window. It is written so that the only thing it
 * can get wrong is plumbing.
 *
 * Storage is localStorage rather than chrome.storage: it reads synchronously,
 * so the panel renders in the right place on the very first frame instead of
 * jumping once an async read resolves. Twitch navigation never remounts the
 * content script, so in-session moves survive navigation for free; storage is
 * what carries them across a reload or a browser restart.
 */
export const LAYOUT_KEY = 'kickback:layout'
export interface PanelLayoutApi {
  layout: PanelLayout
  /** True while a drag or resize gesture is in progress. */
  gesturing: boolean
  /**
   * True once the user has resized the panel themselves.
   *
   * When set, the chosen height is what the panel *is* rather than a ceiling
   * it may grow to. Without it the panel silently returns to content height
   * the moment the gesture ends, which reads as the resize not sticking.
   */
  sized: boolean
  /** Attach to the drag handle. */
  onDragStart: (event: React.PointerEvent) => void
  /**
   * Attach to the collapsed launcher, which is a button as well as a handle.
   *
   * Same gesture as the panel's, with two differences it cannot share. It does
   * not refuse to start on an interactive element, because the launcher IS one -
   * the guard exists so a drag from the panel header does not swallow the
   * minimise button, and there is no such button here. And it does not
   * preventDefault, so the press still becomes a click when it turns out not to
   * have been a drag.
   */
  onLauncherDragStart: (event: React.PointerEvent) => void
  /**
   * Whether the gesture that just ended actually moved anything.
   *
   * Read this in the launcher's onClick: a click always follows a press, so
   * without it every drag would also open the panel.
   */
  wasDragged: () => boolean
  /** Attach to a resize grip. */
  onResizeStart: (edge: ResizeEdge) => (event: React.PointerEvent) => void
  /** Back to the default position and size, forgetting what was stored. */
  reset: () => void
}
/** Falls back to a plausible desktop when there is no window (tests, SSR). */
function readViewport(): Viewport {
  if (typeof window === 'undefined') return { width: 1280, height: 800 }
  return { width: window.innerWidth, height: window.innerHeight }
}
function readStored(): StoredLayoutRecord | null {
  try {
    return parseStoredLayout(window.localStorage?.getItem(LAYOUT_KEY) ?? null)
  } catch {
    // Storage can be blocked; the panel just starts at its default.
    return null
  }
}
function writeStored(layout: PanelLayout, sized: boolean): void {
  try {
    window.localStorage.setItem(LAYOUT_KEY, serializeLayout(layout, sized))
  } catch {
    // Nothing to do; the position simply will not be remembered.
  }
}
function clearStored(): void {
  try {
    window.localStorage.removeItem(LAYOUT_KEY)
  } catch {
    /* ignore */
  }
}
interface Gesture {
  kind: 'drag' | 'resize'
  edge: ResizeEdge
  start: { layout: PanelLayout; pointer: Point }
  pointerId: number
  /** What is actually on screen: the panel, or the collapsed launcher. */
  footprint: { width: number; height: number }
}
export function usePanelLayout({
  collapsed,
  topOffset,
  reservedRight,
}: {
  collapsed: boolean
  topOffset: number
  reservedRight: number
}): PanelLayoutApi {
  // Read storage once, synchronously, before the first paint.
  const [layout, setLayout] = useState<PanelLayout>(() => {
    const viewport = readViewport()
    const stored = readStored()
    // A stored layout came from some other window size, so fit it rather than
    // merely clamping it.
    return stored
      ? fitIntoViewport(stored.layout, viewport)
      : defaultLayout(viewport, { topOffset, reservedRight })
  })

  /** Set by a resize gesture, and remembered. */
  const [sized, setSized] = useState<boolean>(() => readStored()?.sized ?? false)
  // Tracked in state rather than read during render, so rendering stays pure.
  const [viewport, setViewport] = useState<Viewport>(readViewport)
  const [gesturing, setGesturing] = useState(false)
  const gesture = useRef<Gesture | null>(null)
  /*
   * Survives the end of the gesture on purpose.
   *
   * The click arrives after pointerup, so this has to still be true when the
   * launcher's onClick asks. It is cleared by the next press, not by the
   * release.
   */
  const dragged = useRef(false)
  /** Whether the user has ever placed the panel themselves. */
  const placed = useRef(readStored() !== null)
  // Follow the default while the user has not chosen a position of their own,
  // so a page whose nav height changes still starts out sensibly placed.
  useEffect(() => {
    if (placed.current) return
    setLayout(defaultLayout(readViewport(), { topOffset, reservedRight }))
  }, [topOffset, reservedRight])
  /**
   * Bring the panel back after the window changes shape.
   *
   * Covers the whole family of "my screen changed" cases with one rule -
   * resize, maximise, un-maximise, a move to a smaller monitor, a DPI change -
   * because they all end in the same place: a viewport the saved rectangle no
   * longer fits.
   */
  useEffect(() => {
    const onResize = () => {
      setViewport(readViewport())
      setLayout((current) => {
        const next = fitIntoViewport(current, readViewport())
        const same =
          next.x === current.x &&
          next.y === current.y &&
          next.width === current.width &&
          next.height === current.height
        return same ? current : next
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  // Persist only what the user chose. Clamping done on their behalf is not a
  // choice, but it is harmless to store - the value is re-clamped on read.
  useEffect(() => {
    if (!placed.current) return
    writeStored(layout, sized)
  }, [layout, sized])
  const begin = useCallback(
    (
      kind: Gesture['kind'],
      edge: ResizeEdge,
      event: React.PointerEvent,
      options: { fromHandle?: boolean } = {},
    ) => {
      const fromHandle = options.fromHandle ?? true
      if (event.button !== 0) return
      if (kind === 'drag' && fromHandle && isInteractive(event.target as Element)) return
      // Only the panel's own handle suppresses the default. On the launcher the
      // press has to be allowed to become a click if it never becomes a drag.
      if (fromHandle) event.preventDefault()
      event.stopPropagation()
      dragged.current = false
      setLayout((current) => {
        /*
         * A collapsed launcher is drawn at a clamped position, not at the
         * stored one, so the gesture has to start from what is on screen.
         *
         * Starting from the stored rectangle instead gives the launcher a dead
         * zone: a panel parked at the bottom edge collapses to a launcher that
         * was pulled up to stay reachable, and a drag would then spend its
         * first fifty pixels moving a number nobody can see before the launcher
         * itself budged.
         */
        const base =
          collapsed && kind === 'drag'
            ? { ...current, ...clampCollapsed(current, readViewport()) }
            : current
        gesture.current = {
          kind,
          edge,
          start: { layout: base, pointer: { x: event.clientX, y: event.clientY } },
          pointerId: event.pointerId,
          // When collapsed the thing on screen is a 42px launcher, so that is
          // the footprint a drag has to keep reachable.
          footprint: collapsed
            ? { width: LAUNCHER_SIZE, height: LAUNCHER_SIZE }
            : { width: current.width, height: current.height },
        }
        return current
      })
      placed.current = true
      // Only a resize commits to a height. Dragging moves the panel without
      // saying anything about how big it should be.
      if (kind === 'resize') setSized(true)
      setGesturing(true)
    },
    [collapsed],
  )
  // Listeners live on window rather than the panel so a fast drag that leaves
  // the panel behind still tracks, and a release anywhere still ends cleanly.
  useEffect(() => {
    if (!gesturing) return
    const onMove = (event: PointerEvent) => {
      const active = gesture.current
      if (!active || event.pointerId !== active.pointerId) return
      const live = readViewport()
      const pointer = { x: event.clientX, y: event.clientY }
      if (movedBeyondSlop(active.start.pointer, pointer)) dragged.current = true
      setLayout(
        active.kind === 'drag'
          ? dragTo(active.start, pointer, live, active.footprint)
          : resizeTo(active.start, pointer, live, active.edge),
      )
    }
    const onEnd = (event: PointerEvent) => {
      if (gesture.current && event.pointerId !== gesture.current.pointerId) return
      gesture.current = null
      setGesturing(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
    }
  }, [gesturing])
  /**
   * Collapsing changes the footprint, so a launcher inherited from a panel
   * parked against the bottom edge would otherwise sit off screen.
   *
   * Derived rather than stored: the panel keeps the geometry the user chose,
   * and only what is drawn moves. Expanding again puts it straight back.
   */
  const rendered = useMemo(
    () =>
      collapsed
        ? { ...layout, ...clampCollapsed(layout, viewport) }
        : /*
           * Expanded, the same loose rule a panel drag obeys: keep a grabbable
           * corner on screen and otherwise leave the position alone.
           *
           * A no-op for any layout a panel drag produced - it was clamped this
           * way already. It earns its place for the ones a LAUNCHER drag
           * produced: a 42px launcher can sit in the bottom-right corner quite
           * happily, and the 320px panel that opens from it cannot.
           */
          { ...layout, ...clampPosition(layout, layout, viewport) },
    [collapsed, layout, viewport],
  )
  const reset = useCallback(() => {
    clearStored()
    placed.current = false
    setSized(false)
    setLayout(defaultLayout(readViewport(), { topOffset, reservedRight }))
  }, [topOffset, reservedRight])
  const onDragStart = useCallback(
    (event: React.PointerEvent) => begin('drag', 's', event),
    [begin],
  )
  const onLauncherDragStart = useCallback(
    (event: React.PointerEvent) => begin('drag', 's', event, { fromHandle: false }),
    [begin],
  )
  const wasDragged = useCallback(() => dragged.current, [])
  const onResizeStart = useMemo(
    () => (edge: ResizeEdge) => (event: React.PointerEvent) => begin('resize', edge, event),
    [begin],
  )
  return {
    layout: rendered,
    gesturing,
    sized,
    onDragStart,
    onLauncherDragStart,
    wasDragged,
    onResizeStart,
    reset,
  }
}
