import type { Activity } from '../../core/types'
import { isHere, isWatching } from '../../core/presence'
import type { Friend } from '../../client/types'
import { PersonRow } from './PersonRow'

interface FriendsTabProps {
  friends: Friend[]
  localActivity: Activity
}

/** Buddy-list grouping: here, out watching something, around, gone. */
function bucketOf(person: Friend, localActivity: Activity): 'here' | 'watching' | 'online' | 'offline' {
  if (person.presence.status === 'offline') return 'offline'
  if (isHere(person.presence, localActivity)) return 'here'
  return isWatching(person.presence.activity) ? 'watching' : 'online'
}

const SECTIONS = [
  { key: 'here', label: 'Here with you' },
  { key: 'watching', label: 'Watching elsewhere' },
  { key: 'online', label: 'Around' },
  { key: 'offline', label: 'Offline' },
] as const

export function FriendsTab({ friends, localActivity }: FriendsTabProps) {
  if (friends.length === 0) {
    return <div className="kb-empty">No friends yet.</div>
  }

  return (
    <>
      {SECTIONS.map((section) => {
        const people = friends.filter((person) => bucketOf(person, localActivity) === section.key)
        if (people.length === 0) return null

        return (
          <div key={section.key}>
            <div className="kb-section-label">
              {section.label} · {people.length}
            </div>
            {people.map((person) => (
              <PersonRow key={person.user.id} person={person} localActivity={localActivity} />
            ))}
          </div>
        )
      })}
    </>
  )
}
