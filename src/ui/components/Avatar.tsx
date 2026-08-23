import { useState } from 'react'
import type { User } from '../../core/types'

export type AvatarState = 'offline' | 'online' | 'here'

interface AvatarProps {
  user: User
  size?: number
  state?: AvatarState
  /** Presence dot is noise inside stacks and header buttons. */
  showDot?: boolean
  /** Real profile image when the platform gave us one. */
  avatarUrl?: string | null
}

/** Tinted initial, upgraded to the real profile image when one is available. */
export function Avatar({
  user,
  size = 30,
  state = 'offline',
  showDot = true,
  avatarUrl = null,
}: AvatarProps) {
  const [imageFailed, setImageFailed] = useState(false)
  const showImage = Boolean(avatarUrl) && !imageFailed

  return (
    <div
      className={`kb-avatar${state === 'offline' ? ' kb-avatar-offline' : ''}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: `linear-gradient(140deg, ${user.accentColor}, ${user.accentColor}b0)`,
      }}
      title={user.displayName}
    >
      {showImage ? (
        <img
          className="kb-avatar-img"
          src={avatarUrl ?? undefined}
          alt=""
          width={size}
          height={size}
          onError={() => setImageFailed(true)}
        />
      ) : (
        user.displayName.charAt(0).toUpperCase()
      )}
      {showDot && <span className={`kb-avatar-dot kb-avatar-dot-${state}`} />}
    </div>
  )
}
