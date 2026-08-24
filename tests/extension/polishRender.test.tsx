import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { UserCard } from '../../src/ui/components/UserCard'
import type { UserCardContext } from '../../src/ui/components/UserCard'
import { GroupChat } from '../../src/ui/components/GroupChat'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import { GroupIcon } from '../../src/ui/components/GroupIcon'
import type { KickbackClient, ChatMessage } from '../../src/client/types'
import type { Presence, User } from '../../src/core/types'

/**
 * The rendered output of this pass.
 *
 * Two of these are structural rather than visual on purpose. The chat wrapping
 * bug was invisible to every assertion about text - the words were right, the
 * *layout* was wrong - so what is pinned here is the formatting context that
 * caused it.
 */

const NOW = 1_700_000_000_000

const user = (over: Partial<User> = {}): User => ({
  id: 'u1',
  username: 'anoterostv',
  displayName: 'AnoterosTV',
  avatarUrl: null,
  accentColor: '#ff8452',
  ...over,
})

const watching = (channel: string): Presence => ({
  userId: 'u1',
  status: 'online',
  activity: { type: 'watching', platform: 'twitch', channel },
  since: NOW,
  lastSeenAt: Date.now(),
})

/** The one context every card takes. Overridden per test as needed. */
const context = (over: Partial<UserCardContext> = {}): UserCardContext => ({
  selfId: 'me',
  viewerActivity: { type: 'idle' },
  friendIds: new Set(),
  outgoingRequestIds: new Set(),
  ...over,
})

function stubClient(): KickbackClient {
  return {
    sendFriendRequest: async () => 'req',
    removeFriend: async () => {},
    searchEmotes: async () => [],
    sendGroupMessage: async () => {},
  } as unknown as KickbackClient
}

function withNames(node: React.ReactNode, seen: Record<string, string> = {}) {
  return renderToStaticMarkup(
    <ChannelNameProvider people={[]} seen={seen}>
      {node}
    </ChannelNameProvider>,
  )
}

// ------------------------------------------------------------- the user card

describe('the user card', () => {
  const card = (over: Partial<Parameters<typeof UserCard>[0]> = {}) =>
    withNames(
      <UserCard
        user={user()}
        presence={watching('lirik')}
        client={stubClient()}
        context={context()}
        onClose={() => {}}
        {...over}
      />,
      { lirik: 'LIRIK' },
    )

  it('shows the display name and the canonical handle, not one derived from the other', () => {
    const html = card()
    expect(html).toContain('AnoterosTV')
    expect(html).toContain('@anoterostv')
  })

  it('offers Add friend to a group member who is not a friend yet', () => {
    // The point of the card: a path from "I see this person every night" to
    // "we are friends".
    const html = card({ context: context() })
    expect(html).toContain('Add friend')
    expect(html).not.toContain('Remove friend')
  })

  it('offers Remove friend to a friend, and no Add', () => {
    const html = card({ context: context({ friendIds: new Set(['u1']) }) })
    expect(html).toContain('Remove friend')
    expect(html).not.toContain('Add friend')
  })

  it('says a request is already sent rather than offering it again', () => {
    expect(card({ context: context({ outgoingRequestIds: new Set(['u1']) }) })).toContain(
      'Request sent',
    )
  })

  it('offers no relationship actions on your own card', () => {
    const html = card({ context: context({ selfId: 'u1' }) })
    expect(html).not.toContain('Add friend')
    expect(html).not.toContain('Remove friend')
  })

  it('offers JOIN when they are somewhere you could go', () => {
    expect(card()).toContain('JOIN')
  })

  it('offers no JOIN when they shared no activity', () => {
    const html = card({ presence: null })
    expect(html).not.toContain('JOIN')
    // And makes no claim about where they are.
    expect(html).toContain('Offline')
  })

  it('links to Twitch by canonical login, never by display name', () => {
    // Twitch URLs are keyed on the login; the display name would 404.
    expect(card()).toContain('href="https://www.twitch.tv/anoterostv"')
  })

  it('names the channel the way Twitch does', () => {
    expect(card()).toContain('LIRIK')
  })

  it('shows nothing beyond the presence it was handed', () => {
    // No friend code, no email, no last-seen timestamp - the card cannot leak
    // what it was never given.
    const html = card({ presence: null })
    expect(html).not.toMatch(/KB-[A-Z0-9]/)
    expect(html).not.toContain('@example')
    expect(html).not.toContain('lirik')
  })
})

