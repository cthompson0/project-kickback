import { useState } from 'react'
import type { Activity } from '../../core/types'
import { effectiveStatus, formatSince, isHere, isWatching } from '../../core/presence'
import { formatChannelName } from '../../platforms/twitch/channels'
import type { Friend } from '../../client/types'
import { Avatar } from './Avatar'
import type { AvatarState } from './Avatar'
import { JoinButton } from './JoinButton'

interface PersonRowProps {
  person: Friend
  localActivity: Activity
  onRemove?: (userId: string) => void
}

export function PersonRow({ person, localActivity, onRemove }: PersonRowProps) {
  const { user, presence } = person
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  /**
   * No presence at all is not the same as offline, and Kickback must not say
   * otherwise: it shows the person's handle and makes no claim about activity.
   * Real presence arrives in Checkpoint 5.
   */
  if (!presence) {
    return (
      <div className="kb-row">
        <Avatar user={user} showDot={false} />
        <div className="kb-row-main">
          <div className="kb-row-name">{user.displayName}</div>
          <div className="kb-row-status">
            <span className="kb-handle">@{user.username}</span>
          </div>
        </div>
        {onRemove && (
          <RemoveControl
            name={user.displayName}
            confirming={confirmingRemove}
            onAsk={() => setConfirmingRemove(true)}
            onCancel={() => setConfirmingRemove(false)}
            onConfirm={() => {
              setConfirmingRemove(false)
              onRemove(user.id)
            }}
          />
        )}
      </div>
    )
  }

  const here = isHere(presence, localActivity)
  // Offline is derived, not just stored: a row that says "online" but stopped
  // being heartbeated describes someone who closed their laptop.
  const offline = effectiveStatus(presence) === 'offline'
  const channel = !offline && isWatching(presence.activity) ? presence.activity.channel : null

  const avatarState: AvatarState = offline ? 'offline' : here ? 'here' : 'online'

  const rowClass = ['kb-row', here ? 'kb-row-here' : '', offline ? 'kb-row-offline' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rowClass}>
      <Avatar user={user} state={avatarState} />

      <div className="kb-row-main">
        <div className="kb-row-name">{user.displayName}</div>
        <div className={`kb-row-status${here ? ' kb-row-status-here' : ''}`}>
          {offline ? (
            <span>Offline</span>
          ) : here ? (
            <>
              <span>Watching with you</span>
              <span className="kb-time">{formatSince(presence.since)}</span>
            </>
          ) : channel ? (
            <>
              <span>
                Watching <span className="kb-channel">{formatChannelName(channel)}</span>
              </span>
              <span className="kb-time">{formatSince(presence.since)}</span>
            </>
          ) : (
            <span>Around</span>
          )}
        </div>
      </div>

      {here && <span className="kb-badge-here">HERE</span>}
      {!here && channel && <JoinButton channel={channel} />}
    </div>
  )
}

interface RemoveControlProps {
  name: string
  confirming: boolean
  onAsk: () => void
  onCancel: () => void
  onConfirm: () => void
}

/** Hidden until the row is hovered, then one confirmation before it acts. */
function RemoveControl({ name, confirming, onAsk, onCancel, onConfirm }: RemoveControlProps) {
  if (confirming) {
    return (
      <span className="kb-confirm">
        <button type="button" className="kb-confirm-yes" onClick={onConfirm}>
          Remove
        </button>
        <button type="button" className="kb-confirm-no" onClick={onCancel}>
          Cancel
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      className="kb-row-action"
      title={`Remove ${name} from your friends`}
      aria-label={`Remove ${name} from your friends`}
      onClick={onAsk}
    >
      &times;
    </button>
  )
}
