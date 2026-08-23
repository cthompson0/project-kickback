import { useEffect, useMemo, useState } from 'react'
import { IDLE } from '../core/types'
import type { Activity } from '../core/types'
import { isHere, sortForDisplay } from '../core/presence'
import { watchChannel } from '../platforms/twitch/navigation'
import { getCurrentChannel } from '../platforms/twitch/channels'
import type { Friend, KickbackClient, KickbackState } from '../client/types'

/**
 * Joins two independent sources: what the local user is watching (read from the
 * Twitch page, always available) and who Kickback knows about (from the client,
 * which needs a session). The first works signed out - the panel can still say
 * "You're watching LIRIK" before you have an account.
 */

export interface KickbackView extends KickbackState {
  localActivity: Activity
  channel: string | null
  friendsHere: Friend[]
  onlineCount: number
}

export function useKickbackState(client: KickbackClient): KickbackView {
  const [clientState, setClientState] = useState<KickbackState>(() => client.getState())
  const [channel, setChannel] = useState<string | null>(() => getCurrentChannel())

  useEffect(() => client.subscribe(setClientState), [client])
  useEffect(() => watchChannel(setChannel), [])

  // Keep "watching for 12m" honest without re-rendering constantly.
  const [, setClockTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setClockTick((tick) => tick + 1), 60_000)
    return () => window.clearInterval(id)
  }, [])

  const localActivity = useMemo<Activity>(
    () => (channel ? { type: 'watching', platform: 'twitch', channel } : IDLE),
    [channel],
  )

  const friends = useMemo(
    () => sortForDisplay(clientState.friends, localActivity),
    [clientState.friends, localActivity],
  )

  const friendsHere = useMemo(
    () => friends.filter((friend) => isHere(friend.presence, localActivity)),
    [friends, localActivity],
  )

  const onlineCount = useMemo(
    () => friends.filter((friend) => friend.presence.status === 'online').length,
    [friends],
  )

  return { ...clientState, friends, localActivity, channel, friendsHere, onlineCount }
}
