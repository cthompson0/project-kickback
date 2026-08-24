import { createContext, useContext, useMemo } from 'react'
import { resolveChannelName } from '../core/channelNames'
import type { NamedTwitchUser } from '../core/channelNames'

/**
 * One place that decides how a channel is spelled on screen.
 *
 * Every surface that names a channel - the current-activity line, friend rows,
 * gatherings, group presence, JOIN buttons - has to agree, or the same
 * streamer appears three different ways in one panel. A context rather than a
 * prop threaded through six components, because this is presentation and it is
 * needed at every depth.
 *
 * The resolution rules live in core/channelNames.ts; this is only the wiring.
 */

const ChannelNameContext = createContext<(channel: string) => string>((channel) => channel)

export function ChannelNameProvider({
  people,
  seen,
  children,
}: {
  /** Everyone whose Twitch display name Kickback already holds. */
  people: readonly NamedTwitchUser[]
  /** login -> casing, learned from pages this browser has opened. */
  seen: Readonly<Record<string, string>>
  children: React.ReactNode
}) {
  const resolve = useMemo(() => {
    // Built once per change rather than per row: a group of twelve people on
    // six channels would otherwise re-scan the list for every render.
    const byLogin = new Map<string, string>()
    for (const person of people) {
      const login = person.username?.trim().toLowerCase()
      const name = person.displayName?.trim()
      if (login && name && name.toLowerCase() === login) byLogin.set(login, name)
    }

    return (channel: string) => {
      const login = channel.trim().toLowerCase()
      return byLogin.get(login) ?? resolveChannelName(channel, { seen })
    }
  }, [people, seen])

  return <ChannelNameContext.Provider value={resolve}>{children}</ChannelNameContext.Provider>
}

/* eslint-disable react-refresh/only-export-components --
   The hook belongs beside the context it reads; splitting them across files to
   satisfy fast refresh would make the smaller thing harder to follow. */

/** Returns a function that spells a channel the way Twitch does, when known. */
export function useChannelName(): (channel: string) => string {
  return useContext(ChannelNameContext)
}

/**
 * A channel's name, spelled correctly.
 *
 * Exists so a component can name a channel without taking a hook of its own -
 * which matters for the panel shell, since it renders the provider and cannot
 * consume it in the same component.
 */
export function ChannelLabel({ channel }: { channel: string }) {
  return <>{useChannelName()(channel)}</>
}
