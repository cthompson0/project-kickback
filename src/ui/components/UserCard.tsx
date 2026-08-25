import { useEffect, useRef, useState } from 'react'
import { describePresence, describeSelf } from '../../core/personPresence'
import { channelUrl } from '../../platforms/twitch/channels'
import type { Activity, Presence, User } from '../../core/types'
import type { KickbackClient } from '../../client/types'
import { Avatar } from './Avatar'
import { JoinButton } from './JoinButton'
import { useChannelName } from '../ChannelNames'

/**
 * A small card behind a person's name.
 *
 * The product opportunity it exists for: a group can contain people you are
 * not friends with, and until now there was no path from "I see this person in
 * my group every night" to "we are friends". The card puts Add Friend exactly
 * where you already think about them.
 *
 * Deliberately small. It shows what the panel already knows about someone and
 * offers the three things you would actually want - go where they are, look
 * them up on Twitch, change the relationship. No DMs, no profiles, no blocking,
 * no mutual-groups browser.
 *
 * It never shows anything the panel was not already given. Presence here is
 * the same redacted presence the row above it used, so a member who hides
 * their activity is as quiet in the card as in the list.
 */

/**
 * Everything the card needs about the viewer, in one object.
 *
 * REQUIRED, and deliberately not a set of optional props.
 *
 * The viewer's activity used to be an optional prop that defaulted to null.
 * Two of the three call sites passed it and one - group chat - did not, so
 * opening the same person's card from chat offered a JOIN to the stream you
 * were already watching, while opening it from Friends correctly did not.
 * Nothing failed; the card just quietly answered a different question.
 *
 * Making the context one required value turns forgetting it into a compile
 * error rather than a behaviour change, which is the only version of this that
 * stays fixed when the next call site is added.
 */
export interface UserCardContext {
  /** The signed-in user, so the card can recognise itself. */
  selfId: string | null
  /** What the viewer is doing, which decides "with you" and whether to JOIN. */
  viewerActivity: Activity
  /** Who the viewer is already friends with. */
  friendIds: ReadonlySet<string>
  /** Friend requests the viewer has already sent. */
  outgoingRequestIds: ReadonlySet<string>
  /**
   * People this viewer has muted.
   *
   * Part of the card's context rather than a prop, for the reason the comment
   * above gives about viewerActivity: the card is opened from five places now,
   * and a mute control that silently did nothing at one of them would look
   * like it had worked.
   */
  mutedUserIds?: readonly string[]
  /**
   * People this viewer has blocked.
   *
   * Only their own blocks: the server will not say who has blocked THEM, so
   * there is no shape here that could carry that.
   */
  blockedUserIds?: ReadonlySet<string>
}

export interface UserCardProps {
  user: User
  presence: Presence | null
  client: KickbackClient
  context: UserCardContext
  onClose: () => void
}

