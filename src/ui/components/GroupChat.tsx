import { useEffect, useMemo, useRef } from 'react'
import { scanCombos } from '../../core/combos'
import { emoteKey } from '../../core/emotes'
import { useAnalytics } from '../Analytics'
import type { ChatMessage, KickbackClient } from '../../client/types'
import { ActiveComboBar, Composer, MessageList } from './Conversation'
import type { UserCardContext } from './UserCard'
import type { GroupMember } from '../../client/types'

/**
 * Group chat.
 *
 * The rendering, the composer and the combo badges live in Conversation.tsx
 * now, shared with the contextual stream session. What stays here is
 * everything that makes this a GROUP: a group id, a persistent roster, and
 * messages that are still there tomorrow.
 *
 * That split is deliberate rather than tidy. The two surfaces share how a
 * conversation LOOKS and nothing about what one IS, so the day either needs
 * different persistence it cannot reach the other.
 */

const MAX_LENGTH = 500

/** Stable identity, so an omitted roster does not invalidate memos each render. */
const NO_MEMBERS: GroupMember[] = []

export function GroupChat({
  groupId,
  messages,
  selfId,
  client,
  members = NO_MEMBERS,
  cardContext,
}: {
  groupId: string
  messages: ChatMessage[]
  selfId: string | null
  client: KickbackClient
  /** The roster, so a sender's card shows the same presence as everywhere. */
  members?: GroupMember[]
  /**
   * The same context every other card gets.
   *
   * Required: this call site is exactly the one that used to omit the viewer's
   * activity, so a card opened from chat offered a JOIN to the stream the
   * viewer was already watching.
   */
  cardContext: UserCardContext
}) {
  const analytics = useAnalytics()

  // The sender's card must show the same presence the cluster and the member
  // list show, so it reads the same roster rather than anything chat-local.
  const byUserId = useMemo(
    () => new Map(members.map((member) => [member.user.id, member])),
    [members],
  )

  const { annotations, active } = useMemo(
    () =>
      scanCombos(
        messages.map((message) => ({
          id: message.id,
          userId: message.userId,
          displayName: message.displayName,
          body: message.body,
        })),
      ),
    [messages],
  )

  /*
   * Combos, recorded once each.
   *
   * Combos are DERIVED from the message list on every render, which is what
   * makes every client agree about them - and what makes them easy to
   * over-report. The counter growing from two to five is one combo, not four,
   * and opening a group with an hour of history in it is not a combo forming
   * now. So both of these are transitions, not states.
   *
   * The emote alone identifies the run: a combo of a different emote is a
   * different combo, and the same emote combo'd twice is separated by the null
   * in between, which resets the marker.
   */
  const activeKey = active ? emoteKey(active.emote) : null
  const activeCount = active?.count ?? 0
  const reportedComboRef = useRef<string | null>(null)

  useEffect(() => {
    if (!activeKey) {
      reportedComboRef.current = null
      return
    }
    if (reportedComboRef.current === activeKey) return
    reportedComboRef.current = activeKey
    analytics.track('combo_formed', { count: activeCount }, { source: 'group' })
  }, [activeKey, activeCount, analytics])

  /**
   * Breaks already on screen when this opened are history, not news.
   *
   * Seeded on the first pass without emitting, so scrolling back through an
   * old conversation does not replay a month of combos as if they were
   * happening now.
   */
  const seenBreaksRef = useRef<Set<string> | null>(null)

  useEffect(() => {
    const first = seenBreaksRef.current === null
    const seen = seenBreaksRef.current ?? new Set<string>()
    seenBreaksRef.current = seen

    for (const [messageId, annotation] of annotations) {
      if (!annotation.brokeCombo) continue
      if (seen.has(messageId)) continue
      seen.add(messageId)
      if (first) continue
      analytics.track('combo_broken', { count: annotation.brokeCombo.count }, { source: 'group' })
    }
  }, [annotations, analytics])

  return (
    <div className="kb-chat">
      <MessageList
        messages={messages}
        annotations={annotations}
        selfId={selfId}
        client={client}
        cardContext={cardContext}
        lookup={(userId) => byUserId.get(userId)}
        empty="No messages yet. Say something."
      />

      {active && <ActiveComboBar combo={active} />}

      <Composer
        client={client}
        maxLength={MAX_LENGTH}
        placeholder="Message"
        onSend={(body) => client.sendGroupMessage(groupId, body)}
      />
    </div>
  )
}
