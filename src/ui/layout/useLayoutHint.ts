import { useCallback, useEffect, useState } from 'react'

/**
 * A one-time nudge that the panel can be moved and resized.
 *
 * The grips are deliberately quiet, which is right for something you look at
 * all day and wrong for something you have never seen. So: one line, in the
 * footer, on the first run only.
 *
 * It is not onboarding. There is no modal, no sequence and no second step. It
 * goes away on its own, it goes away the moment the user does the thing it is
 * describing, and once it has gone it never comes back.
 */

export const HINT_KEY = 'kickback:layout-hint-seen'

/** Long enough to read twice, short enough not to become furniture. */
export const HINT_TIMEOUT_MS = 12_000

function alreadySeen(): boolean {
  try {
    return window.localStorage?.getItem(HINT_KEY) === '1'
  } catch {
    // Storage blocked: better to never show it than to show it every load.
    return true
  }
}

function remember(): void {
  try {
    window.localStorage?.setItem(HINT_KEY, '1')
  } catch {
    /* ignore */
  }
}

export interface LayoutHint {
  visible: boolean
  dismiss: () => void
}

export function useLayoutHint(): LayoutHint {
  const [visible, setVisible] = useState(() => !alreadySeen())

  const dismiss = useCallback(() => {
    setVisible(false)
    remember()
  }, [])

  // Doing the thing is better than reading about it, so the panel also calls
  // dismiss() when a drag or resize starts. That happens in the gesture
  // handler rather than in an effect here: it is caused by the user acting,
  // not by state changing.
  useEffect(() => {
    if (!visible) return
    const timer = window.setTimeout(dismiss, HINT_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [visible, dismiss])

  return { visible, dismiss }
}
