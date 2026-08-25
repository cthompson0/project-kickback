import { useEffect, useMemo, useRef, useState } from 'react'
import { COMBO_MIN_DISPLAY, scanCombos } from '../../core/combos'
import { emoteKey } from '../../core/emotes'
import { comboStream, liveMessages, MAX_MESSAGE_LENGTH, roomActivity } from '../../core/roomMessages'
import type { RoomMessage } from '../../core/roomMessages'
import type { TogetherReaction } from '../../core/together'
import { withoutMutedSenders } from '../../core/mute'
import { directCount, sortMembers } from '../../core/streamRoom'
import type { RoomMember } from '../../core/streamRoom'
import { formatViewers } from '../../core/twitchMetadata'
import type { ChannelMetadata } from '../../core/twitchMetadata'
import type { Friend, KickbackClient } from '../../client/types'
import { useChannelName } from '../ChannelNames'
import { useAnalytics } from '../Analytics'
import { Avatar } from './Avatar'
import { EmoteImage } from './EmoteImage'
import { ActiveComboBar, Composer, MessageList } from './Conversation'
import { UserCard } from './UserCard'
import type { UserCardContext } from './UserCard'

/**
 * The contextual stream session: what the people watching this are saying.
 *
 * WHAT CHANGED, AND WHY
 *
 * The first version of this room replaced the Friends map with a roster and
 * five buttons. Two things were wrong with that. It cost the social radar -
 * you gave up "where is everyone" to look at four names - and it had nothing
 * to do, because what makes a room a place is that something is being said in
 * it. Reactions are punctuation for a conversation that was never there.
 *
 * So this is a TAB now, beside Friends and Groups rather than on top of them,
 * and the conversation is the reason it exists. The destination context and
 * the participants are deliberately compact: they answer questions you ask
 * once, and the log answers the one you keep asking.
 *
 * WHAT IT IS STILL NOT
 *
 * No name, no owner, no membership to manage, no join or leave, no transcript.
 * Membership is the connected component the server computed from presence, and
 * a message is addressed to whoever was in it when the message was written -
 * which is why a room that splits stops delivering and a room that merges
 * never backfills. See core/roomMessages.ts and migration 0021.
 */

interface StreamSessionProps {
  /** Canonical lowercase login. */
  channel: string
  members: readonly RoomMember[]
  friends: readonly Friend[]
  reactions: readonly TogetherReaction[]
  messages: readonly RoomMessage[]
  mutedUserIds: readonly string[]
  metadata?: ChannelMetadata
  selfId: string | null
  client: KickbackClient
  cardContext: UserCardContext
}