// ------------------------------------------------------------- chat wrapping

describe('a chat line is one inline formatting context', () => {
  const css = readFileSync(join(process.cwd(), 'src/ui/kickback.css'), 'utf8')
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`)
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at))
  }

  it('does not lay the name and the message out as flex items', () => {
    /*
     * The bug. As flex items the message body was sized to
     * `container - username - gap`, and used that width for EVERY line, so
     * prose wrapped with empty space beside it and a longer name made
     * everyone's messages narrower. Measured on a 471px log: a message wrapped
     * at 399px.
     */
    expect(rule('.kb-msg-head')).not.toContain('display: flex')
    expect(rule('.kb-msg-head')).not.toContain('flex-wrap')
  })

  it('breaks a long unbroken token instead of overflowing', () => {
    // A URL nobody can break must still fail safely rather than widen the row.
    expect(rule('.kb-msg-head')).toContain('overflow-wrap: break-word')
  })

  it('spaces the name from the message without a flex gap', () => {
    expect(rule('.kb-msg-who')).toContain('margin-right')
  })

  it('renders the name and the body as siblings in one block', () => {
    const messages: ChatMessage[] = [
      {
        id: 'm1',
        groupId: 'g1',
        userId: 'u1',
        displayName: 'AnoterosTV',
        avatarUrl: null,
        body: 'also sometimes chats have a random line break from my username?',
        createdAt: new Date(NOW).toISOString(),
      },
    ]
    const html = withNames(
      <GroupChat
        groupId="g1"
        messages={messages}
        selfId="me"
        client={stubClient()}
        cardContext={context()}
      />,
    )

    // One row, name then body, nothing wrapping the body in its own block.
    const head = html.slice(html.indexOf('kb-msg-head'), html.indexOf('</div>', html.indexOf('kb-msg-head')))
    expect(head.indexOf('kb-msg-who')).toBeLessThan(head.indexOf('kb-msg-body'))
    expect(html).toContain('AnoterosTV')
    expect(html).toContain('random line break')
  })

  it('keeps a long display name from being treated as layout', () => {
    const messages: ChatMessage[] = [
      {
        id: 'm1',
        groupId: 'g1',
        userId: 'u1',
        displayName: 'AVeryLongDisplayNameIndeed',
        avatarUrl: null,
        body: 'short',
        createdAt: new Date(NOW).toISOString(),
      },
    ]
    const html = withNames(
      <GroupChat
        groupId="g1"
        messages={messages}
        selfId="me"
        client={stubClient()}
        cardContext={context()}
      />,
    )
    // The name is text, with no width of its own to impose on the message.
    expect(html).toContain('AVeryLongDisplayNameIndeed')
    expect(html).not.toMatch(/kb-msg-who"[^>]*style=/)
  })
})

// -------------------------------------------------------------- group icons

describe('a group icon', () => {
  it('draws the chosen emoji', () => {
    expect(renderToStaticMarkup(<GroupIcon icon="🎮" />)).toContain('🎮')
  })

  it('draws a neutral mark when none was chosen', () => {
    // Not a stand-in emoji: an icon nobody picked should not look like one
    // somebody did.
    const html = renderToStaticMarkup(<GroupIcon icon={null} />)
    expect(html).toContain('kb-group-icon-empty')
    expect(html).toContain('•')
  })
})
