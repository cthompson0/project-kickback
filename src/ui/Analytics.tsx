import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import type {
  AnalyticsEventMap,
  AnalyticsEventName,
  AnalyticsSurface,
} from '../core/analytics'
import type { KickbackClient } from '../client/types'

/**
 * Analytics, as the panel sees it.
 *
 * A context rather than a prop, because JOIN buttons and friend rows are drawn
 * in six places and threading a client through all of them - for something
 * that is not part of what any of them does - would put measurement in the way
 * of the product. A component that wants to record something asks for it here.
 *
 * THE DEFAULT DOES NOTHING, AND THAT IS THE POINT
 *
 * Every method is a no-op unless a provider supplies real ones. A component
 * rendered on its own - in a test, in the demo build, in a future storybook -
 * therefore behaves identically whether or not anybody is measuring it. There
 * is no path where a missing provider becomes an error a user would see.
 */

export interface Analytics {
  track<N extends AnalyticsEventName>(
    name: N,
    properties?: Partial<AnalyticsEventMap[N]>,
    options?: { source?: AnalyticsSurface; channel?: string | null },
  ): void
  recordJoin(input: {
    channel: string
    source: AnalyticsSurface
    socialCount: number
    navigated: boolean
  }): void
  reportExposure(report: {
    friends: Array<{
      userId: string
      channel: string
      state: 'watching_with_you' | 'watching_elsewhere'
    }>
    gatherings: Array<{ channel: string; friendCount: number; rank: number }>
    gravity: Array<{ channel: string; friendCount: number; rank: number }>
  }): void
}

const NOTHING: Analytics = {
  track: () => {},
  recordJoin: () => {},
  reportExposure: () => {},
}

const AnalyticsContext = createContext<Analytics>(NOTHING)

export function AnalyticsProvider({
  client,
  children,
}: {
  client: KickbackClient
  children: ReactNode
}) {
  const value = useMemo<Analytics>(
    () => ({
      track: (name, properties, options) => client.track(name, properties, options),
      recordJoin: (input) => client.recordJoin(input),
      reportExposure: (report) => client.reportExposure(report),
    }),
    [client],
  )

  return <AnalyticsContext.Provider value={value}>{children}</AnalyticsContext.Provider>
}

/* eslint-disable react-refresh/only-export-components --
   The hook belongs beside the provider it reads from: splitting them would put
   the context in a third file that neither of them is, for the sake of a
   dev-server refresh optimisation. */
export function useAnalytics(): Analytics {
  return useContext(AnalyticsContext)
}
