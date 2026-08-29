/**
 * The minimum jsdom needs before a Watchside component will mount.
 *
 * Deliberately tiny. Anything that grows here is a signal that a test belongs
 * in the node project instead - this environment exists for effects, not for
 * building a second application harness.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

// React 19 refuses to run `act` without it, and every effect test needs act.
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/*
 * jsdom implements no layout, so these are absent rather than wrong.
 *
 * Stubbed as no-ops rather than mocked with assertions: the scroll tests below
 * measure `scrollTop` against explicitly set geometry, which is deterministic,
 * instead of asking whether a browser API was called - a test that only checks
 * "scrollIntoView fired" is exactly the test that would have passed while the
 * autoscroll was broken.
 */
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {}
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

export {}
