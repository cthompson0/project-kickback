/**
 * Isolation, enforced rather than promised.
 *
 * The Test Lab must not be able to touch production analytics, private-beta
 * analytics, Supabase presence, friendships, groups or chats. Three separate
 * things make that true, and this file is the last of them:
 *
 *   1. The lab is a SEPARATE Vite app. It is not imported by the extension
 *      entry points, so no lab code exists in `dist/`, and the extension holds
 *      no lab surface to activate.
 *   2. Nothing in the lab constructs a Supabase client. The analytics hub is
 *      given a capturing backend, and every service that would need a session
 *      is simply absent - there is no token to send with anything.
 *   3. This: the page's outbound network primitives are replaced with ones
 *      that throw for any destination except the dev server that served the
 *      page. If some future edit reintroduces a hosted write, it fails loudly
 *      at the moment it is attempted, with a stack trace naming the caller.
 *
 * (3) exists because (1) and (2) are properties of the code as it stands, and
 * this is developer tooling that will be extended by people who did not write
 * it. A guarantee that only holds while nobody adds an import is not one.
 *
 * WHY THE DEV SERVER IS EXEMPT
 *
 * Vite serves the modules and keeps a hot-reload socket open, both to the
 * origin this page was loaded from. Blocking those would not make the lab
 * safer - the dev server is on this machine and holds nothing - it would only
 * make the lab unusable, and a safety measure that gets switched off to get
 * work done protects nothing. Same origin is allowed; everything else,
 * including every Supabase host, is refused.
 */

export interface NetworkAttempt {
  api: 'fetch' | 'XMLHttpRequest' | 'WebSocket' | 'sendBeacon'
  target: string
}

/**
 * Is this the dev server that served the page?
 *
 * Compared on HOST rather than origin, because the hot-reload socket is
 * ws://localhost:5199 while the page is http://localhost:5199 - same server,
 * different scheme. Host still separates it from every Supabase host, which
 * is the distinction that matters.
 */
function isLocal(target: unknown, origin: string): boolean {
  try {
    // Relative, so a bare module path resolves to the page's own server.
    return new URL(String(target), origin).host === new URL(origin).host
  } catch {
    // Unparseable means we cannot show it is local, so it is not.
    return false
  }
}

/**
 * Cut the page off from everything except its own dev server.
 *
 * Returns the list attempts are recorded in, so the surface can show what was
 * blocked rather than the developer only finding out from the console.
 */
export function sealNetwork(
  onAttempt: (attempt: NetworkAttempt) => void,
  origin: string = typeof location === 'undefined' ? 'http://localhost' : location.origin,
): NetworkAttempt[] {
  const attempts: NetworkAttempt[] = []

  const refuse = (api: NetworkAttempt['api'], target: unknown): never => {
    const attempt: NetworkAttempt = { api, target: String(target) }
    attempts.push(attempt)
    onAttempt(attempt)
    throw new Error(
      `Watchside Test Lab: blocked ${api} to ${attempt.target}. ` +
        'The lab may not talk to anything but its own dev server - simulated state must ' +
        'never reach a server. See docs/TEST_LAB.md.',
    )
  }

  const scope = globalThis as unknown as Record<string, unknown>
  const realFetch = scope.fetch as typeof fetch | undefined
  const RealXhr = scope.XMLHttpRequest as (new () => XMLHttpRequest) | undefined
  const RealSocket = scope.WebSocket as (new (url: string, protocols?: string[]) => WebSocket) | undefined

  scope.fetch = (input: unknown, init?: unknown) => {
    const target = typeof input === 'string' ? input : ((input as Request)?.url ?? input)
    if (!isLocal(target, origin)) refuse('fetch', target)
    return realFetch?.(input as RequestInfo, init as RequestInit)
  }

  // A primitive this runtime does not have still gets a guard rather than
  // being left undefined - otherwise the seal is only as complete as the
  // environment happens to be.
  if (!RealXhr) {
    scope.XMLHttpRequest = class {
      open(_method: string, url: string): void {
        refuse('XMLHttpRequest', url)
      }
    }
  } else {
    class GuardedXhr extends RealXhr {
      open(method: string, url: string | URL, ...rest: unknown[]): void {
        if (!isLocal(url, origin)) refuse('XMLHttpRequest', url)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(super.open as any)(method, url, ...rest)
      }
    }
    scope.XMLHttpRequest = GuardedXhr
  }

  if (!RealSocket) {
    scope.WebSocket = class {
      constructor(url: string) {
        refuse('WebSocket', url)
      }
    }
  } else {
    class GuardedSocket extends RealSocket {
      constructor(url: string, protocols?: string[]) {
        if (!isLocal(url, origin)) refuse('WebSocket', url)
        super(url, protocols)
      }
    }
    scope.WebSocket = GuardedSocket
  }

  if (typeof navigator !== 'undefined' && 'sendBeacon' in navigator) {
    // No exemption: a beacon is fire-and-forget telemetry, which is precisely
    // the thing that must not be able to leave.
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: (url: string) => refuse('sendBeacon', url),
    })
  }

  return attempts
}

/**
 * Refuse to run outside a Test Lab build.
 *
 * Belt and braces on top of the lab being a separate app: if lab code is ever
 * imported into the extension, this throws at module load rather than
 * producing a build that quietly contains a simulator.
 */
export function assertTestLabBuild(mode: string | undefined): void {
  if (mode !== 'test_lab') {
    throw new Error(
      `Watchside Test Lab loaded in a "${mode ?? 'production'}" build. ` +
        'The lab is development-only and must never ship.',
    )
  }
}