export function StreamSession({
  channel,
  members,
  friends,
  reactions,
  messages,
  mutedUserIds,
  metadata,
  selfId,
  client,
  cardContext,
}: StreamSessionProps) {
  const channelName = useChannelName()
  const analytics = useAnalytics()
  const [rosterOpen, setRosterOpen] = useState(false)
  const [openCardId, setOpenCardId] = useState<string | null>(null)

  /*
   * Activity ages out on its own, so this needs a heartbeat: nothing else
   * re-renders between presence updates, and a combo that stayed until the
   * next one would sit there claiming to be now.
   *
   * It ticks while there is EITHER a reaction or a message, and that second
   * half was missing. Once an emote sent from the picker became a message
   * rather than a reaction, a room with a live combo and no reactions in it
   * had nothing driving the clock - so the preview formed correctly and then
   * never went away. Only while there is something to age; an idle surface
   * ticks nothing.
   */
  const [, setTick] = useState(0)
  const pulses = reactions.length + messages.length
  useEffect(() => {
    if (pulses === 0) return
    const id = window.setInterval(() => setTick((value) => value + 1), 1_000)
    return () => window.clearInterval(id)
  }, [pulses])

  const byId = useMemo(() => new Map(friends.map((friend) => [friend.user.id, friend])), [friends])
  const nameOf = (userId: string) =>
    userId === selfId ? 'You' : (byId.get(userId)?.user.displayName ?? 'Someone')

  /*
   * Muted people are filtered BEFORE the combo engine, not after.
   *
   * That is what makes their contribution disappear from the count rather than
   * merely from the list - a muted person inflating a ×6 in your panel is
   * still them getting your attention. It also means two viewers can see
   * different counts for the same moment, which is unavoidable for a mute the
   * server never learns about, and much better than one that half works.
   */
  const heard = useMemo(
    () => withoutMutedSenders(liveMessages(messages, channel), mutedUserIds),
    [messages, channel, mutedUserIds],
  )
  const heardReactions = useMemo(
    () => withoutMutedSenders(reactions, mutedUserIds),
    [reactions, mutedUserIds],
  )

  /*
   * ONE combo stream, over reactions and messages together.
   *
   * A reaction is an emote; an emote-only message is the same emote sent the
   * slow way; ordinary text does not contribute but does close a run. All
   * three are rules `scanCombos` already had - the third has simply never had
   * anything to fire on in a room before, because a room had no text in it.
   */
  const { annotations } = useMemo(
    () => scanCombos(comboStream(heardReactions, heard, nameOf)),
    // nameOf is derived from friends/selfId, both of which are in byId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [heardReactions, heard, byId, selfId],
  )

  /*
   * What is happening RIGHT NOW, which is a much shorter question.
   *
   * The log shows half an hour; this shows eight seconds, and it is the same
   * derivation the Gravity card outside draws its preview from - so glancing
   * at the card and then opening the tab continues what you saw rather than
   * offering a second opinion.
   */
  const activity = roomActivity(heardReactions, heard, channel, nameOf)

  /*
   * The bar above the composer is the ACTIVITY window, not the trailing run of
   * the whole log.
   *
   * Those are different questions once a room keeps half an hour of
   * conversation: the log's trailing run happily reaches back through
   * everything said since the session began, so the session showed a combo of
   * four while the card outside - which has always used the eight-second
   * window - showed two. Same engine, different clocks, and the two surfaces
   * are supposed to agree about what is happening right now.
   *
   * The per-message badges still come from the full log, because a count
   * beside an old message is history and is correct there.
   */
  const active = activity && activity.count >= COMBO_MIN_DISPLAY ? activity : null

  /* Combos and breaks are recorded once each, the way group chat records them. */
  const activeKey = active ? emoteKey(active.emote) : null
  const activeCount = active?.count ?? 0
  const reportedComboRef = useRef<string | null>(null)
  const participants = members.length + 1

  useEffect(() => {
    if (!activeKey) {
      reportedComboRef.current = null
      return
    }
    if (reportedComboRef.current === activeKey) return
    reportedComboRef.current = activeKey
    analytics.track(
      'automatic_room_combo',
      { combo_size: activeCount, participant_count: participants },
      { source: 'together', channel },
    )
  }, [activeKey, activeCount, analytics, participants, channel])

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
      analytics.track('combo_broken', { count: annotation.brokeCombo.count }, { source: 'together' })
    }
  }, [annotations, analytics])

  const ordered = sortMembers(members)
  const display = heard.map((message) => ({
    id: message.id,
    userId: message.senderId,
    displayName: nameOf(message.senderId),
    avatarUrl: byId.get(message.senderId)?.user.avatarUrl ?? null,
    body: message.body,
  }))

  return (
    <div className="kb-session">
      {/*
       * Destination context: one line of identity, one of stream, one of who.
       *
       * Compact on purpose. This used to be a card taller than the thing it
       * described; the conversation is what people came for.
       */}
      <div className="kb-session-head">
        <div className="kb-session-channel kb-channel">{channelName(channel)}</div>
        <div className="kb-session-sub">
          {metadata?.live === 'live' && (
            <span className="kb-live" title="Streaming now">
              <span className="kb-live-dot" aria-hidden="true" />
              LIVE
            </span>
          )}
          {metadata?.live === 'live' && metadata.gameName && (
            <span className="kb-session-game" title={metadata.gameName}>
              {metadata.gameName}
            </span>
          )}
          {metadata?.live === 'live' && metadata.viewerCount !== null && (
            <span className="kb-session-viewers">{formatViewers(metadata.viewerCount)}</span>
          )}
        </div>
      </div>

      {/*
       * The people, as faces rather than a list.
       *
       * A room can hold somebody two hops away who needs a line of context
       * under their name - so the full treatment exists, behind a tap. Closed,
       * it is one row; open, it is what the old room was.
       */}
      <button
        type="button"
        className="kb-session-people"
        aria-expanded={rosterOpen}
        title={rosterOpen ? 'Hide who is here' : 'Show who is here'}
        onClick={() => setRosterOpen((open) => !open)}
      >
        <span className="kb-avatar-stack">
          {ordered.slice(0, 4).map((member) => {
            const friend = byId.get(member.userId)
            return friend ? (
              <Avatar key={member.userId} user={friend.user} size={18} showDot={false} />
            ) : (
              <span key={member.userId} className="kb-room-unknown" aria-hidden="true">
                ?
              </span>
            )
          })}
        </span>
        <span className="kb-session-count">WATCHING TOGETHER · {participants}</span>
        <span className="kb-session-chevron" aria-hidden="true">
          {rosterOpen ? '⌃' : '⌄'}
        </span>
      </button>

      {rosterOpen && (
        <div className="kb-room-people">
          <div className="kb-room-person kb-room-self">
            <span className="kb-cluster-name">You</span>
          </div>

          {ordered.map((member) => {
            const friend = byId.get(member.userId)
            const via = member.viaUserId ? byId.get(member.viaUserId) : undefined

            return (
              <div className="kb-room-person" key={member.userId}>
                <button
                  type="button"
                  className="kb-person-btn"
                  title={`About ${nameOf(member.userId)}`}
                  onClick={() =>
                    setOpenCardId((current) => (current === member.userId ? null : member.userId))
                  }
                >
                  {friend ? (
                    <Avatar user={friend.user} size={22} showDot={false} />
                  ) : (
                    <span className="kb-room-unknown" aria-hidden="true">
                      ?
                    </span>
                  )}
                  <span className="kb-cluster-name">{nameOf(member.userId)}</span>
                </button>

                {/*
                 * One hop of context. "Friend of Jake" turns a name you do not
                 * recognise into somebody who arrived through a person you
                 * trust; beyond that the server does not tell us, deliberately.
                 */}
                {member.hops === 2 && via && (
                  <span className="kb-room-via">Friend of {via.user.displayName}</span>
                )}

                {friend && openCardId === member.userId && (
                  <UserCard
                    user={friend.user}
                    presence={friend.presence}
                    client={client}
                    context={cardContext}
                    onClose={() => setOpenCardId(null)}
                  />
                )}
              </div>
            )
          })}

          {directCount(members) < ordered.length && (
            <div className="kb-room-note">Some people here arrived through a friend.</div>
          )}
        </div>
      )}

      {/* The reason the surface exists. */}
      <MessageList
        messages={display}
        annotations={annotations}
        selfId={selfId}
        client={client}
        cardContext={cardContext}
        lookup={(userId) => {
          const friend = byId.get(userId)
          return friend ? { user: friend.user, presence: friend.presence } : undefined
        }}
        empty="Nobody has said anything yet."
      />

      {active && <ActiveComboBar combo={active} />}

      {/*
       * What just landed, when there is no combo bar already saying it.
       *
       * THE FIVE-BUTTON ROW USED TO BE HERE, and it is gone. There were two
       * emoji surfaces stacked above the input - a permanent strip of quick
       * reactions and the emote picker attached to the composer - and the
       * strip was the weaker one: it offered five emotes where the picker
       * offers every emote the channel has, and it took a row of height
       * from the conversation to do it.
       *
       * Sending an emote is now one thing, done one way: the picker. An
       * emote-only message is counted by exactly the same engine a reaction
       * was, so nothing about combos changed.
       *
       * FUTURE, NOT NOW: when a combo is already running, surfacing THAT
       * emote as a single one-click way to join it would be a quick action
       * with a reason to exist - unlike a permanent strip, it would appear
       * only when there is something to join.
       */}
      {!active && activity && (
        <div className="kb-session-activity" aria-live="polite">
          <span className="kb-session-pulse" key={`${activity.emote.id}:${activity.count}`}>
            <EmoteImage emote={activity.emote} size={18} />
          </span>
        </div>
      )}
      <Composer
        client={client}
        maxLength={MAX_MESSAGE_LENGTH}
        placeholder="Message"
        onSend={async (body) => client.sendRoomMessage(body)}
      />
    </div>
  )
}
