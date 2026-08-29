import {
  LIVE_TTL_MS,
  needsRefresh,
  normalizeLogins,
  parseDiagnostics,
  parseMetadataResponse,
} from '../core/twitchMetadata'
import type { ChannelMetadata, MetadataDiagnostic } from '../core/twitchMetadata'

/**
 * Public Twitch metadata, fetched once for everybody who wants it.
 *
 * WHAT PROBLEM THIS ACTUALLY SOLVES
 *
 * Presence heartbeats land every 45 seconds and the panel re-renders on every
 * one of them. A naive implementation - a fetch effect per card - would turn
 * "three friends on Lirik" into a request per card per heartbeat per tab, for
 * data that changes every few minutes. So requests are driven by DISTINCT
 * DESTINATIONS and CACHE MISSES, and nothing else. A panel left open on an
 * unchanging map makes one request per channel every two minutes, whatever the
 * heartbeat is doing and however many tabs are open.
 *
 * WHERE IT SITS
 *
 * In the service worker, which already owns every other piece of shared state.
 * Content scripts never call it directly and React components never fetch: the
 * worker holds one cache, and every tab is served from it.
 *
 * ENRICHMENT, NEVER A DEPENDENCY
 *
 * Every failure path here ends in "return what we have", which may be nothing.
 * A channel with no metadata renders exactly as it did before this file
 * existed. There is no error state that reaches the panel, because there is no
 * error a user could act on.
 */

export interface MetadataFetcher {
  /** Ask the backend about these logins. Rejects, or returns raw JSON. */
  fetch(logins: string[]): Promise<unknown>
}

export interface MetadataServiceDeps {
  fetcher: MetadataFetcher
  /** Persisted across worker restarts, so a wake-up is not a cold cache. */
  load?: () => Promise<Record<string, unknown> | null>
  save?: (records: Record<string, ChannelMetadata>) => void
  /** Something changed and the panel should be told. */
  onChange?: () => void
  now?: () => number
  /** How often a live record is refetched. */
  ttlMs?: number
  /**
   * Every step of a request, so a silent failure cannot happen twice.
   *
   * Codes and counts only - never a token, never a header, never a message
   * from an exception. The worker decides whether to print them; see
   * background/index.ts, where they are gated to non-production builds.
   */
  onDiagnostic?: (
    diagnostic: MetadataDiagnostic,
    detail: { channels: number; codes?: string[] },
  ) => void
  onError?: (context: string, error: unknown) => void
}

export interface MetadataService {
  /**
   * Declare the channels currently worth knowing about.
   *
   * Idempotent and cheap: safe to call on every render, every heartbeat and
   * every state broadcast. It fetches only what is missing or expired.
   */
  want(channels: readonly string[]): void
  /** Everything currently known, for the broadcast state. */
  snapshot(): Record<string, ChannelMetadata>
  hydrate(): Promise<void>
  /** Forget everything. Sign-out, or a different account. */
  reset(): void
  /** For tests and diagnostics. */
  pending(): number
  /** Whether a fetch is open for this channel right now. Diagnostics only. */
  inFlight(channel: string): boolean
  /**
   * Every channel with a fetch open right now.
   *
   * Broadcast to the panel so a destination that is ARRIVING can be told
   * apart from one that will never arrive - the difference between waiting a
   * moment and rendering a card with nothing on it.
   */
  inFlightChannels(): string[]
}

/**
 * How long the whole cache may sit untouched before it is dropped.
 *
 * A worker that wakes after a day should not open the panel showing yesterday
 * evening's viewer counts while it refetches. Identity would still be fine;
 * the live half would be a lie for as long as the request takes.
 */
const MAX_AGE_MS = 24 * 60 * 60_000

/** Never ask for more in one request than the endpoint accepts. */
const MAX_PER_REQUEST = 100

