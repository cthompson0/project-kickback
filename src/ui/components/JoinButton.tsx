import { useState } from 'react'
import { joinChannel } from '../../platforms/twitch/join'
import type { JoinSource } from '../../platforms/twitch/join'
import { useChannelName } from '../ChannelNames'
import { useAnalytics } from '../Analytics'

interface JoinButtonProps {
  channel: string
  label?: string
  /** Which surface this button belongs to. Recorded as the JOIN's source. */
  source?: JoinSource
  /**
   * How many people this surface was showing on that channel.
   *
   * The whole point of the Social Gravity comparison is whether a JOIN offered
   * beside six friends converts better than one offered beside a single name,
   * so the number has to come from the surface that drew it. Zero means "this
   * surface is not about a group of people", not "nobody was there".
   */
  socialCount?: number
}

export function JoinButton({
  channel,
  label = 'JOIN',
  source = 'friend_row',
  socialCount = 0,
}: JoinButtonProps) {
  const [joining, setJoining] = useState(false)
  const channelName = useChannelName()
  const analytics = useAnalytics()

  return (
    <button
      type="button"
      className={`kb-join${joining ? ' kb-join-busy' : ''}`}
      title={`Watch ${channelName(channel)} on Twitch`}
      disabled={joining}
      onClick={() => {
        setJoining(true)

        /*
         * Navigate first, record second - and record synchronously.
         *
         * `joinChannel` may replace this page, which takes this component and
         * everything it could still have done with it. The recording is a
         * one-way port message with nothing to await, so it is posted to the
         * worker before the browser gets round to the navigation; the worker
         * is a separate context and outlives the tab.
         *
         * It also has to be *after* the call, because whether the navigation
         * actually happened is the answer joinChannel returns: clicking JOIN
         * on the channel you are already watching is a real click that goes
         * nowhere, and calling that a JOIN would inflate every arrival rate.
         */
        const navigated = joinChannel(channel)
        analytics.recordJoin({ channel, source, socialCount, navigated })

        // Nothing is loading if nothing was navigated to.
        if (!navigated) setJoining(false)
      }}
    >
      {joining ? 'JOINING' : label}
    </button>
  )
}
