import type { Activity } from '../../core/types'
import { formatSince, isHere, isWatching } from '../../core/presence'
import { formatChannelName } from '../../platforms/twitch/channels'
import type { Friend } from '../../client/types'
import { Avatar } from './Avatar'
import type { AvatarState } from './Avatar'
import { JoinButton } from './JoinButton'

interface PersonRowProps {
  person: Friend
  localActivity: Activity
}

export function PersonRow({ person, localActivity }: PersonRowProps) {
  const { user, presence } = person
  const here = isHere(presence, localActivity)
  const offline = presence.status === 'offline'
  const channel =
    presence.status === 'online' && isWatching(presence.activity) ? presence.activity.channel : null

  const avatarState: AvatarState = offline ? 'offline' : here ? 'here' : 'online'

  const rowClass = [
    'kb-row',
    here ? 'kb-row-here' : '',
    offline ? 'kb-row-offline' : '',
  ]
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
            <span>Online</span>
          )}
        </div>
      </div>

      {here && <span className="kb-badge-here">HERE</span>}
      {!here && channel && <JoinButton channel={channel} />}
    </div>
  )
}
