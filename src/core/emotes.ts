/**
 * Kickback's unified emote model.
 *
 * Three things can render as an emote: Kickback's own built-ins, and (once a
 * provider is wired up) emotes from Twitch or 7TV. They are normalised to one
 * shape identified by `provider + id`, never by name - names collide across
 * providers, get renamed, and get removed from sets.
 *
 * MESSAGE FORMAT
 *
 * Two token forms appear in message bodies:
 *
 *   :lol:                       a Kickback built-in, whose id is fixed forever
 *   [[7tv|01FCY7...|OMEGALUL]]  an external emote, carrying its stable id
 *
 * The external form is written at SEND time, so a message records exactly which
 * emote was meant. That is what keeps old messages readable after an emote is
 * removed from a channel's set, and what stops two different emotes that happen
 * to share a name from being confused for one another.
 *
 * Everything here treats provider data as untrusted: ids and names are
 * validated against strict patterns, and an image URL is *derived* from an id
 * rather than taken from a provider payload.
 */

export type EmoteProvider = 'kickback' | 'twitch' | '7tv'

export interface Emote {
  provider: EmoteProvider
  /** Stable within the provider. Combos and history key on this. */
  id: string
  name: string
  animated: boolean
  /**
   * Where to draw it from, or null for a Kickback built-in, which is drawn as
   * inline SVG rather than fetched.
   */
  url: string | null
}

/** Identity for combos and de-duplication. Never the name, never the URL. */
export function emoteKey(emote: Emote): string {
  return `${emote.provider}:${emote.id}`
}

// ------------------------------------------------------------ built-ins

export type KickbackEmoteId =
  | 'lol'
  | 'pog'
  | 'sad'
  | 'fire'
  | 'heart'
  | 'eyes'
  | 'gg'
  | 'oof'
  | 'clap'
  | 'sus'

export interface KickbackEmote extends Emote {
  provider: 'kickback'
  id: KickbackEmoteId
  /** What people type: :lol: */
  token: string
  label: string
}

const builtIn = (id: KickbackEmoteId, label: string): KickbackEmote => ({
  provider: 'kickback',
  id,
  name: id,
  token: `:${id}:`,
  label,
  animated: false,
  url: null,
})

export const EMOTES: KickbackEmote[] = [
  builtIn('lol', 'Crying laughing'),
  builtIn('pog', 'Hype'),
  builtIn('sad', 'Sad'),
  builtIn('fire', 'Fire'),
  builtIn('heart', 'Heart'),
  builtIn('eyes', 'Eyes'),
  builtIn('gg', 'GG'),
  builtIn('oof', 'Oof'),
  builtIn('clap', 'Clap'),
  builtIn('sus', 'Suspicious'),
]

const BY_TOKEN = new Map(EMOTES.map((emote) => [emote.token, emote]))

export function isKickbackEmote(emote: Emote): emote is KickbackEmote {
  return emote.provider === 'kickback'
}

// ------------------------------------------------------- external emotes

/** 7TV ids are ULID-ish; Twitch emote ids are numeric or `emotesv2_...`. */
const EXTERNAL_ID = /^[A-Za-z0-9_]{1,64}$/
/** Provider emote names in practice: letters, digits, and a little punctuation. */
const EXTERNAL_NAME = /^[A-Za-z0-9_()!?:.-]{1,64}$/

/** The providers an image can actually be fetched from. */
export type ExternalProvider = Exclude<EmoteProvider, 'kickback'>

/**
 * Builds the image URL for an external emote from its id.
 *
 * Deliberately derived rather than carried: a provider payload never gets to
 * choose what host we load from, so a hostile or malformed response cannot
 * point chat at an arbitrary URL.
 *
 * This is also the single place a provider name is checked, which is why it
 * takes a plain string: anything that is not a provider we ship support for
 * gets no URL, and with no URL nothing downstream will render it.
 */
