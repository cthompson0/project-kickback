import { useEffect, useMemo, useState } from 'react'
import { IDLE } from '../core/types'
import type { Activity, Presence } from '../core/types'
import { effectiveStatus, findGatherings, isHere, sortForDisplay } from '../core/presence'
import type { Gathering } from '../core/presence'
import { watchChannel } from '../platforms/twitch/navigation'
import { getCurrentChannel } from '../platforms/twitch/channels'
import type { Friend, KickbackClient, KickbackState } from '../client/types'

/**
 * Joins two independent sources: what the local user is watching (read from the
 * Twitch page, always available) and who Watchside knows about (from the client,
 * which needs a session). The first works signed out - the panel can still say
 * "You're watching LIRIK" before you have an account.
 */

export interface KickbackView extends KickbackState {
  localActivity: Activity
  channel: string | null
  friendsHere: Friend[]
  onlineCount: number
  /** True when at least one friend has real presence to show. */
  hasPresence: boolean
  /** Friends clustered on a channel that is not the one we are watching. */
  gatherings: Gathering[]
}

/** Narrowed copy so the presence sorter can be given only what it understands. */
type FriendWithPresence = { user: Friend['user']; presence: Presence }

function hasPresence(friend: Friend): friend is FriendWithPresence {
  return friend.presence !== null
}

export function useKickbackState(client: KickbackClient): KickbackView {
  const [clientState, setClientState] = useState<KickbackState>(() => client.getState())
  const [channel, setChannel] = useState<string | null>(() => getCurrentChannel())

  useEffect(() => client.subscribe(setClientState), [client])
  useEffect(() => watchChannel(setChannel), [])

  // Re-renders on a timer so elapsed labels stay honest and, more importantly,
  // so a friend whose heartbeat stopped fades to offline on their own - no
  // event ever arrives to announce that someone's laptop shut.
  const [, setClockTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setClockTick((tick) => tick + 1), 15_000)
    return () => window.clearInterval(id)
  }, [])

  const localActivity = useMemo<Activity>(
    () => (channel ? { type: 'watching', platform: 'twitch', channel } : IDLE),
    [channel],
  )

  const friends = useMemo(() => {
    // Friends with presence sort by what they are doing; the rest fall to the
    // bottom in name order, since there is nothing to rank them by.
    const known = clientState.friends.filter(hasPresence)
    const unknown = clientState.friends
      .filter((friend) => !hasPresence(friend))
      .sort((a, b) => a.user.displayName.localeCompare(b.user.displayName))

    return [...sortForDisplay(known, localActivity), ...unknown]
  }, [clientState.friends, localActivity])

  const friendsHere = useMemo(
    () => friends.filter((friend) => friend.presence !== null && isHere(friend.presence, localActivity)),
    [friends, localActivity],
  )

  const onlineCount = useMemo(
    () =>
      friends.filter(
        (friend) => friend.presence && effectiveStatus(friend.presence) === 'online',
      ).length,
    [friends],
  )

  const gatherings = useMemo(
    () =>
      findGatherings(
        friends.flatMap((friend) => (friend.presence ? [friend.presence] : [])),
        localActivity,
      ).filter((gathering) => gathering.userIds.length >= 2),
    [friends, localActivity],
  )

  return {
    ...clientState,
    friends,
    localActivity,
    channel,
    friendsHere,
    onlineCount,
    hasPresence: friends.some(hasPresence),
    gatherings,
  }
}
