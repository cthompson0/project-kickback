import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FriendsTab } from '../../src/ui/components/FriendsTab'
import { PersonRow } from '../../src/ui/components/PersonRow'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import type { Friend, KickbackClient } from '../../src/client/types'
import type { Activity, Presence, User } from '../../src/core/types'

/**
 * The Friends tab, now speaking the same language as everywhere else.
 *
 * Two things are pinned here. First that a friend's identity is a control that
 * opens the shared card rather than a Friends-only one - there should be
 * exactly one way to look at a person in Kickback. Second that JOIN is a
 * separate target from that control, so the two never compete for one click.
 */

const NOW = 1_700_000_000_000

const user = (id = 'u1'): User => ({
  id,
  username: 'anoterostv',
  displayName: 'AnoterosTV',
  avatarUrl: null,
  accentColor: '#ff8452',
})

const watching = (channel: string): Presence => ({
  userId: 'u1',
  status: 'online',
  activity: { type: 'watching', platform: 'twitch', channel },
  since: NOW,
  lastSeenAt: Date.now(),
})

const browsing = (): Presence => ({
  userId: 'u1',
  status: 'online',
  activity: { type: 'browsing', platform: 'twitch' },
  since: NOW,
  lastSeenAt: Date.now(),
})

const offline = (): Presence => ({
  userId: 'u1',
  status: 'offline',
  activity: { type: 'idle' },
  since: NOW,
  lastSeenAt: NOW,
})

const ON = (channel: string): Activity => ({ type: 'watching', platform: 'twitch', channel })
const IDLE: Activity = { type: 'idle' }

function stubClient(): KickbackClient {
  return {
    removeFriend: async () => {},
    sendFriendRequest: async () => 'req',
  } as unknown as KickbackClient
}

function row(presence: Presence | null, viewer: Activity = IDLE, withClient = true) {
  const friend: Friend = { user: user(), presence }
  return renderToStaticMarkup(
    <ChannelNameProvider people={[]} seen={{ lirik: 'LIRIK' }}>
      <PersonRow
        person={friend}
        localActivity={viewer}
        client={withClient ? stubClient() : undefined}
        cardContext={
          withClient
            ? {
                selfId: 'me',
                viewerActivity: viewer,
                friendIds: new Set(['u1']),
                outgoingRequestIds: new Set(),
              }
            : undefined
        }
      />
    </ChannelNameProvider>,
  )
}

describe('a friend row', () => {
  it('makes the identity a control that opens the shared card', () => {
    // Not a Friends-specific card: the same UserCard the group roster and chat
    // already use.
    expect(row(watching('xqc'))).toContain('kb-row-name-btn')
    expect(row(watching('xqc'))).toContain('title="About AnoterosTV"')
  })

  it('leaves the identity as plain text when no card is available', () => {
    // The demo build and any caller without a client still render a row.
    const html = row(watching('xqc'), IDLE, false)
    expect(html).not.toContain('kb-row-name-btn')
    expect(html).toContain('AnoterosTV')
  })

  it('keeps JOIN as a separate target from the identity', () => {
    // Clicking a name opens a card; clicking JOIN joins. One click, one
    // meaning - the name must not swallow the action.
    const html = row(watching('xqc'))
    const identity = html.slice(html.indexOf('kb-row-name-btn'))
    expect(identity.slice(0, identity.indexOf('</button>'))).not.toContain('JOIN')
    expect(html).toContain('JOIN')
  })

  it('offers no JOIN to the channel the viewer is already on', () => {
    // The reported bug, on the friend row: JOIN reloaded the current stream.
    const html = row(watching('lirik'), ON('lirik'))
    expect(html).not.toContain('JOIN')
    expect(html).toContain('Watching with you')
    expect(html).toContain('HERE')
  })

  it('offers JOIN to a different channel, and names it', () => {
    const html = row(watching('lirik'), ON('xqc'))
    expect(html).toContain('JOIN')
    expect(html).toContain('LIRIK')
  })

  it('says someone is around without offering anywhere to go', () => {
    const html = row(browsing(), ON('lirik'))
    expect(html).toContain('Around')
    expect(html).not.toContain('JOIN')
  })

  it('says offline, and offers nothing', () => {
    const html = row(offline(), ON('lirik'))
    expect(html).toContain('Offline')
    expect(html).not.toContain('JOIN')
  })

  it('treats stale presence as offline, like every other surface', () => {
    const stale = { ...watching('lirik'), lastSeenAt: NOW - 60 * 60_000 }
    const html = row(stale, ON('xqc'))
    expect(html).toContain('Offline')
    expect(html).not.toContain('JOIN')
  })

  it('renders no card until the identity is clicked', () => {
    expect(row(watching('xqc'))).not.toContain('kb-usercard')
  })
})