export function externalEmoteUrl(
  provider: string,
  id: string,
  size: '1x' | '2x' | '4x' = '2x',
): string | null {
  if (!EXTERNAL_ID.test(id)) return null
  switch (provider) {
    case '7tv':
      return `https://cdn.7tv.app/emote/${id}/${size}.webp`
    case 'twitch':
      // Reserved for when Twitch emotes are reachable; see the checkpoint report.
      return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/${
        size === '4x' ? '3.0' : size === '2x' ? '2.0' : '1.0'
      }`
    default:
      return null
  }
}

/** Writes the stable token a message body carries for an external emote. */
export function externalToken(emote: Emote): string {
  return `[[${emote.provider}|${emote.id}|${emote.name}]]`
}

const EXTERNAL_TOKEN = /\[\[([a-z0-9]{2,8})\|([A-Za-z0-9_]{1,64})\|([^|\]]{1,64})\]\]/g
const KICKBACK_TOKEN = /:[a-z]{2,12}:/g
/** Either form, scanned in one pass so ordering is preserved. */
const ANY_TOKEN = new RegExp(`${EXTERNAL_TOKEN.source}|${KICKBACK_TOKEN.source}`, 'g')

/** Parses one token occurrence, or null when it is not a real emote. */
function resolveToken(match: RegExpMatchArray): Emote | null {
  const [full, provider, id, name] = match

  if (provider === undefined) {
    return BY_TOKEN.get(full) ?? null
  }

  // Fail closed on anything that does not look exactly like we expect.
  if (!EXTERNAL_NAME.test(name)) return null

  // The URL builder is the one authority on both the provider and the id: it
  // returns nothing for a provider we do not ship, for `kickback` (which has
  // no image), or for an id that is not an id. Getting a URL back is therefore
  // proof the provider is a real external one.
  const url = externalEmoteUrl(provider, id)
  if (!url) return null

  return { provider: provider as ExternalProvider, id, name, url, animated: false }
}

export type MessageSegment =
  | { type: 'text'; text: string }
  | { type: 'emote'; emote: Emote }

/**
 * Splits a message body into text and emote segments.
 *
 * Anything that is not a recognised token stays text - a malformed or unknown
 * token is shown literally rather than resolved to something else.
 */
export function parseMessage(body: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  let lastIndex = 0

  for (const match of body.matchAll(ANY_TOKEN)) {
    const emote = resolveToken(match)
    if (!emote) continue

    const index = match.index ?? 0
    if (index > lastIndex) {
      segments.push({ type: 'text', text: body.slice(lastIndex, index) })
    }
    segments.push({ type: 'emote', emote })
    lastIndex = index + match[0].length
  }

  if (lastIndex < body.length) {
    segments.push({ type: 'text', text: body.slice(lastIndex) })
  }

  return segments
}

/**
 * The emote a message consists of, if it is nothing but that one emote.
 *
 * The qualification rule for combos: one emote alone counts, repeats of the
 * same emote count, anything else does not.
 */
export function soleEmote(body: string): Emote | null {
  const segments = parseMessage(body.trim())
  if (segments.length === 0) return null

  const emotes = segments.filter((segment) => segment.type === 'emote')
  const text = segments.filter((segment) => segment.type === 'text')

  if (text.some((segment) => segment.text.trim().length > 0)) return null
  if (emotes.length === 0) return null

  const first = emotes[0].emote
  const key = emoteKey(first)
  // Same key, not same name: two providers' "OMEGALUL" are different emotes.
  if (!emotes.every((segment) => emoteKey(segment.emote) === key)) return null

  return first
}

/** True when the whole message is emotes, so it can render larger. */
export function isEmoteOnly(body: string): boolean {
  const segments = parseMessage(body.trim())
  if (segments.length === 0) return false
  return (
    segments.some((segment) => segment.type === 'emote') &&
    segments.every((segment) => segment.type === 'emote' || segment.text.trim().length === 0)
  )
}

/** A bare word that could name an external emote, per provider conventions. */
export const BARE_NAME = /^[A-Za-z0-9_()!?:.-]{2,64}$/
