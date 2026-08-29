import { BARE_NAME, externalEmoteUrl } from '../core/emotes'
import type { Emote } from '../core/emotes'

/**
 * 7TV, via its public API. No credentials, no account, no token.
 *
 * Everything that comes back is untrusted. Emotes are accepted only if their
 * id and name match strict patterns, and the image URL is *derived* from the
 * validated id rather than read from the payload - so a hostile or malformed
 * response can never point chat at an arbitrary host. Anything unexpected is
 * dropped rather than rendered.
 *
 * Chat must work when 7TV does not, so every call here resolves to a result
 * rather than throwing, and an empty list is a perfectly good answer.
 */

export const SEVENTV_API = 'https://7tv.io/v3'

/** 7TV keys channels by numeric Twitch user id, but Watchside only knows the
 *  login from the URL. Their GraphQL search bridges the two, unauthenticated. */
const SEVENTV_GQL = `${SEVENTV_API}/gql`

const REQUEST_TIMEOUT_MS = 6_000

export interface SevenTvFetch {
  (url: string, init?: RequestInit): Promise<Response>
}

export interface SevenTvClient {
  /** Twitch login -> numeric Twitch user id, or null if 7TV does not know it. */
  resolveTwitchId(login: string): Promise<string | null>
  /** The channel's 7TV emote set. Empty when the channel has no set. */
  channelEmotes(twitchUserId: string): Promise<Emote[]>
  /** 7TV's global set, which needs no channel at all. */
  globalEmotes(): Promise<Emote[]>
}

/** Shape we hope for; every field is checked before use. */
interface RawEmote {
  id?: unknown
  name?: unknown
  data?: { animated?: unknown; name?: unknown }
}

/**
 * Normalises one 7TV entry, or drops it.
 *
 * The URL is built by us from the id. Note what is NOT used: `data.host.url`,
 * which is a provider-supplied host we would otherwise be trusting.
 */
export function toEmote(raw: RawEmote): Emote | null {
  if (typeof raw?.id !== 'string' || typeof raw?.name !== 'string') return null

  const name = raw.name
  if (!BARE_NAME.test(name)) return null

  const url = externalEmoteUrl('7tv', raw.id)
  if (!url) return null

  return {
    provider: '7tv',
    id: raw.id,
    name,
    animated: raw.data?.animated === true,
    url,
  }
}

export function normalizeEmoteSet(payload: unknown): Emote[] {
  const emotes = (payload as { emotes?: unknown })?.emotes
  if (!Array.isArray(emotes)) return []

  const seen = new Set<string>()
  const result: Emote[] = []
  for (const raw of emotes) {
    const emote = toEmote(raw as RawEmote)
    if (!emote || seen.has(emote.id)) continue
    seen.add(emote.id)
    result.push(emote)
  }
  return result
}

export function createSevenTvClient(
  fetchImpl: SevenTvFetch = fetch,
  onError?: (context: string, error: unknown) => void,
): SevenTvClient {
  async function getJson(url: string, init?: RequestInit): Promise<unknown | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal })
      if (!response.ok) return null
      return await response.json()
    } catch (error) {
      // A dead or slow provider is normal, not exceptional.
      onError?.('7tv.request', error)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async resolveTwitchId(login: string): Promise<string | null> {
      const clean = login.trim().toLowerCase()
      if (!/^[a-z0-9_]{1,25}$/.test(clean)) return null

      const payload = await getJson(SEVENTV_GQL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query:
            'query($query:String!){ users(query:$query){ connections { id platform username } } }',
          variables: { query: clean },
        }),
      })

      const users = (payload as { data?: { users?: unknown } })?.data?.users
      if (!Array.isArray(users)) return null

      // Search is fuzzy, so take only an exact Twitch login match.
      for (const user of users) {
        const connections = (user as { connections?: unknown })?.connections
        if (!Array.isArray(connections)) continue
        for (const connection of connections) {
          const entry = connection as { id?: unknown; platform?: unknown; username?: unknown }
          if (
            entry.platform === 'TWITCH' &&
            typeof entry.username === 'string' &&
            entry.username.toLowerCase() === clean &&
            typeof entry.id === 'string' &&
            /^[0-9]{1,20}$/.test(entry.id)
          ) {
            return entry.id
          }
        }
      }
      return null
    },

    async channelEmotes(twitchUserId: string): Promise<Emote[]> {
      if (!/^[0-9]{1,20}$/.test(twitchUserId)) return []
      const payload = await getJson(`${SEVENTV_API}/users/twitch/${twitchUserId}`)
      if (!payload) return []
      // A channel with no 7TV set is an ordinary outcome, not a failure.
      return normalizeEmoteSet((payload as { emote_set?: unknown }).emote_set)
    },

    async globalEmotes(): Promise<Emote[]> {
      const payload = await getJson(`${SEVENTV_API}/emote-sets/global`)
      if (!payload) return []
      return normalizeEmoteSet(payload)
    },
  }
}
