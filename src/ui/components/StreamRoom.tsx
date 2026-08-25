import { useEffect, useState } from 'react'
import { REACTIONS, reactionEmote, roomActivity } from '../../core/together'
import type { TogetherReaction } from '../../core/together'
import { COMBO_MIN_DISPLAY } from '../../core/combos'
import { directCount, sortMembers } from '../../core/streamRoom'
import type { RoomMember } from '../../core/streamRoom'
import type { ChannelMetadata } from '../../core/twitchMetadata'
import { formatViewers } from '../../core/twitchMetadata'
import type { Friend, KickbackClient } from '../../client/types'
import { useChannelName } from '../ChannelNames'
import { useAnalytics } from '../Analytics'
import { Avatar } from './Avatar'
import { EmoteImage } from './EmoteImage'
import { UserCard } from './UserCard'
import type { UserCardContext } from './UserCard'
import { BackIcon } from './Icons'

/**
 * The automatic Stream Room: an actual place, not an expanded card.
 *
 * WHAT CHANGED, AND WHY
 *
 * The first version put a ROOM button on the Gravity card that revealed a
 * short list underneath it. Everything worked and nothing felt like anywhere:
 * the room was a disclosure triangle. Clicking the last step of
 * Presence → Gravity → JOIN → Together has to feel like arriving somewhere,
 * so this is a view, reached the way the panel already reaches a group
 * conversation - it takes over the panel body and Back returns.
 *
 * WHERE THE INTERACTION LIVES
 *
 * Here, and only here. The Gravity card outside used to carry five permanent
 * reaction buttons, which made the social map into a composer; it now carries
 * only what is happening, and the doorway. You come in to take part.
 *
 * WHAT IT IS STILL NOT
 *
 * No name, no owner, no membership to manage, no join or leave, no text, no
 * history. Membership is the connected component the server computed, and it
 * changes because presence changed - which is why there is nothing here that
 * creates or destroys anything.
 */

interface StreamRoomProps {
  /** Canonical lowercase login. */
  channel: string
  members: readonly RoomMember[]
  friends: readonly Friend[]
  reactions: readonly TogetherReaction[]
  metadata?: ChannelMetadata
  selfId: string | null
  client: KickbackClient
  cardContext: UserCardContext
  onBack: () => void
}

export function StreamRoom({
  channel,
  members,
  friends,
  reactions,
  metadata,
  selfId,
  client,
  cardContext,
  onBack,
}: StreamRoomProps) {
  const channelName = useChannelName()
  const analytics = useAnalytics()
  const [openCardId, setOpenCardId] = useState<string | null>(null)

  /*
   * Reactions age out on their own, so the room needs a heartbeat of its own:
   * nothing else re-renders between presence updates. Only while there is
   * something to age.
   */
  const [, setTick] = useState(0)
  useEffect(() => {
    if (reactions.length === 0) return
    const id = window.setInterval(() => setTick((value) => value + 1), 1_000)
    return () => window.clearInterval(id)
  }, [reactions.length])

  const byId = new Map(friends.map((friend) => [friend.user.id, friend]))
  const nameOf = (userId: string) =>
    userId === selfId ? 'You' : (byId.get(userId)?.user.displayName ?? 'Someone')

  /*
   * What is happening, from the one function that decides.
   *
   * The card outside this room calls exactly the same thing, so opening the
   * room continues what the preview was showing rather than offering a second
   * opinion about the same eight seconds.
   */
  const activity = roomActivity(reactions, channel, nameOf)

  const ordered = sortMembers(members)
  const participants = ordered.length + 1

  return (
    <>
      <div className="kb-detail-head">
        <button type="button" className="kb-back" onClick={onBack} title="Back to friends">
          <BackIcon />
        </button>

        <div className="kb-room-title">
          <div className="kb-room-channel kb-channel">{channelName(channel)}</div>
          {/*
           * Metadata is enrichment here as everywhere: a room works with none
           * of it, and says less rather than looking broken.
           */}
          {metadata?.live === 'live' && (
            <div className="kb-room-sub">
              {metadata.gameName && <span>{metadata.gameName}</span>}
              <span className="kb-live">
                <span className="kb-live-dot" aria-hidden="true" />
                LIVE
              </span>
              {metadata.viewerCount !== null && (
                <span className="kb-room-viewers">{formatViewers(metadata.viewerCount)}</span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="kb-room-count">
        WATCHING TOGETHER · {participants}
      </div>

      <div className="kb-room-people">
        {/*
         * The viewer first, because a room you are in should say so before it
         * says anything else.
         */}
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
      </div>

      {/*
       * What is happening, and how to take part.
       *
       * The live line sits above the buttons rather than beside them: in here
       * there is room for it, and a reaction landing should be the thing you
       * notice. Empty when nothing is going on - no placeholder, no "no
       * reactions yet".
       */}
      <div className="kb-room-activity" aria-live="polite">
        {activity && (
          <span className="kb-room-combo" key={`${activity.emote.id}:${activity.count}`}>
            <EmoteImage emote={activity.emote} size={22} />
            {activity.count >= COMBO_MIN_DISPLAY && (
              <span className="kb-together-count">×{activity.count}</span>
            )}
          </span>
        )}
      </div>

      <div className="kb-room-react" role="group" aria-label="React">
        {REACTIONS.map((reaction) => (
          <button
            key={reaction}
            type="button"
            className="kb-room-react-btn"
            title={`React ${reactionEmote(reaction).label}`}
            onClick={() => {
              client.sendReaction(reaction)
              analytics.track(
                'automatic_room_reaction',
                { participant_count: participants, direction: 'sent' },
                { source: 'together', channel },
              )
            }}
          >
            <EmoteImage emote={reactionEmote(reaction)} size={24} />
          </button>
        ))}
      </div>

      <div className="kb-room-note">
        {directCount(members) === ordered.length
          ? 'Everyone here is a friend of yours.'
          : 'Some people here arrived through a friend.'}
      </div>
    </>
  )
}
