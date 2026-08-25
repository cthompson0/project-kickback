import { useEffect, useMemo, useRef, useState } from 'react'
import { EMOTES, isEmoteOnly, parseMessage } from '../../core/emotes'
import type { ActiveCombo, ComboAnnotation } from '../../core/combos'
import type { KickbackClient } from '../../client/types'
import type { User } from '../../core/types'
import type { Presence } from '../../core/types'
import { EmoteImage } from './EmoteImage'
import { EmotePicker } from './EmotePicker'
import { UserCard } from './UserCard'
import type { UserCardContext } from './UserCard'

/**
 * The parts of a conversation that are the same wherever one happens.
 *
 * Extracted from GroupChat when Stream Rooms grew text. The two surfaces share
 * everything about HOW a conversation looks and nothing about what a
 * conversation IS: a group is intentional and durable, a stream session is
 * derived and ephemeral, and the day one of them needs different persistence
 * it must not be able to reach the other through here.
 *
 * So these components take messages, not a group id; a send callback, not a
 * client method; and they know nothing about membership. Everything that
 * differs stays with the caller.
 *
 * Message bodies are rendered as React text nodes and emote components - never
 * as markup - so a message containing HTML is just a message containing HTML.
 */

/** The least a message can be and still be rendered. */
export interface DisplayMessage {
  id: string
  userId: string
  displayName: string
  avatarUrl: string | null
  body: string
}

export function MessageBody({ body }: { body: string }) {
  const segments = useMemo(() => parseMessage(body), [body])
  const big = useMemo(() => isEmoteOnly(body), [body])

  return (
    <span className={`kb-msg-body${big ? ' kb-msg-body-big' : ''}`}>
      {segments.map((segment, index) =>
        segment.type === 'emote' ? (
          <EmoteImage key={index} emote={segment.emote} size={big ? 28 : 18} />
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </span>
  )
}

/** The run currently building, anchored above the composer. */
export function ActiveComboBar({ combo }: { combo: ActiveCombo }) {
  return (
    <div
      className="kb-combo-active"
      // Keyed by the caller when the run changes, so a new combo animates in
      // rather than silently swapping the artwork of the old one.
      aria-live="polite"
    >
      <EmoteImage emote={combo.emote} size={20} />
      <span className="kb-combo-active-name">{combo.emote.name}</span>
      <span className="kb-combo-active-count">×{combo.count}</span>
    </div>
  )
}

export function ComboBadge({ annotation }: { annotation: ComboAnnotation }) {
  if (!annotation.comboCount || !annotation.comboEmote) return null
  return (
    <span className="kb-combo" title={`${annotation.comboEmote.name} combo`}>
      ×{annotation.comboCount}
    </span>
  )
}

/**
 * The log.
 *
 * Identity opens the same UserCard it opens everywhere else, which is what
 * makes meeting somebody in a room the start of a friendship rather than a
 * dead end. `lookup` lets the caller supply richer presence for people it
 * knows; a sender it cannot resolve still renders, because a message from
 * somebody who has since left is still a real message.
 */
export function MessageList({
  messages,
  annotations,
  selfId,
  client,
  cardContext,
  lookup,
  empty,
}: {
  messages: readonly DisplayMessage[]
  annotations: Map<string, ComboAnnotation>
  selfId: string | null
  client: KickbackClient
  cardContext: UserCardContext
  lookup?: (userId: string) => { user: User; presence: Presence | null } | undefined
  empty: string
}) {
  const [openCardFor, setOpenCardFor] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  // Follow the conversation as it arrives.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  return (
    <div className="kb-chat-log">
      {messages.length === 0 && <div className="kb-quiet-sub kb-chat-empty">{empty}</div>}

      {messages.map((message) => {
        const annotation = annotations.get(message.id)
        const known = lookup?.(message.userId)

        return (
          <div key={message.id} className="kb-msg">
            <div className="kb-msg-head">
              {/*
                * A span, not a button, and that is load-bearing.
                *
                * `<button>` cannot be `display: inline`: Chrome coerces it to
                * inline-block, because a button may not be split across lines.
                * That makes the sender name an ATOMIC inline box, and the
                * line-breaking after an atomic box differs - a message whose
                * first unbreakable run does not fit in the space left on the
                * line starts a fresh line instead of filling it, so the
                * message reads as its own block under the name.
                *
                * A span with role="button" is a genuine inline box, so the
                * name is a word in the sentence again, and is still a control
                * for anyone using a keyboard or a screen reader.
                */}
              <span
                role="button"
                tabIndex={0}
                className={`kb-msg-who kb-msg-who-btn${
                  message.userId === selfId ? ' kb-msg-who-self' : ''
                }`}
                title={`About ${message.displayName}`}
                onClick={() => setOpenCardFor((open) => (open === message.id ? null : message.id))}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  setOpenCardFor((open) => (open === message.id ? null : message.id))
                }}
              >
                {/* The colon belongs to the sender label, so it lives inside
                    the identity: it copies with the name, and clicking it does
                    what clicking the name does.

                    It is not part of the NAME, though. The name carries the
                    sender's colour; the colon is structural punctuation and
                    takes the ordinary chat foreground, so a coloured name does
                    not bleed into the separator after it. */}
                {message.displayName}
                <span className="kb-msg-sep">:</span>
              </span>
              <MessageBody body={message.body} />
              {annotation && <ComboBadge annotation={annotation} />}
            </div>

            {openCardFor === message.id && (
              <UserCard
                user={
                  known?.user ?? {
                    id: message.userId,
                    // A sender we cannot resolve is still a real person with a
                    // real message; we just know less about them.
                    username: message.displayName,
                    displayName: message.displayName,
                    avatarUrl: message.avatarUrl,
                    accentColor: '#ff8452',
                  }
                }
                presence={known?.presence ?? null}
                client={client}
                context={cardContext}
                onClose={() => setOpenCardFor(null)}
              />
            )}

            {annotation?.brokeCombo && (
              <div className="kb-combo-broken">
                COMBO BROKEN BY {annotation.brokeCombo.by.toUpperCase()}
              </div>
            )}
          </div>
        )
      })}
      <div ref={endRef} />
    </div>
  )
}

