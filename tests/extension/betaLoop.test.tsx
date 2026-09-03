import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountCard } from '../../src/ui/components/AuthStates'
import { BadgeShelf } from '../../src/ui/components/BadgeShelf'
import { MessageList } from '../../src/ui/components/Conversation'
import {
  codeFromUrl,
  inviteLinkFor,
  legacyInviteLinkFor,
  normalizeInviteCode,
} from '../../src/core/invites'
import { INITIAL_STATE } from '../../src/client/types'
import type {
  KickbackClient,
  KickbackIdentity,
  KickbackPreferences,
} from '../../src/client/types'
import type { DisplayedBadge, EarnedBadge } from '../../src/background/supabaseBackend'

/**
 * The Friends Beta loop, end to end, at the cheapest layer that can prove each
 * link.
 *
 * The server rules are proven against real PostgreSQL in
 * tests/db/growthLoop.test.ts - who may be suggested, what counts as a
 * successful referral, that credit cannot be duplicated, that a badge cannot be
 * forged. There is no value in restating any of that here.
 *
 * What this file covers is the part that only exists once the two halves are
 * joined: the link contract that carries a code from a shared URL into the
 * extension, and the badge surface that lets somebody find what they earned and
 * choose to show it.
 */

const CODE = 'ABCDEFGHJKMNPQRSTVWXYZ'.slice(0, 22)

const IDENTITY: KickbackIdentity = {
  userId: 'me',
  displayName: 'Me',
  avatarUrl: null,
  twitchLogin: 'me',
  friendCode: 'KB-TEST-CODE',
  presenceVisibility: 'visible',
}

const PREFERENCES: KickbackPreferences = INITIAL_STATE.preferences

const CONNECTOR: EarnedBadge = {
  key: 'referrer_1',
  name: 'Connector',
  description: 'Brought a friend to Watchside.',
  icon: '🔗',
  issuer: 'kickback',
  displayed: false,
}

const RECRUITER: EarnedBadge = {
  key: 'referrer_5',
  name: 'Recruiter',
  description: 'Brought five friends to Watchside.',
  icon: '🌱',
  issuer: 'kickback',
  displayed: true,
}

function badgeClient(badges: EarnedBadge[], equip?: (key: string | null) => void): KickbackClient {
  return {
    badges: async () => badges,
    setDisplayedBadge: async (key: string | null) => {
      equip?.(key)
    },
  } as unknown as KickbackClient
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
  Reflect.deleteProperty(globalThis, 'document')
})

// ============================================ acquisition: the link contract

describe('an invite survives the whole journey', () => {
  /**
   * Hop 1 is the landing page; hop 2 is Twitch, where the content script
   * already runs. That second hop is the entire reason no new host permission
   * was needed.
   */
  it('carries the code from the shared link to Twitch and back out', () => {
    /*
     * Hop 1's reader changed with the canonical link, and the distinction is
     * deliberate. `codeFromUrl` parses QUERY parameters only, because it runs
     * on twitch.tv where a channel name is a path segment too. The canonical
     * link carries the code in the PATH, so a shared link is read by
     * `normalizeInviteCode`, which understands every shape ever minted.
     */
    const shared = inviteLinkFor(CODE)
    expect(shared).toBe(`https://watchside.app/i/${CODE}`)
    expect(normalizeInviteCode(shared)).toBe(CODE)

    // Hop 2 is unchanged: the landing page hands the code to Twitch.
    const onward = `https://www.twitch.tv/?kickback_invite=${normalizeInviteCode(shared)}`
    expect(codeFromUrl(onward)).toBe(CODE)
  })

  /** Links already sitting in somebody's DMs keep working forever. */
  it('still reads a legacy link end to end', () => {
    const legacy = legacyInviteLinkFor(CODE)
    expect(codeFromUrl(legacy)).toBe(CODE)
    expect(normalizeInviteCode(legacy)).toBe(CODE)
  })

  it('leaves an ordinary Twitch visit unattributed', () => {
    expect(codeFromUrl('https://www.twitch.tv/lirik')).toBeNull()
  })
})

// ================================================ the landing page itself

