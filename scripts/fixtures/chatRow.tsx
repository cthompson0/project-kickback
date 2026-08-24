/**
 * Renders real chat rows, for the browser layout gate.
 *
 * The point of this file is that `npm run test:wrap` measures the markup the
 * product actually produces. An earlier version of the gate hand-wrote a
 * `<span class="kb-msg-who">` fixture, which would have kept passing if
 * GroupChat had gone back to a `<button>` - the fixture, not the component,
 * would have been under test. Both wrapping regressions reached a user
 * precisely because something agreed with the bug, so the gate renders the
 * component.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { GroupChat } from '../../src/ui/components/GroupChat'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import type { ChatMessage, KickbackClient } from '../../src/client/types'

const NOW = 1_700_000_000_000

const client = {
  sendFriendRequest: async () => 'req',
  removeFriend: async () => {},
  searchEmotes: async () => [],
  sendGroupMessage: async () => {},
} as unknown as KickbackClient

export interface RowCase {
  label: string
  name: string
  body: string
}

/** One rendered `.kb-msg` per case, in the same order. */
export function renderRows(cases: RowCase[]): string[] {
  return cases.map((testCase, index) => {
    const message: ChatMessage = {
      id: `m${index}`,
      groupId: 'g1',
      userId: 'u1',
      displayName: testCase.name,
      avatarUrl: null,
      body: testCase.body,
      createdAt: new Date(NOW).toISOString(),
    }

    return renderToStaticMarkup(
      <ChannelNameProvider people={[]} seen={{}}>
        <GroupChat
          groupId="g1"
          messages={[message]}
          selfId="me"
          client={client}
          members={[]}
          cardContext={{
            selfId: 'me',
            viewerActivity: { type: 'idle' },
            friendIds: new Set<string>(),
            outgoingRequestIds: new Set<string>(),
          }}
        />
      </ChannelNameProvider>,
    )
  })
}
