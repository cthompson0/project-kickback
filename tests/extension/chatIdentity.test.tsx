import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { GroupChat } from '../../src/ui/components/GroupChat'
import { MessageList } from '../../src/ui/components/Conversation'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import { avatarTint } from '../../src/ui/avatarTint'
import type { ComboAnnotation } from '../../src/core/combos'
import type { ChatMessage, KickbackClient } from '../../src/client/types'

/**
 * Who a message is from, and what colour their name is.
 *
 * BOTH OF THESE USED TO BE THE CALLER'S JOB, AND BOTH WENT WRONG
 *
 * StreamSession substituted "You" for the viewer when it built its display
 * list; GroupChat passed the server's display name straight through. So the
 * same person read as "You" in a Stream Room and as their Twitch name in a
 * group, in the same panel, minutes apart. Every non-self name was also the
 * same accent colour, which makes a three-way conversation genuinely hard to
 * scan. See docs/reports/friends-beta-investigation-2026-08-27.md §4.
 *
 * MessageList owns both now, because both are facts about a message list
 * rather than facts about a group or a room. These tests assert the shared
 * component directly AND through GroupChat, so a caller cannot reintroduce its
 * own substitution without failing.
 */

const SELF = 'me-uuid'
const THEM = 'them-uuid'
const NO_ANNOTATIONS = new Map<string, ComboAnnotation>()

function stubClient(): KickbackClient {
  return {
    sendFriendRequest: async () => 'req',
    removeFriend: async () => {},
    searchEmotes: async () => [],
    sendGroupMessage: async () => {},
  } as unknown as KickbackClient
}

const CONTEXT = { localActivity: { type: 'idle' as const }, mutedUserIds: [] as string[] }

function renderList(messages: Array<{ id: string; userId: string; displayName: string }>) {
  return renderToStaticMarkup(
    <ChannelNameProvider people={[]} seen={{}}>
      <MessageList
        messages={messages.map((message) => ({
          ...message,
          avatarUrl: null,
          body: 'hello',
        }))}
        annotations={NO_ANNOTATIONS}
        selfId={SELF}
        client={stubClient()}
        cardContext={CONTEXT as never}
        empty="nothing yet"
      />
    </ChannelNameProvider>,
  )
}

function groupMessage(userId: string, displayName: string, id: string): ChatMessage {
  return {
    id,
    groupId: 'g1',
    userId,
    displayName,
    avatarUrl: null,
    body: 'hello',
    createdAt: new Date(1_700_000_000_000).toISOString(),
  }
}

describe('the local user is called "You" everywhere', () => {
  it('renders the viewer as You in the shared list', () => {
    const html = renderList([{ id: 'm1', userId: SELF, displayName: 'AnoterosTV' }])
    expect(html).toContain('You')
    expect(html).not.toContain('AnoterosTV')
  })

  it('renders everybody else by name', () => {
    const html = renderList([{ id: 'm1', userId: THEM, displayName: 'ohjuliego' }])
    expect(html).toContain('ohjuliego')
    expect(html).not.toContain('>You<')
  })

  /** The surface that used to disagree. */
  it('renders the viewer as You in group chat', () => {
    const html = renderToStaticMarkup(
      <ChannelNameProvider people={[]} seen={{}}>
        <GroupChat
          groupId="g1"
          messages={[groupMessage(SELF, 'AnoterosTV', 'm1')]}
          selfId={SELF}
          client={stubClient()}
          cardContext={CONTEXT as never}
        />
      </ChannelNameProvider>,
    )
    expect(html).toContain('You')
    expect(html).not.toContain('AnoterosTV')
  })

  it('still marks the viewer with the self class, so colour is not the only cue', () => {
    const html = renderList([{ id: 'm1', userId: SELF, displayName: 'AnoterosTV' }])
    expect(html).toContain('kb-msg-who-self')
  })
})

describe('sender colours are deterministic and shared', () => {
  it('gives a sender the tint their own id produces', () => {
    const html = renderList([{ id: 'm1', userId: THEM, displayName: 'ohjuliego' }])
    expect(html).toContain(`color:${avatarTint(THEM)}`)
  })

  it('gives the same person the same colour every time', () => {
    const first = renderList([{ id: 'm1', userId: THEM, displayName: 'ohjuliego' }])
    const second = renderList([{ id: 'm2', userId: THEM, displayName: 'ohjuliego' }])
    const tint = avatarTint(THEM)
    expect(first).toContain(`color:${tint}`)
    expect(second).toContain(`color:${tint}`)
  })

  it('gives different people different colours', () => {
    /*
     * Not a claim that any two ids differ - an eight-colour palette collides,
     * by design and unavoidably. It asserts that the palette is actually being
     * spread, which is the property that failed: every name was one colour.
     */
    const ids = Array.from({ length: 40 }, (_, index) => `user-${index}`)
    const distinct = new Set(ids.map((id) => avatarTint(id)))
    expect(distinct.size).toBeGreaterThan(4)
  })

  it('does not tint the viewer, who keeps the self colour from the stylesheet', () => {
    const html = renderList([{ id: 'm1', userId: SELF, displayName: 'AnoterosTV' }])
    expect(html).not.toContain(`color:${avatarTint(SELF)}`)
  })

  it('agrees between a group and a room for the same person', () => {
    const room = renderList([{ id: 'm1', userId: THEM, displayName: 'ohjuliego' }])
    const group = renderToStaticMarkup(
      <ChannelNameProvider people={[]} seen={{}}>
        <GroupChat
          groupId="g1"
          messages={[groupMessage(THEM, 'ohjuliego', 'm1')]}
          selfId={SELF}
          client={stubClient()}
          cardContext={CONTEXT as never}
        />
      </ChannelNameProvider>,
    )
    const tint = avatarTint(THEM)
    expect(room).toContain(`color:${tint}`)
    expect(group).toContain(`color:${tint}`)
  })
})