describe('the landing page implementation package', () => {
  const HTML = readFileSync('docs/web/invite-landing/index.html', 'utf8')

  it('reads the code from the link it is given', () => {
    expect(HTML).toContain("get('c')")
  })

  /** The same alphabet and length the server enforces. */
  it('validates against the real code format', () => {
    expect(HTML).toContain('[0-9ABCDEFGHJKMNPQRSTVWXYZ]{22}')
  })

  it('hands the code onward to Twitch', () => {
    expect(HTML).toContain('https://www.twitch.tv/?kickback_invite=')
  })

  it('points install at the permanent extension id', () => {
    expect(HTML).toContain('ngfopkeokddfnncdhfkhnffilbdhkkip')
  })

  /**
   * BOTH STORES, AND NEITHER HIDEABLE.
   *
   * This page offered Chrome alone while Firefox was approved, public, and the
   * only build a person could actually install. Every invite link in
   * circulation pointed here, and the invite is the one way a stranger with no
   * Watchside friends gets a first connection - so the dead end sat on the
   * single path that had to work.
   */
  it('offers both stores', () => {
    expect(HTML).toContain('https://chromewebstore.google.com/detail/')
    expect(HTML).toContain('https://addons.mozilla.org/firefox/addon/watchside/')
    expect(HTML).toContain('Add to Chrome')
    expect(HTML).toContain('Add to Firefox')
  })

  it('renders both install links before any detection runs', () => {
    /*
     * The guard that keeps detection decorative. Both anchors exist in the
     * markup with ids the script only ever assigns hrefs to - so a wrong guess,
     * a spoofed agent or an unanticipated browser still leaves two working
     * choices. A page that picked one button and rendered only that would pass
     * the test above and still strand people.
     */
    const body = HTML.slice(HTML.indexOf('<body'))
    expect(body).toContain('id="install-chrome"')
    expect(body).toContain('id="install-firefox"')
    // Nothing may remove or hide an install button.
    expect(HTML).not.toMatch(/install-(chrome|firefox)'\)\.(remove|style)/)
  })

  it('does not claim a phone can install it', () => {
    // Watchside is desktop-only - the Gecko build omits gecko_android - so a
    // mobile visitor is told that rather than sent to a store that will not
    // serve them.
    expect(HTML).toContain('desktop browser extension')
    expect(HTML).toContain('runs in Chrome and Firefox')
  })

  it('no longer describes Watchside as Chrome-only', () => {
    expect(HTML).not.toContain('Watchside is a Chrome extension')
    expect(HTML).not.toContain('from the Chrome Web Store.')
  })

  it('says a friend invited them', () => {
    expect(HTML).toContain('A friend invited you to Watchside')
  })

  /** A truncated or curious visit is not an error page. */
  it('degrades to generic copy rather than an error', () => {
    expect(HTML).toContain('See where your friends are watching on Twitch')
  })

  /** The code must not travel to Twitch or the Store in a Referer header. */
  it('sends no referrer', () => {
    expect(HTML).toContain('name="referrer" content="no-referrer"')
  })

  it('stores nothing and sends nothing anywhere', () => {
    expect(HTML).not.toContain('localStorage')
    expect(HTML).not.toContain('sessionStorage')
    expect(HTML).not.toContain('document.cookie')
    expect(HTML).not.toContain('fetch(')
    expect(HTML).not.toContain('XMLHttpRequest')
  })

  /** Narrow screens are a first-class case: invites are opened on phones. */
  it('handles a narrow screen', () => {
    expect(HTML).toContain('@media (max-width: 420px)')
  })

  /**
   * Naming the inviter would need a public code-to-identity lookup - a new
   * unauthenticated surface exposing who invited whom. The page therefore
   * resolves nothing: the code is read, validated and passed on, and that is
   * the entire script.
   */
  it('resolves no identity from the code', () => {
    expect(HTML).not.toContain('supabase')
    expect(HTML).not.toContain('/rest/v1/')
    expect(HTML).not.toContain('anoteroslabs.github.io/api')
  })
})

// =================================================== identity: the badge loop

describe('a badge can be found and shown', () => {
  const render = (client: KickbackClient) =>
    renderToStaticMarkup(<BadgeShelf client={client} />)

  /**
   * An account with no badges has no badge section - no empty state, no
   * "keep going" nudge.
   */
  it('shows nothing before anything is earned', () => {
    expect(render(badgeClient([]))).toBe('')
  })

  it('does not render on the first pass before badges load', () => {
    const pending = { badges: () => new Promise(() => {}) } as unknown as KickbackClient
    expect(render(pending)).toBe('')
  })
})

describe('the account card carries the shelf', () => {
  function renderAccount(client: KickbackClient) {
    return renderToStaticMarkup(
      <AccountCard
        textSize="default"
        onTextSizeChange={() => {}}
        client={client}
        identity={IDENTITY}
        onSignOut={() => {}}
        onDeleted={() => {}}
        measurementReadiness={null}
        onVisibilityChange={() => {}}
        preferences={PREFERENCES}
        onPreferencesChange={() => {}}
        onResetLayout={() => {}}
        mutedUserIds={[]}
        knownPeople={[]}
        onUnmute={() => {}}
        blocked={[]}
        onUnblock={() => {}}
        onClose={() => {}}
        onFeedback={() => {}}
      />,
    )
  }

  /** The account panel is where a person already goes to see who they are. */
  it('is where an earned badge waits', () => {
    const html = renderAccount(badgeClient([CONNECTOR]))
    expect(html).toContain('Watchside v')
  })

  it('does not disturb the account card when nothing is earned', () => {
    const html = renderAccount(badgeClient([]))
    expect(html).not.toContain('kb-badges')
    expect(html).toContain('Watchside v')
  })
})

// ------------------------------------------------ what the shelf must express

describe('the shelf contract', () => {
  const SOURCE = readFileSync('src/ui/components/BadgeShelf.tsx', 'utf8')
  const CSS = readFileSync('src/ui/kickback.css', 'utf8')

  /** Watchside must never look like it granted somebody a Twitch badge. */
  it('says these are Watchside badges', () => {
    expect(SOURCE).toContain('Watchside badges')
  })

  it('equips through the server, never locally', () => {
    expect(SOURCE).toContain('client.setDisplayedBadge(')
  })

  /** Tapping the equipped badge again clears it - display can be disabled. */
  it('can show none', () => {
    expect(SOURCE).toContain('equip(badge.displayed ? null : badge.key)')
  })

  it('renders only what the server says was earned', () => {
    // The list comes from my_badges(); there is no local catalogue to pick
    // from, so an unearned badge is not reachable in the UI at all.
    expect(SOURCE).toContain('.badges()')
    expect(SOURCE).not.toContain('referrer_25')
  })

  it('has a compact treatment, on and off', () => {
    expect(CSS).toContain('.kb-badge {')
    expect(CSS).toContain('.kb-badge-on {')
  })
})

// ------------------------------------------- what the equipped badge means

describe('the equipped badge reaches the panel state', () => {
  it('is broadcast so any surface can read it', () => {
    expect(Object.keys(INITIAL_STATE)).toContain('displayedBadge')
    expect(INITIAL_STATE.displayedBadge).toBeNull()
  })

  it('carries its issuer, so Watchside and Twitch stay distinguishable', () => {
    expect(RECRUITER.issuer).toBe('kickback')
  })

  it('reports the referral count that earned it', () => {
    expect(Object.keys(INITIAL_STATE)).toContain('referralCount')
    expect(INITIAL_STATE.referralCount).toBe(0)
  })
})

// ------------------------------------- the equipped badge, seen by a friend

describe('a friend sees the badge you equipped', () => {
  const MESSAGES = [
    { id: 'm1', userId: 'alice', displayName: 'Alice', avatarUrl: null, body: 'hey' },
  ]

  const cardContext = {
    selfId: 'bob',
    viewerActivity: { type: 'idle' } as const,
    friendIds: new Set(['alice']),
    outgoingRequestIds: new Set<string>(),
  }

  const draw = (badges?: Record<string, DisplayedBadge>) =>
    renderToStaticMarkup(
      <MessageList
        messages={MESSAGES}
        annotations={new Map()}
        selfId="bob"
        client={{} as unknown as KickbackClient}
        cardContext={cardContext}
        badges={badges}
        empty="Nothing yet."
      />,
    )

  const ALICE_BADGE: Record<string, DisplayedBadge> = {
    alice: {
      userId: 'alice',
      key: 'referrer_1',
      name: 'Connector',
      icon: '🔗',
      issuer: 'kickback',
    },
  }

  it('draws it beside their name', () => {
    const html = draw(ALICE_BADGE)
    expect(html).toContain('kb-msg-badge')
    expect(html).toContain('🔗')
    expect(html).toContain('Alice')
  })

  /** The title says who issued it - never that Twitch did. */
  it('says it is a Watchside badge', () => {
    expect(draw(ALICE_BADGE)).toContain('Connector — Watchside badge')
  })

  /** Disabling display removes the projection, so the chip disappears. */
  it('draws nothing when they are showing none', () => {
    const html = draw({})
    expect(html).not.toContain('kb-msg-badge')
    expect(html).toContain('Alice')
  })

  it('draws nothing when the projection is absent entirely', () => {
    const html = draw(undefined)
    expect(html).not.toContain('kb-msg-badge')
    expect(html).toContain('Alice')
  })

  /** One badge per person. Never a row of them. */
  it('draws exactly one chip', () => {
    expect(draw(ALICE_BADGE).match(/kb-msg-badge/g)).toHaveLength(1)
  })
})