/**
 * The composer.
 *
 * `maxLength` is a parameter rather than a constant because the two surfaces
 * genuinely differ: a group message is 500, and a room message is 280 because
 * it is something you say during a play and because 51 copies of it are
 * written per send. The server enforces both; this stops you before the round
 * trip rather than after it.
 */
export function Composer({
  client,
  maxLength,
  placeholder,
  onSend,
}: {
  client: KickbackClient
  maxLength: number
  placeholder: string
  /** Resolves when accepted, rejects with something worth showing. */
  onSend: (body: string) => Promise<void>
}) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function send() {
    const body = draft.trim()
    if (!body || sending) return

    setSending(true)
    setError(null)
    try {
      await onSend(body)
      setDraft('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Message not sent.')
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  return (
    <>
      {error && <div className="kb-inline-note">{error}</div>}

      {pickerOpen && (
        <EmotePicker
          client={client}
          onPick={(text) => {
            setDraft((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}${text} `)
            // The picker stays open: picking several emotes in a row is the
            // normal case, and reopening it each time would be tedious.
            inputRef.current?.focus()
          }}
        />
      )}

      <div className="kb-composer">
        <button
          type="button"
          className={`kb-emote-toggle${pickerOpen ? ' kb-emote-toggle-open' : ''}`}
          title="Emotes"
          onClick={() => setPickerOpen((open) => !open)}
        >
          <EmoteImage emote={EMOTES[0]} size={16} />
        </button>
        <input
          ref={inputRef}
          className="kb-composer-input"
          value={draft}
          maxLength={maxLength}
          placeholder={placeholder}
          spellCheck
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <button
          type="button"
          className="kb-join kb-send"
          disabled={sending || draft.trim().length === 0}
          onClick={() => void send()}
        >
          {sending ? '…' : 'SEND'}
        </button>
      </div>
    </>
  )
}
