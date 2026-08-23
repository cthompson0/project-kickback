import { BARE_NAME, EMOTES, emoteKey, externalToken } from '../core/emotes'
import type { Emote } from '../core/emotes'
import type { SevenTvClient } from './sevenTv'

/**
 * What emotes are available to the person typing, right now.
 *
 * Composed of three layers, in the order a typed name resolves:
 *
 *   1. Kickback built-ins   - always present, fixed ids
 *   2. 7TV channel set      - for the Twitch channel THIS user is watching
 *   3. 7TV global set       - always present once fetched
 *
 * A group can contain people watching different channels. Rather than union
 * everyone's sets - which would be surprising, unbounded, and would leak what
 * other members are watching - the composer offers the CURRENT USER'S channel.
 * Once sent, a message carries stable ids, so what the recipient can see makes
 * no difference to what they render.
 *
 * The catalog lives in the worker. The picker asks it to search rather than
 * receiving a thousand emotes, which keeps both the message channel and the
 * DOM small.
 */

export const CHANNEL_CACHE_TTL_MS = 30 * 60_000
export const GLOBAL_CACHE_TTL_MS = 6 * 60 * 60_000
/** Enough for a picker page; never the whole set. */
export const SEARCH_LIMIT = 60

export interface EmoteCatalogDeps {
  client: SevenTvClient
  now?: () => number
  onError?: (context: string, error: unknown) => void
}

export interface EmoteSection {
  title: string
  emotes: Emote[]
}

export interface EmoteCatalog {
  /** Point the catalog at the channel the user is watching. */
  setChannel(channel: string | null): void
  getChannel(): string | null
  /** Sections for the picker, already limited. */
  search(query: string): EmoteSection[]
  /**
   * Rewrites bare emote names in outgoing text into stable tokens.
   * Done once, at send time, so the message records what was meant.
   */
  resolveOutgoing(body: string): string
  /** For diagnostics and tests. */
  size(): { channel: number; global: number }
}

interface CachedSet {
  emotes: Emote[]
  fetchedAt: number
}

export function createEmoteCatalog(deps: EmoteCatalogDeps): EmoteCatalog {
  const now = deps.now ?? (() => Date.now())

  let channel: string | null = null
  let channelSet: CachedSet | null = null
  let globalSet: CachedSet | null = null
  /** Cheap memo so hopping back to a channel does not refetch. */
  const channelCache = new Map<string, CachedSet>()
  let loading: string | null = null
  let loadingGlobal = false

  function fresh(entry: CachedSet | null, ttl: number): boolean {
    return entry !== null && now() - entry.fetchedAt < ttl
  }

  async function loadGlobal(): Promise<void> {
    if (fresh(globalSet, GLOBAL_CACHE_TTL_MS)) return
    // setChannel runs on every activity push, so without this a burst of
    // navigation would fire a burst of identical requests at 7TV.
    if (loadingGlobal) return
    loadingGlobal = true

    try {
      const emotes = await deps.client.globalEmotes()
      // Keep a stale set rather than emptying the picker on a failed refresh.
      if (emotes.length > 0 || globalSet === null) {
        globalSet = { emotes, fetchedAt: now() }
      }
    } catch (error) {
      deps.onError?.('emoteCatalog.loadGlobal', error)
    } finally {
      loadingGlobal = false
    }
  }

  async function loadChannel(target: string): Promise<void> {
    const cached = channelCache.get(target)
    if (fresh(cached ?? null, CHANNEL_CACHE_TTL_MS)) {
      if (channel === target) channelSet = cached ?? null
      return
    }
    if (loading === target) return
    loading = target

    try {
      const twitchId = await deps.client.resolveTwitchId(target)
      const emotes = twitchId ? await deps.client.channelEmotes(twitchId) : []
      const entry = { emotes, fetchedAt: now() }
      channelCache.set(target, entry)
      // The user may have navigated on while this was in flight.
      if (channel === target) channelSet = entry
    } catch (error) {
      deps.onError?.('emoteCatalog.loadChannel', error)
    } finally {
      if (loading === target) loading = null
    }
  }

  /** Channel first, then global: a channel's own emote wins its name. */
  function externalOrdered(): Emote[] {
    return [...(channelSet?.emotes ?? []), ...(globalSet?.emotes ?? [])]
  }

  return {
    setChannel(next: string | null): void {
      const target = next?.toLowerCase() ?? null

      // Globals need no channel, so they load on the first call whatever it
      // says - otherwise the picker would be built-ins only until the user
      // happened to open a channel page.
      void loadGlobal()

      if (target === channel) return

      channel = target
      // Drop the previous channel's set immediately: one channel's emotes must
      // not linger as if they were the next channel's.
      channelSet = target ? (channelCache.get(target) ?? null) : null

      if (target) void loadChannel(target)
    },

    getChannel: () => channel,

    search(query: string): EmoteSection[] {
      const term = query.trim().toLowerCase()
      const match = (emote: Emote) => !term || emote.name.toLowerCase().includes(term)

      const kickback = EMOTES.filter(match)
      const channelEmotes = (channelSet?.emotes ?? []).filter(match).slice(0, SEARCH_LIMIT)
      const globalEmotes = (globalSet?.emotes ?? [])
        .filter(match)
        // A global emote the channel already overrides would be a duplicate row.
        .filter((emote) => !channelEmotes.some((other) => other.name === emote.name))
        .slice(0, SEARCH_LIMIT)

      const sections: EmoteSection[] = []
      if (kickback.length) sections.push({ title: 'Kickback', emotes: kickback })
      if (channelEmotes.length) {
        sections.push({ title: channel ? `7TV · ${channel}` : '7TV channel', emotes: channelEmotes })
      }
      if (globalEmotes.length) sections.push({ title: '7TV global', emotes: globalEmotes })
      return sections
    },

    resolveOutgoing(body: string): string {
      const available = externalOrdered()
      if (available.length === 0) return body

      // Exact, case-sensitive, whole-word only. Twitch and 7TV names are
      // case-sensitive by convention, and matching loosely would turn ordinary
      // words into emotes - the surprising behaviour we want to avoid.
      const byName = new Map<string, Emote>()
      for (const emote of available) {
        if (!byName.has(emote.name)) byName.set(emote.name, emote)
      }

      return body
        .split(/(\s+)/)
        .map((part) => {
          if (!BARE_NAME.test(part)) return part
          const emote = byName.get(part)
          return emote ? externalToken(emote) : part
        })
        .join('')
    },

    size: () => ({
      channel: channelSet?.emotes.length ?? 0,
      global: globalSet?.emotes.length ?? 0,
    }),
  }
}

/** Exported for tests: the identity two emotes must share to combo. */
export { emoteKey }