export function UserCard({ user, presence, client, context, onClose }: UserCardProps) {
  // Derived here rather than passed in, for the same reason: three call sites
  // computing "is this a friend" three times is three chances to disagree.
  const isSelf = context.selfId !== null && user.id === context.selfId
  const isFriend = context.friendIds.has(user.id)
  const muted = (context.mutedUserIds ?? []).includes(user.id)
  const blocked = context.blockedUserIds?.has(user.id) ?? false
  const requestPending = context.outgoingRequestIds.has(user.id)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [confirmBlock, setConfirmBlock] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const channelName = useChannelName()

  // Clicking anywhere else closes it, which is what a popover should do.
  useEffect(() => {
    const onDown = (event: Event) => {
      const path = event.composedPath?.() ?? []
      if (cardRef.current && !path.includes(cardRef.current)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Marks it handled, so an Escape that closed this card does not also close
      // whatever is behind it. Capture, so this runs first whatever else is
      // listening - the innermost open thing is what Escape means.
      event.preventDefault()
      onClose()
    }
    // Capture, because the shadow root retargets events on the way up.
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  // Your own card is a different question, so it gets a different answer -
  // see describeSelf. Everyone else goes through the one shared selector.
  const state = isSelf
    ? describeSelf(context.viewerActivity)
    : describePresence(presence, context.viewerActivity)

  async function act(run: () => Promise<unknown>, after?: () => void) {
    setBusy(true)
    setError(null)
    try {
      await run()
      after?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="kb-usercard" ref={cardRef} data-kb-nodrag role="dialog">
      <div className="kb-usercard-head">
        <Avatar user={user} size={30} showDot={false} />
        <div className="kb-usercard-id">
          {/* Twitch's own capitalisation, never derived from the login. */}
          <div className="kb-usercard-name">{user.displayName}</div>
          <div className="kb-handle">@{user.username}</div>
        </div>
      </div>

      <div className="kb-usercard-activity">
        {isSelf ? (
          <>
            <span className="kb-usercard-self">This is you</span>
            {state.kind === 'watching_elsewhere' && state.channel ? (
              <>
                {' · Watching '}
                <span className="kb-channel">{channelName(state.channel)}</span>
              </>
            ) : (
              ' · On Twitch'
            )}
          </>
        ) : state.kind === 'watching_with_you' && state.channel ? (
          <>
            Watching with you
            <span className="kb-channel kb-usercard-channel">{channelName(state.channel)}</span>
          </>
        ) : state.kind === 'watching_elsewhere' && state.channel ? (
          <>
            Watching <span className="kb-channel">{channelName(state.channel)}</span>
          </>
        ) : state.kind === 'around' ? (
          // Browsing and hiding activity are indistinguishable by design: a
          // client that could tell them apart would be leaking the choice.
          'Around on Twitch'
        ) : (
          'Offline'
        )}
      </div>

      {error && <div className="kb-inline-note">{error}</div>}

      {/*
        * The ordinary controls stand down while the block confirmation is up.
        *
        * Otherwise two buttons reading Block would be on screen at once, and
        * the one that does nothing is the more prominent of the two.
        */}
      {!confirmBlock && (
      <div className="kb-usercard-actions">
        {/* Never offered when they are already where the viewer is. Your own
            card needs no separate guard: describeSelf never reports anywhere
            to go, and there is a mutation proving that. */}
        {state.canJoin && state.channel && (
          // One person, from the card - not "group", which was simply the value
          // the card inherited when it only ever appeared inside one.
          <JoinButton channel={state.channel} source="user_card" socialCount={1} />
        )}

        <a
          className="kb-ghost-btn kb-ghost-btn-inline"
          href={channelUrl(user.username)}
          target="_blank"
          rel="noreferrer noopener"
        >
          Profile
        </a>

        {!isSelf && !isFriend && !blocked && (
          <button
            type="button"
            className="kb-ghost-btn kb-ghost-btn-inline"
            disabled={busy || sent || requestPending}
            onClick={() => void act(() => client.sendFriendRequest(user.id), () => setSent(true))}
          >
            {sent || requestPending ? 'Request sent' : 'Add friend'}
          </button>
        )}

        {/*
          * Somebody you have blocked gets no friendship controls at all.
          *
          * Offering Add friend to a person the server will refuse would be a
          * button that exists to fail. Unblocking is the way back, and it lives
          * in the account card - the one place that lists them.
          */}
        {!isSelf && blocked && <span className="kb-usercard-blocked">Blocked</span>}

        {/*
          * Mute, which is a quiet and not a judgement.
          *
          * Local to this browser: they are not told, nothing about the
          * friendship changes, and they keep participating normally for
          * everybody else. It suppresses their room messages, their reactions,
          * and their contribution to the combo counts THIS viewer sees.
          *
          * Deliberately not a block. Block has to affect the graph itself and
          * is server-side; it is the next thing, and mute is not a substitute
          * for it. See core/mute.ts.
          */}
        {!isSelf && !blocked && (
          <button
            type="button"
            className="kb-ghost-btn kb-ghost-btn-inline"
            onClick={() => client.setUserMuted(user.id, !muted)}
          >
            {muted ? 'Unmute' : 'Mute'}
          </button>
        )}

        {!isSelf && isFriend && (
          confirmRemove ? (
            <>
              <button
                type="button"
                className="kb-ghost-btn kb-ghost-btn-inline kb-confirm-yes"
                disabled={busy}
                onClick={() => void act(() => client.removeFriend(user.id), onClose)}
              >
                Remove
              </button>
              <button
                type="button"
                className="kb-ghost-btn kb-ghost-btn-inline"
                onClick={() => setConfirmRemove(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="kb-ghost-btn kb-ghost-btn-inline"
              onClick={() => setConfirmRemove(true)}
            >
              Remove friend
            </button>
          )
        )}

        {/*
          * Block, last in the row and quiet.
          *
          * It is an infrequent safety action, not a thing to reach for - so it
          * sits after the ordinary controls and looks like the rest of them.
          * What it does is not quiet at all, which is why it asks first: it
          * ends the friendship, cancels any pending request, and takes the two
          * of you out of each other's presence and rooms server-side.
          */}
        {!isSelf && !blocked && (
          <button
            type="button"
            className="kb-ghost-btn kb-ghost-btn-inline"
            onClick={() => setConfirmBlock(true)}
          >
            Block
          </button>
        )}
      </div>
      )}

      {confirmBlock && !isSelf && (
        <div className="kb-usercard-confirm" role="group" aria-label="Confirm block">
          <div className="kb-usercard-confirm-text">
            Block {user.displayName}? You won't see each other's Kickback activity or be
            put in stream sessions together. This also removes them as a friend.
          </div>
          <div className="kb-usercard-actions">
            <button
              type="button"
              className="kb-ghost-btn kb-ghost-btn-inline"
              onClick={() => setConfirmBlock(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="kb-ghost-btn kb-ghost-btn-inline kb-confirm-yes"
              disabled={busy}
              onClick={() => void act(() => client.blockUser(user.id), onClose)}
            >
              Block
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
