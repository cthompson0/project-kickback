import type { Activity } from '../../core/types'
import { isHere, isWatching } from '../../core/presence'
import type { Friend } from '../../client/types'
import { PersonRow } from './PersonRow'

interface FriendsTabProps {
  friends: Friend[]
  localActivity: Activity
  onRemove?: (userId: string) => void
}

type Bucket = 'here' | 'watching' | 'online' | 'offline' | 'unknown'

/**
 * Buddy-list grouping: here, out watching something, around, gone - and
 * "unknown" for friends Kickback has no presence for, which is every real
 * friend until Checkpoint 5. That bucket renders without a heading, so the
 * list reads as a plain list of people rather than an empty status board.
 */
function bucketOf(friend: Friend, localActivity: Activity): Bucket {
  if (!friend.presence) return 'unknown'
  if (friend.presence.status === 'offline') return 'offline'
  if (isHere(friend.presence, localActivity)) return 'here'
  return isWatching(friend.presence.activity) ? 'watching' : 'online'
}

const SECTIONS: Array<{ key: Bucket; label: string | null }> = [
  { key: 'here', label: 'Here with you' },
  { key: 'watching', label: 'Watching elsewhere' },
  { key: 'online', label: 'Around' },
  { key: 'unknown', label: null },
  { key: 'offline', label: 'Offline' },
]

export function FriendsTab({ friends, localActivity, onRemove }: FriendsTabProps) {
  if (friends.length === 0) {
    return <div className="kb-empty">No friends yet.</div>
  }

  return (
    <>
      {SECTIONS.map((section) => {
        const people = friends.filter((friend) => bucketOf(friend, localActivity) === section.key)
        if (people.length === 0) return null

        return (
          <div key={section.key}>
            {section.label && (
              <div className="kb-section-label">
                {section.label} · {people.length}
              </div>
            )}
            {people.map((friend) => (
              <PersonRow
                key={friend.user.id}
                person={friend}
                localActivity={localActivity}
                onRemove={onRemove}
              />
            ))}
          </div>
        )
      })}
    </>
  )
}
