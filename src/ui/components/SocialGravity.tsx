import { useEffect, useMemo, useState } from 'react'
import { gravityModel, isGravity } from '../../core/socialGravity'
import type { DestinationsByUser } from '../../core/socialGravity'
import type { GravitySection } from '../../core/socialGravity'
import { formatViewers } from '../../core/twitchMetadata'
import type { ChannelMetadata } from '../../core/twitchMetadata'
import type { Activity } from '../../core/types'
import type { Friend, KickbackClient } from '../../client/types'
import type { TogetherReaction } from '../../core/together'
import { roomActivity } from '../../core/roomMessages'
import type { RoomMessage } from '../../core/roomMessages'
import { COMBO_MIN_DISPLAY } from '../../core/combos'
import { withoutMutedSenders } from '../../core/mute'
import { EmoteImage } from './EmoteImage'
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

/** Stable empty defaults, so an omitted prop is not a new object each render. */
const EMPTY_DESTINATIONS: DestinationsByUser = {}
const EMPTY_METADATA: Readonly<Record<string, ChannelMetadata>> = {}

interface SocialGravityProps {
  friends: Friend[]
  /**
   * Every ACTIVE destination each friend has open, keyed by user id.
   *
   * The multi-destination half of the map. Optional and defaulted to nothing,
   * because a friend with no entry - a v0.4.1 client, or anyone before the
   * first read lands - must still appear at their single presence channel.
   *
   * Omitting it produces exactly the map this component produced before
   * multi-destination existed.
   */
  destinations?: DestinationsByUser
  localActivity: Activity
  onRemove?: (userId: string) => void
  client: KickbackClient
  cardContext: UserCardContext
  /** login -> public Twitch metadata. Absent is normal and always safe. */
  metadata?: Readonly<Record<string, ChannelMetadata>>
  /**
   * Live reactions on the channel the viewer is on.
   *
   * Absent, empty, or stale-and-pruned are all the same thing: the Together
   * surface still shows who is here, because that comes from presence.
   */
  reactions?: readonly TogetherReaction[]
  /** The conversation, for the activity preview only. Never rendered as text. */
  roomMessages?: readonly RoomMessage[]
  mutedUserIds?: readonly string[]
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
  reactions,
  roomMessages,
  mutedUserIds,
  client,
  cardContext,
  openCardId,
  onToggleCard,
}: {
  section: GravitySection<Friend>
  meta?: ChannelMetadata
  reactions?: readonly TogetherReaction[]
  roomMessages?: readonly RoomMessage[]
  mutedUserIds?: readonly string[]
  client: KickbackClient
  cardContext: UserCardContext
  openCardId: string | null
  onToggleCard: (userId: string) => void
}) {
  const channelName = useChannelName()
  const here = section.kind === 'here'
  const heavy = isGravity(section)

  /*
   * The clock that lets the combo go away again.
   *
   * The combo is derived from an eight-second window, and nothing else
   * re-renders this card between presence updates - so without a tick it would
   * form correctly and then sit there until something unrelated happened. That
   * exact bug has now been fixed twice, once on each surface the combo has
   * lived on; it moves with the combo because it belongs to it.
   *
   * Only while there is something to age, and only on the card the viewer is
   * standing in: an idle map ticks nothing.
   */
  const [, setTick] = useState(0)
  const pulses = here ? (reactions?.length ?? 0) + (roomMessages?.length ?? 0) : 0
  useEffect(() => {
    if (pulses === 0) return
    const id = window.setInterval(() => setTick((value) => value + 1), 1_000)
    return () => window.clearInterval(id)
  }, [pulses])

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

  /*
   * The one piece of the session that leaks outward.
   *
   * COMBOS ONLY. A single emote is a thing one person did and belongs in the
   * conversation; a combo is several people agreeing at once, which is the
   * social signal worth catching from across the panel. The threshold is the
   * combo engine's own - there is no second opinion here about what counts.
   *
   * Drawn from the same derivation the session's own indicator uses, over the
   * same eight-second window, with muted people already filtered out.
   */
  const activity = here
    ? roomActivity(
        withoutMutedSenders(reactions ?? [], mutedUserIds ?? []),
        withoutMutedSenders(roomMessages ?? [], mutedUserIds ?? []),
        section.channel,
        () => '',
      )
    : null
  const combo = activity && activity.count >= COMBO_MIN_DISPLAY ? activity : null

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
            ) : offline ? (
              <span className="kb-offline-badge" title="Twitch says this stream has ended">
                OFFLINE
              </span>
            ) : null}

            {live && meta?.viewerCount !== null && meta?.viewerCount !== undefined && (
              <span className="kb-gravity-viewers" title={`${meta.viewerCount} viewers`}>
                {formatViewers(meta.viewerCount)}
              </span>
            )}
          </span>
        </div>
      )}

      {/*
       * The activity line, directly under LIVE and the viewer count.
       *
       * A line of its own rather than another item in the status row: the row
       * is already carrying a category, a badge and a number at the narrowest
       * panel, and squeezing a fifth thing in made it crowded. Underneath, it
       * reads as what it is - an ephemeral note about the destination's
       * current state, in the same column as the rest of that state.
       *
       * IT IS NOT A CONTROL, and that is the correction. It briefly carried a
       * "Join Room →" button, and in real use the invitation was more visually
       * expensive than the signal it was attached to. The combo alone already
       * says everything: something is happening right now. The contextual
       * streamer tab is the way in, and it is always there.
       */}
      {combo && (
        <div className="kb-gravity-activity" aria-live="polite">
          <span className="kb-gravity-combo" key={`${combo.emote.id}:${combo.count}`}>
            <EmoteImage emote={combo.emote} size={15} />
            <span className="kb-together-count">×{combo.count}</span>
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

      {/*
       * The Gravity card the viewer is standing in IS the Together surface.
       *
       * "N friends watching with you" was already the right sentence; all it
       * lacked was something to do about it. Nothing new is created when
       * somebody arrives - the card was always here, and it grows a reaction
       * row the moment there is anybody to react with.
       */}
      {here && (
        <div className="kb-gravity-with-you">
          {section.count === 1 ? '1 friend watching with you' : `${section.count} friends watching with you`}
        </div>
      )}

      {/*
       * NO WAY IN LIVES ON THIS CARD.
       *
       * A permanent ROOM button used to, carrying a duplicate unread badge, so
       * one waiting message was announced twice in the same panel. Then the
       * combo above briefly carried a "Join Room →" invitation, and in real
       * use that cost more attention than the signal it was attached to.
       *
       * The contextual streamer tab is the doorway, it owns the unread count,
       * and it is there whether or not anything is happening. This card's job
       * is to say where everybody is - and, for eight seconds at a time, that
       * something is going on.
       */}

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
  destinations = EMPTY_DESTINATIONS,
  localActivity,
  onRemove,
  client,
  cardContext,
  metadata,
  reactions,
  roomMessages,
  mutedUserIds,
}: SocialGravityProps) {
  const [openCardId, setOpenCardId] = useState<string | null>(null)

  const sections = useMemo(
    () =>
      /*
       * THE canonical model - the same call the panel makes for analytics.
       *
       * The component does not rebuild domain state: it names its inputs and
       * renders what comes back. `now` is left to the selector, because
       * reading the clock during render is impure and it is only used to age
       * presence out.
       */
      gravityModel({
        friends: friends.map((friend) => ({
          member: friend,
          presence: friend.presence,
          userId: friend.user.id,
        })),
        destinations,
        localActivity,
        // "Where is everyone else" - the viewer is never one of them.
        selfId: cardContext.selfId,
        // Required by the model, and this is why: without it every card loses
        // its Twitch casing, live badge, category, viewers and avatar, and
        // still renders. The selector applies the freshness rule, so a record
        // too old to be evidence reports `unknown`.
        metadata: metadata ?? EMPTY_METADATA,
      }),
    [friends, destinations, localActivity, cardContext.selfId, metadata],
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
              reactions={section.kind === 'here' ? reactions : undefined}
              roomMessages={section.kind === 'here' ? roomMessages : undefined}
              mutedUserIds={mutedUserIds}
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
