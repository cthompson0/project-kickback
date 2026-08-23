import { useState } from 'react'
import { joinChannel } from '../../platforms/twitch/join'
import { formatChannelName } from '../../platforms/twitch/channels'

interface JoinButtonProps {
  channel: string
  label?: string
}

export function JoinButton({ channel, label = 'JOIN' }: JoinButtonProps) {
  const [joining, setJoining] = useState(false)

  return (
    <button
      type="button"
      className={`kb-join${joining ? ' kb-join-busy' : ''}`}
      title={`Watch ${formatChannelName(channel)} on Twitch`}
      disabled={joining}
      onClick={() => {
        setJoining(true)
        joinChannel(channel)
      }}
    >
      {joining ? 'JOINING' : label}
    </button>
  )
}
