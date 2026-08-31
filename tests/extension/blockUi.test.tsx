import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { UserCard } from '../../src/ui/components/UserCard'
import type { UserCardContext } from '../../src/ui/components/UserCard'
import { AccountCard } from '../../src/ui/components/AuthStates'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import type { KickbackClient } from '../../src/client/types'
import type { Presence, User } from '../../src/core/types'

/**
 * What the panel shows about Block - and, more importantly, what it does not.
 *
 * The guarantees Block actually makes are server guarantees, and they are
 * asserted against real Postgres in tests/db/blocks.test.ts. Nothing here is
 * load-bearing for safety: a panel that drew everything correctly on top of a
 * server that had not severed the friendship would be a lie, and a panel that
 * drew it badly on top of a server that had would only be untidy.
 *
 * So what is pinned here is the part the server cannot own. That the control
 * exists and is reachable. That it asks before it acts, in our own UI rather
 * than a browser dialog we cannot style or place. That a block is reversible
 * from somewhere the user can find. And that nowhere in the panel is there a
 * string capable of telling somebody they have been blocked.
 */

const NOW = 1_700_000_000_000

const THEM: User = {
  id: 'them',
  username: 'anoterostv',
  displayName: 'AnoterosTV',
  avatarUrl: null,
  accentColor: '#ff8452',
}

const IDENTITY = {
  userId: 'me',
  displayName: 'MySelf',
  twitchLogin: 'myself',
  friendCode: 'ABC123',
  avatarUrl: null,
  presenceVisibility: 'visible' as const,
}

const browsing = (): Presence => ({
  userId: 'them',
  status: 'online',
  activity: { type: 'browsing', platform: 'twitch' },
  since: NOW,
  lastSeenAt: Date.now(),
})

function stubClient(): KickbackClient {
  return {
    blockUser: async () => {},
    unblockUser: async () => {},
    setUserMuted: () => {},
    removeFriend: async () => {},
    sendFriendRequest: async () => 'req',
  } as unknown as KickbackClient
}

function context(overrides: Partial<UserCardContext> = {}): UserCardContext {
  return {
    selfId: 'me',
    viewerActivity: { type: 'idle' },
    friendIds: new Set(['them']),
    outgoingRequestIds: new Set(),
    ...overrides,
  }
}

function card(ctx: UserCardContext, user: User = THEM) {
  return renderToStaticMarkup(
    <ChannelNameProvider people={[]} seen={{}}>
      <UserCard
        user={user}
        presence={browsing()}
        client={stubClient()}
        context={ctx}
        onClose={() => {}}
      />
    </ChannelNameProvider>,
  )
}

function installWindow() {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      innerWidth: 1600,
      innerHeight: 900,
      location: { pathname: '/lirik', href: 'https://www.twitch.tv/lirik' },
      addEventListener: () => {},
      removeEventListener: () => {},
      matchMedia: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelector: () => null,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  })
}

function account(blocked: { user: { id: string; displayName: string } }[], muted: string[] = []) {
  installWindow()
  return renderToStaticMarkup(
    <AccountCard
      // The badge shelf reads through the client; an empty one renders nothing.
      client={{ badges: async () => [] } as unknown as KickbackClient}
      identity={IDENTITY}
      onSignOut={() => {}}
      onDeleted={() => {}}
      onVisibilityChange={() => {}}
      preferences={{ gatheringNotifications: true }}
      onPreferencesChange={() => {}}
      mutedUserIds={muted}
      knownPeople={[{ id: 'them', displayName: 'AnoterosTV' }]}
      onUnmute={() => {}}
      blocked={blocked}
      onUnblock={() => {}}
      onFeedback={() => {}}
      onClose={() => {}}
      onResetLayout={() => {}}
    />,
  )
}

// ------------------------------------------------------------ the control

describe('the Block control', () => {
  it('is on the card, for anybody who is not the viewer', () => {
    expect(card(context())).toContain('>Block<')
    expect(card(context({ friendIds: new Set() }))).toContain('>Block<')
  })

  it('is never offered on the viewer own card', () => {
    const html = card(context({ selfId: 'them' }))
    expect(html).toContain('This is you')
    expect(html).not.toContain('>Block<')
  })

  it('sits after the ordinary actions rather than ahead of them', () => {
    /*
     * Position is the whole of "not visually dominant" in a row of identical
     * ghost buttons. A safety action people reach for rarely should not be the
     * first thing under somebody's name.
     */
    const html = card(context())
    expect(html.indexOf('>Block<')).toBeGreaterThan(html.indexOf('>Mute<'))
    expect(html.indexOf('>Block<')).toBeGreaterThan(html.indexOf('Remove friend'))
  })
})

