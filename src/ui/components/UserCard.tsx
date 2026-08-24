import { useEffect, useRef, useState } from 'react'
import { describePresence } from '../../core/personPresence'
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

export interface UserCardProps {
  user: User
  presence: Presence | null
  client: KickbackClient
  /** True when this person is already a friend. */
  isFriend: boolean
  /** True when a request to them is already outstanding. */
  requestPending?: boolean
  /** Hides relationship actions for the signed-in user's own card. */
  isSelf?: boolean
  /**
   * What the viewer is doing, so the card can tell "watching with you" from
   * "watching something else" - and never offer a JOIN to where they already
   * are.
   */
  viewerActivity?: Activity | null
  onClose: () => void
}

export function UserCard({
  user,
  presence,
  client,
  isFriend,
  requestPending = false,
  isSelf = false,
  viewerActivity = null,
  onClose,
}: UserCardProps) {
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const channelName = useChannelName()

  // Clicking anywhere else closes it, which is what a popover should do.
  useEffect(() => {
    const onDown = (event: Event) => {
      const path = event.composedPath?.() ?? []
      if (cardRef.current && !path.includes(cardRef.current)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    // Capture, because the shadow root retargets events on the way up.
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // One interpretation, shared with every other surface. The card used to
  // decide this for itself and disagreed with the group cluster about the
  // same person.
  const state = describePresence(presence, viewerActivity)

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
        {state.kind === 'watching_with_you' && state.channel ? (
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

      <div className="kb-usercard-actions">
        {/* Never offered when they are already where the viewer is. */}
        {state.canJoin && state.channel && (
          <JoinButton channel={state.channel} source="group" />
        )}

        <a
          className="kb-ghost-btn kb-ghost-btn-inline"
          href={channelUrl(user.username)}
          target="_blank"
          rel="noreferrer noopener"
        >
          View on Twitch
        </a>

        {!isSelf && !isFriend && (
          <button
            type="button"
            className="kb-ghost-btn kb-ghost-btn-inline"
            disabled={busy || sent || requestPending}
            onClick={() => void act(() => client.sendFriendRequest(user.id), () => setSent(true))}
          >
            {sent || requestPending ? 'Request sent' : 'Add friend'}
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
      </div>
    </div>
  )
}
