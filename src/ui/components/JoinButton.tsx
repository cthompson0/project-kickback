import { useState } from 'react'
import { joinChannel } from '../../platforms/twitch/join'
import type { JoinSource } from '../../platforms/twitch/join'
import { formatChannelName } from '../../platforms/twitch/channels'

interface JoinButtonProps {
  channel: string
  label?: string
  /** Recorded nowhere yet; see JoinSource. */
  source?: JoinSource
}

export function JoinButton({ channel, label = 'JOIN', source = 'friend_row' }: JoinButtonProps) {
  const [joining, setJoining] = useState(false)

  return (
    <button
      type="button"
      className={`kb-join${joining ? ' kb-join-busy' : ''}`}
      title={`Watch ${formatChannelName(channel)} on Twitch`}
      disabled={joining}
      onClick={() => {
        setJoining(true)
        joinChannel(channel, source)
      }}
    >
      {joining ? 'JOINING' : label}
    </button>
  )
}