// ------------------------------------------------------- already blocked

describe('somebody the viewer has already blocked', () => {
  const blockedCtx = () => context({ friendIds: new Set(), blockedUserIds: new Set(['them']) })

  it('is shown as blocked, and offered nothing that would fail', () => {
    const html = card(blockedCtx())
    expect(html).toContain('Blocked')
    // Every one of these would be refused by the server, so none of them is a
    // button - a control that exists to fail is worse than no control.
    expect(html).not.toContain('Add friend')
    expect(html).not.toContain('>Mute<')
    expect(html).not.toContain('>Block<')
  })

  it('keeps Mute available for everyone else', () => {
    const html = card(context({ blockedUserIds: new Set(['someone-else']) }))
    expect(html).toContain('>Mute<')
    expect(html).toContain('>Block<')
  })
})

// ------------------------------------------------------- the confirmation

describe('the confirmation', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'ui', 'components', 'UserCard.tsx'), 'utf8')

  it('is our own UI, never the browser dialog', () => {
    /*
     * confirm() blocks the page, cannot be styled or placed, and inside a
     * content script it appears to belong to Twitch rather than to us. The card
     * already had an in-place confirmation for removing a friend; Block reuses
     * exactly that.
     */
    expect(source).not.toMatch(/\bconfirm\(/)
    expect(source).toContain('kb-usercard-confirm')
  })

  it('says what will happen, including the part people would not expect', () => {
    // That blocking also ends the friendship is the consequence somebody could
    // reasonably be surprised by, so it is stated rather than implied.
    expect(source).toContain('removes them as a friend')
    expect(source).toContain('stream sessions together')
  })

  it('is not rendered until it is asked for', () => {
    const html = card(context())
    expect(html).not.toContain('kb-usercard-confirm')
  })
})

// ---------------------------------------------------------- managing them

describe('the blocked list in the account card', () => {
  it('names everyone blocked, with a way back', () => {
    const html = account([{ user: { id: 'them', displayName: 'AnoterosTV' } }])
    expect(html).toContain('Blocked')
    expect(html).toContain('AnoterosTV')
    expect(html).toContain('Unblock')
  })

  it('is absent entirely when nobody is blocked', () => {
    const html = account([])
    expect(html).not.toContain('Unblock')
  })

  it('stays a separate list from Muted', () => {
    /*
     * Mute is a local preference about noise; Block is a server-enforced fact
     * about the social graph. One combined roster would invite treating them as
     * one setting, and unblocking somebody would start to look like unmuting
     * them.
     */
    const html = account([{ user: { id: 'them', displayName: 'AnoterosTV' } }], ['them'])
    expect(html).toContain('Unblock')
    expect(html).toContain('Unmute')
    expect(html.indexOf('Muted')).toBeLessThan(html.indexOf('Blocked'))
  })
})

// ------------------------------------------------------ what is never said

describe('the panel never discloses a block to the person blocked', () => {
  it('has no string anywhere that could tell somebody they were blocked', () => {
    /*
     * The one thing this feature exists not to say. Asserted across the whole
     * UI rather than on one component, because the leak would come from
     * whichever surface somebody added the helpful message to.
     */
    const files: string[] = []
    const walk = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const next = join(path, entry.name)
        if (entry.isDirectory()) walk(next)
        else if (/\.(tsx?|css)$/.test(entry.name)) files.push(next)
      }
    }
    walk(join(process.cwd(), 'src', 'ui'))

    // Comments stripped first: this is about what the panel SAYS, and the
    // reasoning for why it says so little is written in the files themselves.
    const prose = (text: string) =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')

    for (const file of files) {
      const text = prose(readFileSync(file, 'utf8'))
      expect(text).not.toMatch(/blocked you/i)
      expect(text).not.toMatch(/has blocked/i)
      expect(text).not.toMatch(/you (?:are|were|have been) blocked/i)
    }
  })
})
