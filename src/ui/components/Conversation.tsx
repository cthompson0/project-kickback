import { useEffect, useMemo, useRef, useState } from 'react'
import { avatarTint } from '../avatarTint'
import { EMOTES, isEmoteOnly, parseMessage } from '../../core/emotes'
import type { ComboAnnotation } from '../../core/combos'
import type { Emote } from '../../core/emotes'
import type { KickbackClient } from '../../client/types'
import type { User } from '../../core/types'
import type { Presence } from '../../core/types'
import { EmoteImage } from './EmoteImage'
import { EmotePicker } from './EmotePicker'
import { UserCard } from './UserCard'
import type { DisplayedBadge } from '../../background/supabaseBackend'
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

/**
 * The run currently building, anchored above the composer.
 *
 * Takes the emote and the count rather than a whole ActiveCombo, because the
 * two surfaces derive "currently" differently and both are right: a group
 * conversation has no clock, so its run is the trailing one in the log, while
 * a stream session shows what is happening in the last few seconds. Narrowing
 * the parameter is what lets them share the rendering without sharing a
 * definition of now.
 */
export function ActiveComboBar({ combo }: { combo: { emote: Emote; count: number } }) {
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
 * How close to the bottom still counts as being at the bottom.
 *
 * Not zero: a fractional scroll position, a half-pixel device ratio or a font
 * that measures differently after loading all leave a few pixels behind, and a
 * strict comparison would silently stop following for reasons the user cannot
 * see or fix. Roughly one line of chat.
 */
const NEAR_BOTTOM_PX = 48

/**
 * The log.
 *
 * Identity opens the same UserCard it opens everywhere else, which is what
 * makes meeting somebody in a room the start of a friendship rather than a
 * dead end. `lookup` lets the caller supply richer presence for people it
 * knows; a sender it cannot resolve still renders, because a message from
 * somebody who has since left is still a real message.
 *
 * TWO THINGS THIS COMPONENT OWNS FOR BOTH SURFACES
 *
 * The viewer is called "You" here rather than by the caller, and a sender's
 * colour is derived here rather than by the caller, because both are facts
 * about a message list and neither is a fact about a group or a room. They
 * used to live in StreamSession, so group chat quietly disagreed with the room
 * about the viewer's own name.
 */
export function MessageList({
  messages,
  annotations,
  selfId,
  client,
  cardContext,
  lookup,
  badges,
  empty,
}: {
  messages: readonly DisplayMessage[]
  annotations: Map<string, ComboAnnotation>
  selfId: string | null
  client: KickbackClient
  cardContext: UserCardContext
  lookup?: (userId: string) => { user: User; presence: Presence | null } | undefined
  /**
   * The badge each person chose to show, keyed by user id.
   *
   * Chat is where a person's Kickback identity is most often read, so it is
   * where an equipped badge belongs. Optional and empty by default, so a
   * caller that does not have the projection - or a database without 0027 -
   * renders exactly the chat it rendered before badges existed.
   */
  badges?: Readonly<Record<string, DisplayedBadge>>
  empty: string
}) {
  const [openCardFor, setOpenCardFor] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  /*
   * FOLLOWING THE CONVERSATION
   *
   * This used to be one line - scrollIntoView on an end marker, keyed on
   * `messages.length` - and it was wrong in four separate ways. The buffers
   * are capped (60 for a group, 200 for a room), so once a conversation is
   * full the length never changes again and the effect simply stopped running
   * forever. It also yanked somebody who had scrolled up to re-read, it
   * scrolled every scrollable ancestor including Twitch's own page, and it ran
   * before emotes and avatars had loaded and grown the content.
   *
   * See docs/reports/friends-beta-investigation-2026-08-27.md §3.
   *
   * WHY THE ANCHOR IS A REF AND A STATE
   *
   * The effect needs the freshest value without re-running when it changes;
   * the affordance needs a render when it changes. So the ref is the truth and
   * the state is the render trigger, and both are written from the scroll
   * handler - an event, where setState is allowed - never from an effect.
   */
  const lastId = messages.length > 0 ? messages[messages.length - 1].id : null
  const anchoredRef = useRef(true)
  const [anchored, setAnchored] = useState(true)
  /**
   * The newest message the viewer had seen when they last left the bottom.
   *
   * State rather than a ref because the render reads it, and it is only ever
   * written from an event - the scroll handler and the jump control - because
   * writing state from an effect is both forbidden here and the wrong shape:
   * this is a record of something the PERSON did.
   *
   * It starts at whatever is on screen, since a fresh list opens at the
   * bottom, and it advances on any scroll that leaves the viewer caught up -
   * including the one that carries them away, whose value is exactly "the last
   * thing they saw before they went looking".
   */
  const [seenBottom, setSeenBottom] = useState<string | null>(lastId)

  const toBottom = () => {
    const log = logRef.current
    if (!log) return
    // The container itself, not scrollIntoView: an ancestor walk is how the
    // old implementation could move Twitch's page underneath the panel.
    log.scrollTop = log.scrollHeight
  }

  // Keyed on the newest message's IDENTITY, which keeps changing after the
  // buffer stops growing. That is the whole fix.
  useEffect(() => {
    if (!anchoredRef.current) return
    toBottom()
  }, [lastId])

  /*
   * Emotes and avatars finish loading after the effect above has run and make
   * the log taller, which would leave a follower a little short of the bottom.
   * `load` does not bubble, so this listens in the capture phase.
   */
  useEffect(() => {
    const log = logRef.current
    if (!log) return
    const settle = () => {
      if (anchoredRef.current) toBottom()
    }
    log.addEventListener('load', settle, true)
    return () => log.removeEventListener('load', settle, true)
  }, [])

  const onScroll = () => {
    const log = logRef.current
    if (!log) return
    const near = log.scrollHeight - log.scrollTop - log.clientHeight <= NEAR_BOTTOM_PX
    const wasNear = anchoredRef.current
    anchoredRef.current = near
    // Caught up, or in the act of leaving. Not while already away - that is
    // the whole interval the affordance is counting.
    if (near || wasNear) setSeenBottom(lastId)
    setAnchored(near)
  }

  const resume = () => {
    anchoredRef.current = true
    setAnchored(true)
    setSeenBottom(lastId)
    toBottom()
  }

  /*
   * Something arrived while they were reading further up.
   *
   * Derived rather than stored: storing it would mean setting state from the
   * arrival effect, and the render already happens because `messages` changed.
   */
  const hasNew = !anchored && lastId !== null && lastId !== seenBottom

  return (
    <>
    <div className="kb-chat-log" ref={logRef} onScroll={onScroll}>
      {messages.length === 0 && <div className="kb-quiet-sub kb-chat-empty">{empty}</div>}

      {messages.map((message) => {
        const annotation = annotations.get(message.id)
        const known = lookup?.(message.userId)
        const isSelf = message.userId === selfId
        /*
         * The viewer is "You", in every conversation.
         *
         * Here rather than in the caller: the room used to substitute this
         * itself and group chat did not, so the same person read as "You" in
         * one place and as their Twitch name in the other.
         */
        const label = isSelf ? 'You' : message.displayName
        /*
         * A stable colour per person, from the same function that tints an
         * avatar with no picture - so somebody's name in chat matches their
         * face above it. Deterministic from the user id, so every viewer on
         * every device sees the same colour without anything being stored.
         *
         * Self is left alone: it keeps --kb-here from the stylesheet, which is
         * what makes your own messages findable at a glance.
         */
        const tint = isSelf ? undefined : avatarTint(message.userId)

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
                className={`kb-msg-who kb-msg-who-btn${isSelf ? ' kb-msg-who-self' : ''}`}
                style={tint ? { color: tint } : undefined}
                // Reads the label, so both surfaces say the same thing about
                // the same person - including the viewer.
                title={isSelf ? 'About you' : `About ${message.displayName}`}
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
                {label}
                <span className="kb-msg-sep">:</span>
              </span>
              {/*
                * The sender's chosen badge, if they are showing one.
                *
                * After the name and outside the identity control, so it does
                * not become part of the text that copies with a name and does
                * not widen the click target. One badge, no hover card, no
                * rarity - a chip and nothing else.
                *
                * Title says who issued it, because Kickback must never look
                * like it granted somebody a Twitch badge.
                */}
              {badges?.[message.userId] && (
                <span
                  className="kb-msg-badge"
                  title={`${badges[message.userId].name} — Kickback badge`}
                  aria-label={`${badges[message.userId].name}, a Kickback badge`}
                >
                  {badges[message.userId].icon}
                </span>
              )}
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
    </div>

    {/*
      * Only while they are actually missing something.
      *
      * Not a permanent scroll-to-bottom button: a control that is always there
      * is furniture, and one that appears exactly when it has a job to do says
      * what it is for without a label explaining it.
      */}
    {hasNew && (
      <button type="button" className="kb-chat-jump" onClick={resume} aria-live="polite">
        New messages ↓
      </button>
    )}
    </>
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
