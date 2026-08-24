/**
 * Mounts a live GroupChat in a page, for the interaction half of the gate.
 *
 * The sender name is no longer a `<button>` - it is a span with role="button",
 * because a button cannot be an inline box and that is what broke wrapping the
 * second time. That trade is only acceptable if the name is still genuinely a
 * control, so this exists to click it for real, in a real browser, with the
 * real React handlers attached.
 */
import { createRoot } from 'react-dom/client'
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

/** Renders one message into `container` and resolves once React has painted. */
function mount(container: HTMLElement, displayName: string, body: string): Promise<void> {
  const message: ChatMessage = {
    id: 'm1',
    groupId: 'g1',
    userId: 'them',
    displayName,
    avatarUrl: null,
    body,
    createdAt: new Date(NOW).toISOString(),
  }

  createRoot(container).render(
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

  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

/*
 * Published on `window` by hand.
 *
 * The bundler drops a module export that nothing in the bundle imports, so
 * relying on the IIFE's name left the gate with an undefined global.
 */
;(window as unknown as { KickbackChat: unknown }).KickbackChat = { mount }
