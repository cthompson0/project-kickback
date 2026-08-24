import { useEffect, useRef, useState } from 'react'
import { effectiveStatus, isWatching } from '../../core/presence'
import { channelUrl } from '../../platforms/twitch/channels'
import type { Presence, User } from '../../core/types'
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
  onClose: () => void
}

export function UserCard({
  user,
  presence,
  client,
  isFriend,
  requestPending = false,
  isSelf = false,
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

  const online = presence !== null && effectiveStatus(presence) === 'online'
  const watching = presence && online && isWatching(presence.activity) ? presence.activity : null

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
        {watching ? (
          <>
            Watching <span className="kb-channel">{channelName(watching.channel)}</span>
          </>
        ) : online ? (
          'Around on Twitch'
        ) : (
          // No claim beyond what presence actually said.
          'Not sharing activity right now'
        )}
      </div>

      {error && <div className="kb-inline-note">{error}</div>}

      <div className="kb-usercard-actions">
        {watching && <JoinButton channel={watching.channel} source="group" />}

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
