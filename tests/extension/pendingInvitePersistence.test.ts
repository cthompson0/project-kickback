import { existsSync, readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { inviteLinkFor, legacyInviteLinkFor, normalizeInviteCode } from '../../src/core/invites'

/**
 * An invite must survive the worker dying mid-sign-in.
 *
 * THE DEFECT THIS EXISTS FOR
 *
 * The pending invite code lived in a bare module-scope variable:
 *
 *     let pendingInviteCode: string | null = null
 *
 * justified by "an invite arrives on Twitch moments before a sign-in that the
 * link itself was pushing towards, so worker memory covers the gap".
 *
 * It does not, in the case that matters most. The recipient of an invite is by
 * definition a new user, so between the code arriving and the claim they have
 * to find the panel, press Continue with Twitch, read a consent screen naming a
 * permission, and approve it. That is a user-driven detour of unbounded length
 * across which MV3 promises nothing - and `src/background/index.ts` says so in
 * its own header: "nothing here may live only in memory".
 *
 * When the worker was recycled in that window the code vanished, and the
 * failure was silent in both directions. The recipient landed with no friend
 * and no error, indistinguishable from an ordinary cold install; the inviter
 * was never told anything happened. That sat on the only path a stranger with
 * no Watchside friends has to a first connection.
 *
 * HOW THIS IS PROVED
 *
 * By running the REAL built bundle in a sandbox and watching the storage it
 * touches, in the same shape as `backgroundLifecycle.test.ts`. A structural
 * test guards the invariant on a bare checkout where `dist/` does not exist.
 *
 * BOTH FAIL AGAINST THE PRE-FIX BUNDLE, which is the point: the old worker
 * never read or wrote this key at all.
 */

const BUNDLE = 'dist/kickback-background.js'
const built = existsSync(BUNDLE)

const SOURCE = readFileSync('src/background/index.ts', 'utf8')

/** The key the invite is held under, kept apart from the campaign touch. */
const INVITE_KEY = 'watchside:pendingInvite'
const CAMPAIGN_KEY = 'watchside:campaignTouch'

function evaluateWorker() {
  const storageGets: unknown[] = []
  const noop = () => {}
  const event = () => ({ addListener: noop, removeListener: noop, hasListener: () => false })

  const chrome = {
    storage: {
      local: {
        get: (keys: unknown) => {
          storageGets.push(keys)
          return Promise.resolve({})
        },
        set: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
    },
    identity: {
      getRedirectURL: () => 'https://extension-id.chromiumapp.org/',
      launchWebAuthFlow: () => Promise.resolve(''),
    },
    notifications: {
      create: noop,
      clear: noop,
      onClicked: event(),
      onButtonClicked: event(),
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://extension-id/${path}`,
      connect: () => ({
        name: 'kickback',
        postMessage: noop,
        disconnect: noop,
        onMessage: event(),
        onDisconnect: event(),
      }),
      onConnect: event(),
      onStartup: event(),
      onInstalled: event(),
    },
    alarms: { create: noop, onAlarm: event() },
    tabs: { create: noop },
  }

  const sandbox: Record<string, unknown> = {
    chrome,
    console: { log: noop, info: noop, warn: noop, error: noop, debug: noop },
    fetch: () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
      }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    AbortController,
    Response,
    Request,
    Headers,
    performance,
    navigator: { onLine: true, userAgent: 'vitest' },
    location: { href: 'chrome-extension://extension-id/' },
    WebSocket: class {
      addListener = noop
      addEventListener = noop
      close = noop
      send = noop
    },
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  sandbox.window = sandbox

  vm.createContext(sandbox)
  vm.runInContext(readFileSync(BUNDLE, 'utf8'), sandbox, { timeout: 20_000 })

  const asked = (key: string) =>
    storageGets.some((entry) => (Array.isArray(entry) ? entry.includes(key) : entry === key))

  return { asked, storageGets }
}

// ======================================= the invariant, against the bundle

describe.runIf(built)('a revived worker recovers the invite it was holding', () => {
  /**
   * THE ASSERTION THAT FAILS AGAINST THE OLD BUNDLE.
   *
   * A worker that reads this key at evaluation is a worker that can survive
   * being recycled during OAuth. One that never reads it cannot, because there
   * is nowhere else the code could have come from.
   */
  it('reads the pending invite back at evaluation, with no event firing', () => {
    const { asked } = evaluateWorker()
    expect(asked(INVITE_KEY), `${INVITE_KEY} is never read, so an evicted worker loses it`).toBe(
      true,
    )
  })

  it('still recovers the campaign touch, which is a different fact', () => {
    // Guards against "fixing" the invite by reusing the campaign's storage.
    const { asked } = evaluateWorker()
    expect(asked(CAMPAIGN_KEY)).toBe(true)
  })
})

// ================================= the invariant, structurally, on a bare tree

describe('the invite is held somewhere a recycled worker can reach', () => {
  it('is not a bare module-scope variable any more', () => {
    /*
     * The exact shape of the defect. `let pendingInviteCode: string | null`
     * held the only copy, and a worker recycled during OAuth restarted with it
     * null and no way to know anything had been lost.
     */
    expect(SOURCE).not.toMatch(/let pendingInviteCode/)
  })

  it('persists it under its own key', () => {
    expect(SOURCE).toContain(INVITE_KEY)
    expect(SOURCE).toMatch(/ext\.storage\.set\(\{ \[PENDING_INVITE_KEY\]/)
    expect(SOURCE).toMatch(/ext\.storage\.remove\(PENDING_INVITE_KEY\)/)
  })

  it('reads it back at startup rather than only on an event', () => {
    /*
     * `runtime.onStartup` fires when the BROWSER starts, never when an MV3
     * worker is revived - the same trap backgroundLifecycle.test.ts exists for.
     * The load has to be a bare call at module scope.
     */
    const startup = SOURCE.indexOf('void loadPendingInvite()')
    expect(startup).toBeGreaterThan(-1)
    const line = SOURCE.slice(SOURCE.lastIndexOf('\n', startup) + 1, startup)
    expect(line.trim(), 'loadPendingInvite must not be nested inside a callback').toBe('')
  })

  it('keeps invite identity separate from acquisition attribution', () => {
    /*
     * Two different questions - "who invited them" and "how did they come to
     * Watchside" - stored under two different keys so neither can ever be read
     * as the other, however similar the mechanism looks.
     */
    expect(INVITE_KEY).not.toBe(CAMPAIGN_KEY)
    expect(SOURCE).toContain(CAMPAIGN_KEY)
    // The invite must not be bound through the campaign RPC, or vice versa.
    expect(SOURCE).toMatch(/claimInvite\(supabase, code\)/)
    expect(SOURCE).toMatch(/bindAcquisition\(supabase, touch\.code\)/)
  })
})

// =========================================================== the lifetime

describe('a held invite has a bounded life', () => {
  it('expires, so a code cannot bind against an unrelated later login', () => {
    expect(SOURCE).toContain('PENDING_INVITE_TTL_MS')
    expect(SOURCE).toMatch(/24 \* 60 \* 60 \* 1000/)
  })

  it('checks the age on the way in as well as on the way out', () => {
    /*
     * An invite that aged out while the browser was closed must never reach the
     * rest of the worker - checking only at claim time would leave a stale code
     * live in memory for the whole session.
     */
    const load = SOURCE.slice(SOURCE.indexOf('async function loadPendingInvite'))
    expect(load.slice(0, 900)).toContain('inviteIsBindable')
  })

  it('refuses a capture dated in the future', () => {
    // A wrong clock would otherwise produce an invite that never expires.
    const guard = SOURCE.slice(SOURCE.indexOf('function inviteIsBindable'))
    expect(guard.slice(0, 500)).toContain('held.capturedAt > now')
  })

  it('clears the code once the server has ruled, and not before', () => {
    /*
     * IDEMPOTENCY AND RETRY, which pull in opposite directions.
     *
     * A network failure must NOT discard the code - that was the old behaviour
     * and it made a dropped connection permanent. But every server answer is
     * final, including `already`, which is the one-referral-per-invitee rule
     * working rather than a failure. So: keep on error, forget on any verdict.
     */
    const claim = SOURCE.slice(SOURCE.indexOf('async function claimPendingInvite'))
    const body = claim.slice(0, claim.indexOf('\n}\n'))
    const errorBranch = body.slice(body.indexOf('if (result.error)'), body.indexOf('const outcome'))
    expect(errorBranch).not.toContain('forgetPendingInvite')
    expect(body).toContain('await forgetPendingInvite()')
  })

  it('does not clear the code before attempting the claim', () => {
    /*
     * The old `claimInviteAfterSignIn` nulled the variable and then claimed, so
     * a failure threw the invite away with nothing left to retry.
     */
    const after = SOURCE.slice(SOURCE.indexOf('function claimInviteAfterSignIn'))
    const body = after.slice(0, after.indexOf('\n}\n'))
    expect(body).toContain('inviteIsBindable')
    expect(body).not.toMatch(/pendingInvite = null[\s\S]*claimPendingInvite/)
  })
})

describe('what gets handed out is the canonical link', () => {
  const CODE = 'ABCDEFGHJKMNPQRSTVWXYZ'

  it('mints watchside.app, never the legacy Pages host', () => {
    /*
     * THE REGRESSION THIS BLOCKS. The legacy page offered Chrome only, on the
     * one path a stranger with no friends has to a first connection - so
     * minting it again would reintroduce a dead end for every invited Firefox
     * user, not merely an unbranded URL.
     */
    const link = inviteLinkFor(CODE)
    expect(link).toBe(`https://watchside.app/i/${CODE}`)
    expect(link).not.toContain('github.io')
    expect(link).not.toContain('?c=')
  })

  it('still reads every link ever minted', () => {
    expect(normalizeInviteCode(inviteLinkFor(CODE))).toBe(CODE)
    expect(normalizeInviteCode(legacyInviteLinkFor(CODE))).toBe(CODE)
    // The oldest shape, from before the rename.
    expect(
      normalizeInviteCode(`https://anoteros-labs.github.io/kickback/invite/?c=${CODE}`),
    ).toBe(CODE)
  })

  it('carries invitation identity, not a campaign code', () => {
    /*
     * Two different questions with two different routes. `/i/` answers "who
     * invited them"; `/c/` answers "how did they come to Watchside". A link
     * that resolved as both would collapse the distinction M5C exists to keep.
     */
    expect(inviteLinkFor(CODE)).toContain('/i/')
    expect(inviteLinkFor(CODE)).not.toContain('/c/')
  })
})
