import { useEffect, useMemo, useRef, useState } from 'react'
import { EMOTES, isKickbackEmote } from '../../core/emotes'
import type { Emote } from '../../core/emotes'
import type { EmoteSection, KickbackClient } from '../../client/types'
import { EmoteImage } from './EmoteImage'

/**
 * The emote picker.
 *
 * The catalog lives in the worker, and the picker asks it for a *page* of
 * results rather than receiving every emote a channel has. A big 7TV channel
 * has well over a thousand; sending them all across the port and turning them
 * into DOM images would cost far more than the feature is worth. Searching
 * worker-side means the picker never holds more than a screenful.
 *
 * Built-ins are also rendered locally as a fallback section, so the picker is
 * never empty just because 7TV is unreachable.
 */

const DEBOUNCE_MS = 120

function insertion(emote: Emote): string {
  // Built-ins go in as their token, which is what the user would have typed.
  // External emotes go in as their bare name - readable in the composer, the
  // way it works in Twitch chat - and are rewritten to a stable token at send
  // time. If the channel changed before sending, the name simply stays text,
  // which is honest rather than silently resolving to a different emote.
  return isKickbackEmote(emote) ? emote.token : emote.name
}

export function EmotePicker({
  client,
  onPick,
}: {
  client: KickbackClient
  onPick: (text: string) => void
}) {
  const [query, setQuery] = useState('')
  const [sections, setSections] = useState<EmoteSection[] | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Only the built-ins, filtered locally: what the picker shows if the worker
  // never answers.
  const fallback = useMemo<EmoteSection[]>(() => {
    const term = query.trim().toLowerCase()
    const matches = EMOTES.filter((emote) => !term || emote.name.includes(term))
    return matches.length ? [{ title: 'Watchside', emotes: matches }] : []
  }, [query])

  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      client
        .searchEmotes(query)
        .then((result) => {
          if (live) setSections(result)
        })
        .catch(() => {
          if (live) setSections(null)
        })
    }, DEBOUNCE_MS)

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [client, query])

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  const shown = sections ?? fallback
  const empty = shown.every((section) => section.emotes.length === 0)

  return (
    <div className="kb-emote-picker">
      <input
        ref={searchRef}
        className="kb-emote-search"
        value={query}
        placeholder="Search emotes"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setQuery(event.target.value)}
      />

      <div className="kb-emote-scroll">
        {empty && <div className="kb-quiet-sub kb-emote-empty">No emotes match.</div>}

        {shown.map((section) =>
          section.emotes.length === 0 ? null : (
            <div key={section.title} className="kb-emote-section">
              <div className="kb-emote-section-title">{section.title}</div>
              <div className="kb-emote-grid">
                {section.emotes.map((emote) => (
                  <button
                    key={`${emote.provider}:${emote.id}`}
                    type="button"
                    className="kb-emote-btn"
                    title={isKickbackEmote(emote) ? emote.label : emote.name}
                    onClick={() => onPick(insertion(emote))}
                  >
                    <EmoteImage emote={emote} size={22} />
                  </button>
                ))}
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  )
}