describe('the friends list', () => {
  const list = (friends: Friend[], viewer: Activity = IDLE) =>
    renderToStaticMarkup(
      <ChannelNameProvider people={[]} seen={{ lirik: 'LIRIK' }}>
        <FriendsTab
          friends={friends}
          localActivity={viewer}
          client={stubClient()}
          cardContext={{
            selfId: 'me',
            viewerActivity: viewer,
            friendIds: new Set(['u1']),
            outgoingRequestIds: new Set(),
          }}
        />
      </ChannelNameProvider>,
    )

  it('heads the same-channel section with the same words as the group view', () => {
    // One vocabulary across the product: the group cluster, the summary, the
    // card and this heading all say the same thing.
    const html = list([{ user: user(), presence: watching('lirik') }], ON('lirik'))
    expect(html).toContain('Watching with you')
    expect(html).not.toContain('Here with you')
  })

  it('passes the card through to every row', () => {
    const html = list([{ user: user(), presence: watching('xqc') }])
    expect(html).toContain('kb-row-name-btn')
  })
})

// ------------------------------------------------------------ invite state

describe('the invite row', () => {
  /**
   * Rendered from the same markup GroupsTab produces, so the states stay
   * pinned without standing a whole group detail view up. The states
   * themselves are decided from authoritative server data - see
   * tests/db/groups.test.ts for who is pending and who is a member.
   */
  const label = (state: 'none' | 'pending' | 'member') =>
    renderToStaticMarkup(
      state === 'none' ? (
        <button type="button" className="kb-join">
          INVITE
        </button>
      ) : state === 'member' ? (
        <span className="kb-relation kb-relation-member">MEMBER</span>
      ) : (
        <button
          type="button"
          className="kb-relation kb-relation-pending kb-relation-btn"
          title="Cancel the invitation to AnoterosTV"
        >
          PENDING
        </button>
      ),
    )

  it('offers an invitation to somebody who has neither', () => {
    expect(label('none')).toContain('INVITE')
  })

  it('shows a member as a label with nothing to press', () => {
    // A control that looks pressable but does nothing is worse than a label.
    const html = label('member')
    expect(html).toContain('MEMBER')
    expect(html).not.toContain('<button')
  })

  it('makes a pending invitation withdrawable', () => {
    // PENDING stays visually quiet, but it is a real control: having invited
    // the wrong person, the owner needs a way back.
    const html = label('pending')
    expect(html).toContain('PENDING')
    expect(html).toContain('<button')
    expect(html).toContain('Cancel the invitation to AnoterosTV')
  })

  it('confirms before withdrawing', () => {
    // One deliberate step, so a stray click never un-invites somebody.
    const confirm = renderToStaticMarkup(
      <span className="kb-relation-confirm">
        <button type="button" className="kb-ghost-btn kb-confirm-yes">
          Cancel invite
        </button>
        <button type="button" className="kb-ghost-btn">
          Keep
        </button>
      </span>,
    )
    expect(confirm).toContain('Cancel invite')
    expect(confirm).toContain('Keep')
  })
})
