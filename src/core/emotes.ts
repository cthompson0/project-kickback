/**
 * Kickback's own emotes.
 *
 * Deliberately original: no 7TV, BTTV, FFZ or Twitch subscriber emotes, and no
 * user-supplied image URLs. A message can only ever reference a token from
 * this fixed table, so rendering is deterministic and there is no way to point
 * chat at an arbitrary remote image.
 *
 * The set is small on purpose - enough personality for a beta friend group,
 * not a catalogue. `EmoteId` is a closed union so an unknown token simply
 * stays text.
 */

export type EmoteId =
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

export interface Emote {
  id: EmoteId
  /** What people type: :lol: */
  token: string
  /** Shown in the picker and read by screen readers. */
  label: string
}

export const EMOTES: Emote[] = [
  { id: 'lol', token: ':lol:', label: 'Crying laughing' },
  { id: 'pog', token: ':pog:', label: 'Hype' },
  { id: 'sad', token: ':sad:', label: 'Sad' },
  { id: 'fire', token: ':fire:', label: 'Fire' },
  { id: 'heart', token: ':heart:', label: 'Heart' },
  { id: 'eyes', token: ':eyes:', label: 'Eyes' },
  { id: 'gg', token: ':gg:', label: 'GG' },
  { id: 'oof', token: ':oof:', label: 'Oof' },
  { id: 'clap', token: ':clap:', label: 'Clap' },
  { id: 'sus', token: ':sus:', label: 'Suspicious' },
]

const BY_TOKEN = new Map(EMOTES.map((emote) => [emote.token, emote]))

/** Matches any :token: shape; membership is checked against the table. */
const TOKEN_PATTERN = /:[a-z]{2,12}:/g

export type MessageSegment =
  | { type: 'text'; text: string }
  | { type: 'emote'; emote: Emote }

/**
 * Splits a message body into text and emote segments.
 *
 * Unrecognised tokens stay as text - they are never resolved to anything, so a
 * message cannot conjure an emote that does not exist.
 */
export function parseMessage(body: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  let lastIndex = 0

  for (const match of body.matchAll(TOKEN_PATTERN)) {
    const emote = BY_TOKEN.get(match[0])
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
 * This is the qualification rule for combos: "OMEGALUL" alone counts, but
 * "OMEGALUL lol" or two different emotes do not. Keeping it strict is what
 * makes a combo feel like a chant rather than a coincidence.
 */
export function soleEmote(body: string): Emote | null {
  const segments = parseMessage(body.trim())
  if (segments.length === 0) return null

  const emotes = segments.filter((segment) => segment.type === 'emote')
  const text = segments.filter((segment) => segment.type === 'text')

  // Whitespace between repeats is fine; anything else disqualifies.
  if (text.some((segment) => segment.text.trim().length > 0)) return null
  if (emotes.length === 0) return null

  const first = emotes[0].emote
  if (!emotes.every((segment) => segment.emote.id === first.id)) return null

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
