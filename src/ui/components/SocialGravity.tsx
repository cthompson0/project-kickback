import { useMemo, useState } from 'react'
import { socialGravity, isGravity } from '../../core/socialGravity'
import type { GravitySection } from '../../core/socialGravity'
import { formatViewers } from '../../core/twitchMetadata'
import type { ChannelMetadata } from '../../core/twitchMetadata'
import type { Activity } from '../../core/types'
import type { Friend, KickbackClient } from '../../client/types'
import { useChannelName } from '../ChannelNames'
import { Avatar } from './Avatar'
import { avatarTint } from '../avatarTint'
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
  /** login -> public Twitch metadata. Absent is normal and always safe. */
  metadata?: Readonly<Record<string, ChannelMetadata>>
}

/**
 * The destination's avatar, ALWAYS present.
 *
 * WHY IT IS NEVER ABSENT
 *
 * It used to render only when Twitch had given us a picture, which meant the
 * card had two different geometries: with metadata the name started 28px in,
 * without it the name was flush left. That made the plain card look like a
 * broken version of the rich one rather than a card in its own right, and it
 * made metadata ARRIVING shove the whole header sideways.
 *
 * So the slot is always there. With a Twitch image it holds the image; without
 * one it holds a tinted monogram - the same treatment every avatar in Kickback
 * uses when there is no picture, so it reads as "no picture yet", not as an
 * error, and it is visibly generated rather than pretending to be Twitch's.
 *
 * THIS IS THE CHANNEL, NOT A FRIEND
 *
 * The seed is the channel login, so the tint belongs to the destination. A
 * friend's avatar is never promoted here: they are different identities and
 * showing one in the other's place would be a lie about who is streaming.
 *
 * The URL is host-checked before it ever reaches state (see
 * core/twitchMetadata.ts) and `onError` covers the rest - a deleted image, a
 * blocked request, a CSP that disagrees. Failure falls back to the monogram,
 * so the geometry still does not move.
 */
function ChannelAvatar({
  login,
  src,
  name,
}: {
  login: string
  src: string | null
  name: string
}) {
  const [failed, setFailed] = useState(false)
  const tint = avatarTint(login)
  const showImage = Boolean(src) && !failed

  return (
    <div
      className="kb-avatar kb-gravity-avatar"
      style={{
        width: 22,
        height: 22,
        fontSize: 9,
        background: `linear-gradient(140deg, ${tint}, ${tint}b0)`,
      }}
      title={name}
      aria-hidden="true"
    >
      {showImage && (
        <img
          className="kb-avatar-img"
          src={src ?? undefined}
          alt=""
          loading="lazy"
          decoding="async"
          width={22}
          height={22}
          onError={() => setFailed(true)}
        />
      )}
      {!showImage && (name || login).slice(0, 1).toUpperCase()}
    </div>
  )
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
  meta,
  client,
  cardContext,
  openCardId,
  onToggleCard,
}: {
  section: GravitySection<Friend>
  meta?: ChannelMetadata
  client: KickbackClient
  cardContext: UserCardContext
  openCardId: string | null
  onToggleCard: (userId: string) => void
}) {
  const channelName = useChannelName()
  const here = section.kind === 'here'
  const heavy = isGravity(section)

  /*
   * Three states, and only two of them say anything.
   *
   * `live` earns the badge and the stream line. `offline` earns the word
   * OFFLINE, because a stream that has ended is worth knowing about before
   * clicking JOIN. `unknown` earns SILENCE - no badge, no line, no placeholder
   * - so a cold cache or a metadata outage produces exactly the card this
   * panel drew before metadata existed.
   */
  const live = section.live === 'live'
  const offline = section.live === 'offline'

  const className = [
    'kb-gravity-card',
    here ? 'kb-gravity-card-here' : '',
    heavy ? 'kb-gravity-card-strong' : '',
    offline ? 'kb-gravity-card-offline' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={className}>
      <div className="kb-gravity-head">
        <ChannelAvatar
          login={section.channel ?? ''}
          src={meta?.profileImageUrl ?? null}
          name={channelName(section.channel ?? '')}
        />

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

      {/*
       * The stream line.
       *
       * One row, whatever it has to say. Category leads because it is the
       * fastest answer to "what is this"; the live badge and viewer count sit
       * at the end where they cannot push it out of the card. Viewer count is
       * context - it is deliberately the smallest, dimmest thing here, and it
       * has no influence whatsoever on where this card sits.
       */}
      {(live || offline) && (
        <div className="kb-gravity-stream">
          {live && meta?.gameName && (
            <span className="kb-gravity-game" title={meta.gameName}>
              {meta.gameName}
            </span>
          )}

          <span className="kb-gravity-status">
            {live ? (
              <span className="kb-live" title="Streaming now">
                <span className="kb-live-dot" aria-hidden="true" />
                LIVE
              </span>
            ) : (
              <span className="kb-offline-badge" title="Twitch says this stream has ended">
                OFFLINE
              </span>
            )}

            {live && meta?.viewerCount !== null && meta?.viewerCount !== undefined && (
              <span className="kb-gravity-viewers" title={`${meta.viewerCount} viewers`}>
                {formatViewers(meta.viewerCount)}
              </span>
            )}
          </span>
        </div>
      )}

      {/*
       * The title, clamped to one line.
       *
       * Worth having and easy to let ruin the card: titles are long, arbitrary
       * and written by somebody else. One line, ellipsised, with the whole
       * thing on hover. We care first that friends are there, and only then
       * what they are watching.
       */}
      {live && meta?.title && (
        <div className="kb-gravity-title" title={meta.title}>
          {meta.title}
        </div>
      )}

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
  metadata,
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
        // The selector applies the freshness rule, so a record too old to
        // be evidence reports `unknown` and ranks and renders as none at all.
        metadata,
      ),
    [friends, localActivity, cardContext.selfId, metadata],
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
              meta={section.channel ? metadata?.[section.channel] : undefined}
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
