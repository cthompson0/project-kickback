import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { GroupChat } from '../../src/ui/components/GroupChat'
import { GroupActivitySummary } from '../../src/ui/components/GroupActivitySummary'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import type { ChatMessage, GroupMember, KickbackClient } from '../../src/client/types'
import type { Activity, Presence, User } from '../../src/core/types'

/**
 * The three surfaces this pass added or changed: a clickable chat sender, the
 * compact activity summary above chat, and the invite button's relationship
 * state.
 */

const NOW = 1_700_000_000_000

const user = (id = 'u1'): User => ({
  id,
  username: id,
  displayName: id === 'u1' ? 'AnoterosTV' : id.toUpperCase(),
  avatarUrl: null,
  accentColor: '#ff8452',
})

const watching = (channel: string, userId = 'u1'): Presence => ({
  userId,
  status: 'online',
  activity: { type: 'watching', platform: 'twitch', channel },
  since: NOW,
  // Fresh, so the staleness rule does not turn it offline mid-test.
  lastSeenAt: Date.now(),
})

const offline = (userId: string): Presence => ({
  userId,
  status: 'offline',
  activity: { type: 'idle' },
  since: NOW,
})

const browsing = (userId: string): Presence => ({
  userId,
  status: 'online',
  activity: { type: 'browsing', platform: 'twitch' },
  since: NOW,
  lastSeenAt: Date.now(),
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

// ------------------------------------------------------- chat sender cards

describe('a chat sender is clickable', () => {
  const message: ChatMessage = {
    id: 'm1',
    groupId: 'g1',
    userId: 'u1',
    displayName: 'AnoterosTV',
    avatarUrl: null,
    body: 'hello there',
    createdAt: new Date(NOW).toISOString(),
  }

  const chat = () =>
    withNames(
      <GroupChat
        groupId="g1"
        messages={[message]}
        selfId="me"
        client={stubClient()}
        members={[{ user: user(), role: 'member', presence: watching('lirik') }]}
        cardContext={{
          selfId: 'me',
          viewerActivity: { type: 'idle' },
          friendIds: new Set(),
          outgoingRequestIds: new Set(),
        }}
      />,
      { lirik: 'LIRIK' },
    )

  it('renders the sender name as a control', () => {
    const html = chat()
    expect(html).toContain('kb-msg-who-btn')
    expect(html).toContain('AnoterosTV')
    expect(html).toContain('title="About AnoterosTV"')
  })

  it('keeps the name inline, so the wrapping fix survives', () => {
    /*
     * A block-level or flex control here would reintroduce the bug the name
     * sits inside: the body would be sized around it on every line.
     *
     * A `<button>` would too, for a reason no stylesheet can express - Chrome
     * coerces `display: inline` to `inline-block` on one - so the tag itself
     * is asserted. `npm run test:wrap` measures the resulting line boxes.
     */
    const html = chat()
    expect(html).not.toMatch(/kb-msg-who-btn[^"]*"[^>]*style="[^"]*display:\s*(block|flex)/)
    expect(html).toMatch(/<span[^>]*role="button"[^>]*class="kb-msg-who/)
    const head = html.slice(html.indexOf('kb-msg-head'), html.indexOf('</div>'))
    expect(head).not.toContain('<button')
  })

  it('leaves the message body outside the control', () => {
    // Selecting message text must not be interrupted by the name being a
    // control, so the body is a sibling rather than a child.
    const html = chat()
    const label = html.match(
      /<span[^>]*class="kb-msg-who[^"]*"[^>]*>((?:[^<]|<span[^>]*>[^<]*<\/span>)*)<\/span>/,
    )
    expect(label).not.toBeNull()
    // Tags stripped: the separator is its own element so it can keep the
    // ordinary chat colour instead of inheriting the sender's.
    expect(label?.[1].replace(/<[^>]+>/g, '')).toBe('AnoterosTV:')
    expect(html).toContain('hello there')
  })

  it('renders no user card until the sender is clicked', () => {
    expect(chat()).not.toContain('kb-usercard')
  })

  it('is nowhere near the drag handle', () => {
    // The panel header is the only drag handle; chat is not part of it.
    expect(chat()).not.toContain('kb-header')
  })
})

// -------------------------------------------------- compact group summary

describe('the compact activity summary', () => {
  const roster = (entries: Array<[string, Presence | null]>): GroupMember[] =>
    entries.map(([id, presence]) => ({
      user: { ...user(id), id, username: id, displayName: id.toUpperCase() },
      role: 'member' as const,
      presence,
    }))

  const summary = (members: GroupMember[], local: Activity = { type: 'idle' }) =>
    withNames(<GroupActivitySummary members={members} localActivity={local} selfId="me" />, {
      lirik: 'LIRIK',
    })

  it('names where people are watching, with a JOIN', () => {
    const html = summary(roster([['a', watching('lirik', 'a')]]))
    expect(html).toContain('LIRIK')
    expect(html).toContain('JOIN')
    expect(html).toContain('A')
  })

  it('collapses several members on one stream into one row', () => {
    const html = summary(roster([['a', watching('lirik', 'a')], ['b', watching('lirik', 'b')]]))
    expect((html.match(/kb-summary-row/g) ?? []).length).toBe(1)
  })

  it('keeps separate streams on separate rows', () => {
    const html = summary(roster([['a', watching('lirik', 'a')], ['b', watching('xqc', 'b')]]))
    expect((html.match(/kb-summary-row/g) ?? []).length).toBe(2)
  })

  it('calls out the people already with you, and offers them no JOIN', () => {
    const html = summary(roster([['a', watching('lirik', 'a')]]), {
      type: 'watching',
      platform: 'twitch',
      channel: 'lirik',
    })
    expect(html).toContain('Watching with you')
    expect(html).not.toContain('JOIN')
  })

  it('shows nobody who is offline or merely browsing', () => {
    // The full roster belongs behind the member button; this is the part you
    // can act on. Rendering absence above chat would be the roster again.
    const html = summary(
      roster([
        ['a', watching('lirik', 'a')],
        ['ghost', offline('ghost')],
        ['idler', browsing('idler')],
      ]),
    )
    expect(html).not.toContain('GHOST')
    expect(html).not.toContain('IDLER')
    expect(html).toContain('LIRIK')
  })

  it('renders nothing at all when nobody is watching anything', () => {
    expect(summary(roster([['ghost', offline('ghost')]]))).toBe('')
  })

  it('never leaks a member who shared no presence', () => {
    expect(summary(roster([['ghost', null]]))).toBe('')
  })

  it('caps the rows so chat keeps its vertical space', () => {
    const html = summary(
      roster([
        ['a', watching('one', 'a')],
        ['b', watching('two', 'b')],
        ['c', watching('three', 'c')],
        ['d', watching('four', 'd')],
        ['e', watching('five', 'e')],
      ]),
    )
    expect((html.match(/kb-summary-row/g) ?? []).length).toBeLessThanOrEqual(3)
  })

  it('summarises a long name list rather than growing the row', () => {
    const html = summary(
      roster([
        ['a', watching('lirik', 'a')],
        ['b', watching('lirik', 'b')],
        ['c', watching('lirik', 'c')],
        ['d', watching('lirik', 'd')],
        ['e', watching('lirik', 'e')],
      ]),
    )
    expect(html).toContain('+2')
  })

  it('puts the people you are with above the people you could go to', () => {
    const html = summary(
      roster([['a', watching('xqc', 'a')], ['b', watching('lirik', 'b')]]),
      { type: 'watching', platform: 'twitch', channel: 'lirik' },
    )
    // The channel row is labelled by the channel, which is 'xqc' - the
    // uppercase form is the member's display name, not the destination.
    expect(html).toContain('xqc')
    expect(html.indexOf('Watching with you')).toBeLessThan(html.indexOf('xqc'))
  })
})
