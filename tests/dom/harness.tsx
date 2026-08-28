import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import type { ReactNode } from 'react'

/**
 * Mount, re-render, unmount - and nothing else.
 *
 * No testing library. React 19 exports `act` itself and `createRoot` is the
 * same call the content script makes, so a dependency here would buy queries
 * these tests do not need and a second rendering model to keep in step with
 * the real one.
 */

export interface Mounted {
  container: HTMLDivElement
  render(node: ReactNode): void
  unmount(): void
}

export function mount(node: ReactNode): Mounted {
  const container = document.createElement('div')
  document.body.appendChild(container)

  let root: Root
  act(() => {
    root = createRoot(container)
    root.render(node)
  })

  return {
    container,
    render(next: ReactNode) {
      act(() => {
        root.render(next)
      })
    },
    unmount() {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

/** Flush effects and any promise callbacks they scheduled. */
export function flush(): void {
  act(() => {})
}

/**
 * Dispatch an event the way a browser would, inside act.
 *
 * Wrapped rather than left to the caller because an interaction that updates
 * state outside act leaves React with work queued and no guarantee about when
 * it runs - which shows up as a test asserting against the previous render and
 * being extremely confusing about it.
 */
export function fire(target: EventTarget, event: Event): void {
  act(() => {
    target.dispatchEvent(event)
  })
}

/** A real click, inside act. */
export function click(element: HTMLElement): void {
  act(() => {
    element.click()
  })
}

/**
 * Give an element the geometry jsdom will not compute.
 *
 * `scrollHeight` and `clientHeight` are getters with no layout behind them, so
 * a scroll test has to state the shape it is testing. `scrollTop` is a real
 * writable property in jsdom, which is what makes the assertions meaningful:
 * the component's own arithmetic is being checked, not a spy.
 */
export function giveGeometry(
  element: HTMLElement,
  { scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number },
): void {
  Object.defineProperty(element, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(element, 'clientHeight', { value: clientHeight, configurable: true })
}

/**
 * Geometry that grows with the content, the way a real one does.
 *
 * `scrollHeight` is a getter over the rows actually in the DOM rather than a
 * number set by the test. That matters for ordering: React commits the DOM and
 * then runs effects inside the same `act`, so a test cannot set a new height
 * in between - and a fixed height would make every arrival assertion measure
 * the height from BEFORE the message arrived.
 *
 * It also makes the assertions mean more. "Followed the content down" is only
 * a real claim if the content moved.
 */
export function giveGrowingGeometry(
  element: HTMLElement,
  { rowSelector, rowHeight, clientHeight }: {
    rowSelector: string
    rowHeight: number
    clientHeight: number
  },
): { extra: (pixels: number) => void } {
  let extra = 0
  Object.defineProperty(element, 'scrollHeight', {
    get: () => element.querySelectorAll(rowSelector).length * rowHeight + extra,
    configurable: true,
  })
  Object.defineProperty(element, 'clientHeight', { value: clientHeight, configurable: true })
  return {
    /** Simulate something growing that is not a row - a late-loading image. */
    extra: (pixels: number) => {
      extra += pixels
    },
  }
}
