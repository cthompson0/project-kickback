import { useMemo, useState } from 'react'
import { socialGravity, isGravity } from '../../core/socialGravity'
import type { GravitySection } from '../../core/socialGravity'
import type { Activity } from '../../core/types'
import type { Friend, KickbackClient } from '../../client/types'
import { useChannelName } from '../ChannelNames'
import { Avatar } from './Avatar'
import { JoinButton } from './JoinButton'
import { PersonRow } from './PersonRow'
import { UserCard } from './UserCard'
import type { UserCardContext } from './UserCard'

/**
 * The live social map.
 *
 * A flat friends list makes you read four rows and notice that three of them
 * say the same channel. This does that reading for you: the destination is the
 * thing on screen and the people are its weight, so "everyone is on xQc" is
 * something you see rather than something you work out.
 *
 * WHAT GETS WHICH TREATMENT
 *
 * Destinations are cards. Two or more friends earns the flame and the heavier
 * card - that is the gravity - while one friend gets the same card without it,
 * because one friend on a stream is still real discovery and hiding it until a
 * second person arrives would waste the signal.
 *
 * The channel the viewer is already on is a card too, but a different one: no
 * JOIN, because there is nowhere to go, and the copy says who they are with
 * rather than where they could be.
 *
 * WHY AROUND AND OFFLINE ARE STILL PLAIN ROWS
 *
 * Those people are not a destination, and dressing them up as one would be
 * noise. They keep PersonRow, so they keep exactly what the flat list gave
 * them: the status line, the identity that opens a card, and the inline remove
 * for friends Kickback has no presence for.
 *
 * Removing anyone who IS online has always happened from their user card
 * rather than from a row, and that is unchanged - the identity inside a
 * destination card opens the same card as everywhere else. Making the map the
 * default view costs nobody their friend management.
 */

interface SocialGravityProps {
  friends: Friend[]
  localActivity: Activity
  onRemove?: (userId: string) => void
  client: KickbackClient
  cardContext: UserCardContext
}

/**
 * A friend inside a destination card.
 *
 * Compact on purpose: the card's subject is the destination, and a full status
 * row per person would repeat "watching xQc" once for every face. The identity
 * stays live - clicking it opens the same card it opens everywhere else.
 */
function GravityPerson({
  friend,
  open,
  onToggle,
  client,
  cardContext,
}: {
  friend: Friend
  open: boolean
  onToggle: () => void
  client: KickbackClient
  cardContext: UserCardContext
}) {
  return (
    <div className="kb-gravity-person">
      <button
        type="button"
        className="kb-person-btn"
        title={`About ${friend.user.displayName}`}
        onClick={onToggle}
      >
        <Avatar user={friend.user} size={20} showDot={false} />
        <span className="kb-cluster-name">{friend.user.displayName}</span>
      </button>

      {open && (
        <UserCard
          user={friend.user}
          presence={friend.presence}
          client={client}
          context={cardContext}
          onClose={onToggle}
        />
      )}
    </div>
  )
}

function DestinationCard({
  section,
  client,
  cardContext,
  openCardId,
  onToggleCard,
}: {
  section: GravitySection<Friend>
  client: KickbackClient
  cardContext: UserCardContext
  openCardId: string | null
  onToggleCard: (userId: string) => void
}) {
  const channelName = useChannelName()
  const here = section.kind === 'here'
  const heavy = isGravity(section)

  const className = [
    'kb-gravity-card',
    here ? 'kb-gravity-card-here' : '',
    heavy ? 'kb-gravity-card-strong' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={className}>
      <div className="kb-gravity-head">
        {/*
         * The flame marks a gathering, not a stream. It appears at two friends
         * and does not grow with the count - the number beside it already says
         * how big it is, and stacking flames would be scoreboard, not signal.
         */}
        {heavy && (
          <span className="kb-gravity-flame" aria-hidden="true">
            🔥
          </span>
        )}

        <span className="kb-gravity-channel kb-channel">
          {channelName(section.channel ?? '')}
        </span>

        <span
          className="kb-gravity-count"
          title={section.count === 1 ? '1 friend' : `${section.count} friends`}
        >
          {section.count}
        </span>

        {/*
         * A spacer rather than a margin, so a future action - Stream Rooms
         * will want a CHAT here - drops in beside JOIN without the header
         * being rebuilt. Nothing occupies it today; there is no dead button.
         */}
        <span className="kb-header-spacer" />

        {here ? (
          <span className="kb-badge-here">HERE</span>
        ) : (
          section.channel && (
            <JoinButton
              channel={section.channel}
              source="social_gravity"
              socialCount={section.count}
            />
          )
        )}
      </div>

      {here && (
        <div className="kb-gravity-with-you">
          {section.count === 1 ? '1 friend watching with you' : `${section.count} friends watching with you`}
        </div>
      )}

      <div className="kb-gravity-people">
        {section.friends.map((friend) => (
          <GravityPerson
            key={friend.user.id}
            friend={friend}
            open={openCardId === friend.user.id}
            onToggle={() => onToggleCard(friend.user.id)}
            client={client}
            cardContext={cardContext}
          />
        ))}
      </div>
    </div>
  )
}

export function SocialGravity({
  friends,
  localActivity,
  onRemove,
  client,
  cardContext,
}: SocialGravityProps) {
  const [openCardId, setOpenCardId] = useState<string | null>(null)

  const sections = useMemo(
    () =>
      socialGravity(
        friends.map((friend) => ({
          member: friend,
          presence: friend.presence,
          userId: friend.user.id,
        })),
        localActivity,
        // Left to the selector's own default: reading the clock during render
        // is impure, and it is only used to age presence out.
        undefined,
        // "Where is everyone else" - the viewer is never one of them.
        cardContext.selfId,
      ),
    [friends, localActivity, cardContext.selfId],
  )

  if (friends.length === 0) {
    return <div className="kb-empty">No friends yet.</div>
  }

  return (
    <div className="kb-gravity">
      {sections.map((section) => {
        const key = `${section.kind}:${section.channel ?? ''}`

        if (section.kind === 'here' || section.kind === 'destination') {
          return (
            <DestinationCard
              key={key}
              section={section}
              client={client}
              cardContext={cardContext}
              openCardId={openCardId}
              onToggleCard={(userId) =>
                setOpenCardId((open) => (open === userId ? null : userId))
              }
            />
          )
        }

        return (
          <div className="kb-gravity-quiet" key={key}>
            <div className="kb-section-label">
              {section.kind === 'around' ? 'Around on Twitch' : 'Offline'} · {section.count}
            </div>
            {section.friends.map((friend) => (
              <PersonRow
                key={friend.user.id}
                person={friend}
                localActivity={localActivity}
                onRemove={onRemove}
                client={client}
                cardContext={cardContext}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}
