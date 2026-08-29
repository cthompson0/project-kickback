import type { User } from '../core/types'

/**
 * Everyone Watchside knows about in Phase 0. Note this is a directory of users,
 * not a friends list - some of these people are only reachable through a group.
 */
export const MOCK_USERS: User[] = [
  { id: 'u_jake', username: 'jakethesnake', displayName: 'Jake', accentColor: '#ff8452' },
  { id: 'u_matt', username: 'mattycakes', displayName: 'Matt', accentColor: '#54b8ff' },
  { id: 'u_sarah', username: 'sarahsmash', displayName: 'Sarah', accentColor: '#2ee6a8' },
  { id: 'u_chris', username: 'chrisp', displayName: 'Chris', accentColor: '#c98bff' },
  { id: 'u_dave', username: 'daveyjones', displayName: 'Dave', accentColor: '#ffd45e' },
  { id: 'u_nina', username: 'ninaaa', displayName: 'Nina', accentColor: '#ff5f8f' },
  { id: 'u_kenji', username: 'kenji_tv', displayName: 'Kenji', accentColor: '#7de2d1' },
]

const USERS_BY_ID = new Map(MOCK_USERS.map((user) => [user.id, user]))

export function getUser(id: string): User | undefined {
  return USERS_BY_ID.get(id)
}