export function createMetadataService(deps: MetadataServiceDeps): MetadataService {
  const now = deps.now ?? (() => Date.now())
  const ttl = deps.ttlMs ?? LIVE_TTL_MS

  let records: Record<string, ChannelMetadata> = {}

  /**
   * Channels a request is currently in flight for.
   *
   * This is the dedupe. Two tabs asking about Lirik half a second apart, or
   * one tab asking again because presence ticked, must not become two
   * requests - and must not become a request that starts while the first is
   * still open, which is the stampede this prevents.
   */
  const inFlight = new Set<string>()

  function changed(): void {
    deps.save?.(records)
    deps.onChange?.()
  }

  async function request(logins: string[]): Promise<void> {
    for (const login of logins) inFlight.add(login)

    try {
      const payload = await deps.fetcher.fetch(logins)
      const codes = parseDiagnostics(payload)
      if (codes.length > 0) deps.onDiagnostic?.('backend', { channels: logins.length, codes })

      const parsed = parseMetadataResponse(payload, now())
      if (parsed.length === 0) {
        /*
         * The call succeeded and produced nothing usable.
         *
         * Distinct from a failed call, and the distinction matters: this is
         * what a deployed-but-broken backend looks like, and it is exactly the
         * state that went unnoticed for a whole checkpoint.
         */
        deps.onDiagnostic?.('rejected', { channels: logins.length })
        return
      }

      const next = { ...records }
      for (const record of parsed) next[record.login] = record
      records = next
      deps.onDiagnostic?.('stored', { channels: parsed.length })
      changed()
    } catch (error) {
      /*
       * Nothing is written and nothing is cleared.
       *
       * A failed refresh must not turn a channel we knew was live into one we
       * claim is offline - the stale record keeps being shown until it ages
       * past the tolerance, at which point liveStateOf downgrades it to
       * `unknown` on its own. Failure degrades toward "we do not know", never
       * toward a wrong answer.
       */
      deps.onDiagnostic?.('failed', { channels: logins.length })
      deps.onError?.('metadata.fetch', error)
    } finally {
      for (const login of logins) inFlight.delete(login)
    }
  }

  return {
    want(channels): void {
      const wanted = normalizeLogins(channels)
      if (wanted.length === 0) return

      const stale = wanted.filter(
        (login) => !inFlight.has(login) && needsRefresh(records[login], now(), ttl),
      )
      if (stale.length === 0) {
        deps.onDiagnostic?.('fresh', { channels: wanted.length })
        return
      }

      deps.onDiagnostic?.('requested', { channels: stale.length })

      // Batched, because one request for ten channels is the whole point.
      for (let index = 0; index < stale.length; index += MAX_PER_REQUEST) {
        void request(stale.slice(index, index + MAX_PER_REQUEST))
      }
    },

    snapshot: () => records,

    async hydrate(): Promise<void> {
      try {
        const stored = await deps.load?.()
        if (!stored || typeof stored !== 'object') return

        const at = now()
        const restored: Record<string, ChannelMetadata> = {}
        for (const record of parseMetadataResponse({ channels: Object.values(stored) }, at)) {
          // Anything older than a day is not worth restoring: it would be
          // shown for the moment before the refresh lands, and being briefly
          // wrong is worse than being briefly plain.
          if (at - record.fetchedAt > MAX_AGE_MS) continue
          restored[record.login] = record
        }
        records = restored
        if (Object.keys(restored).length > 0) deps.onChange?.()
      } catch (error) {
        deps.onError?.('metadata.hydrate', error)
      }
    },

    reset(): void {
      records = {}
      inFlight.clear()
      changed()
    },

    pending: () => inFlight.size,

    inFlight: (channel: string) => inFlight.has(channel.trim().toLowerCase()),

    inFlightChannels: () => [...inFlight],
  }
}

export type { ChannelMetadata }
/** Exported so tests can reason about the same numbers the service uses. */
export const METADATA_MAX_AGE_MS = MAX_AGE_MS
export const METADATA_MAX_PER_REQUEST = MAX_PER_REQUEST
