import { useState } from 'react'
import type { User } from '../../core/types'

export type AvatarState = 'offline' | 'online' | 'here'

interface AvatarProps {
  user: User
  size?: number
  state?: AvatarState
  /** Presence dot is a claim about activity - omit it when we have none. */
  showDot?: boolean
}

/** Stable, readable tint for users the platform gave us no colour for. */
const PALETTE = [
  '#ff8452',
  '#54b8ff',
  '#2ee6a8',
  '#c98bff',
  '#ffd45e',
  '#ff5f8f',
  '#7de2d1',
  '#9db4ff',
]

function colorFor(user: User): string {
  if (user.accentColor) return user.accentColor
  let hash = 0
  for (let i = 0; i < user.id.length; i++) {
    hash = (hash * 31 + user.id.charCodeAt(i)) >>> 0
  }
  return PALETTE[hash % PALETTE.length]
}

/** Tinted initial, upgraded to the real profile image when one is available. */
export function Avatar({ user, size = 30, state = 'offline', showDot = true }: AvatarProps) {
  const [imageFailed, setImageFailed] = useState(false)
  const showImage = Boolean(user.avatarUrl) && !imageFailed
  const color = colorFor(user)

  return (
    <div
      className={`kb-avatar${showDot && state === 'offline' ? ' kb-avatar-offline' : ''}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: `linear-gradient(140deg, ${color}, ${color}b0)`,
      }}
      title={user.displayName}
    >
      {showImage ? (
        <img
          className="kb-avatar-img"
          src={user.avatarUrl ?? undefined}
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
