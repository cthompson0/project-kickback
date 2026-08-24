import { useEffect, useMemo, useRef, useState } from 'react'
import { EMOTES, isEmoteOnly, parseMessage } from '../../core/emotes'
import { scanCombos } from '../../core/combos'
import { emoteKey } from '../../core/emotes'
import { useAnalytics } from '../Analytics'
import type { ActiveCombo, ComboAnnotation } from '../../core/combos'
import type { ChatMessage, KickbackClient } from '../../client/types'
import { EmoteImage } from './EmoteImage'
import { EmotePicker } from './EmotePicker'
import { UserCard } from './UserCard'
import type { UserCardContext } from './UserCard'
import type { GroupMember } from '../../client/types'

/**
 * Group chat.
 *
 * Message bodies are rendered as React text nodes and emote components - never
 * as markup - so a message containing HTML is just a message containing HTML.
 * Combos are derived from the ordered list on every render, which is why every
 * client agrees without a shared counter.
 */

const MAX_LENGTH = 500

/** Stable identity, so an omitted roster does not invalidate memos each render. */
const NO_MEMBERS: GroupMember[] = []

function MessageBody({ body }: { body: string }) {
  const segments = useMemo(() => parseMessage(body), [body])
  const big = useMemo(() => isEmoteOnly(body), [body])

  return (
    <span className={big ? 'kb-msg-body kb-msg-body-big' : 'kb-msg-body'}>
      {segments.map((segment, index) =>
        segment.type === 'emote' ? (
          <EmoteImage key={index} emote={segment.emote} size={big ? 30 : 17} />
        ) : (
          // A plain text node: markup in a message stays visible as text.
          <span key={index}>{segment.text}</span>
        ),
      )}
    </span>
  )
}

/**
 * The combo that is running right now, anchored just above the composer.
 *
 * It sits outside the scrolling log deliberately: a chant is a thing happening
 * *now*, and having to scroll to find out how it is going defeats the point.
 * Nothing here is stored - it is the run left open at the end of the ordered
 * messages, so every member of the group sees the same number without a
 * counter that could drift.
 */
function ActiveComboBar({ combo }: { combo: ActiveCombo }) {
  return (
    <div
      className="kb-combo-active"
      // The count changes in place rather than the row being replaced, so it
      // reads as one thing growing.
      key={`${combo.emote.provider}:${combo.emote.id}`}
      aria-live="polite"
    >
      <EmoteImage emote={combo.emote} size={20} />
      <span className="kb-combo-active-name">{combo.emote.name}</span>
      <span className="kb-combo-active-count">×{combo.count}</span>
    </div>
  )
}

function ComboBadge({ annotation }: { annotation: ComboAnnotation }) {
  if (annotation.comboCount && annotation.comboEmote) {
    return (
      <span className="kb-combo" title={`${annotation.comboEmote.name} combo`}>
        <EmoteImage emote={annotation.comboEmote} size={14} />×{annotation.comboCount}
      </span>
    )
  }
  return null
}

export function GroupChat({
  groupId,
  messages,
  selfId,
  client,
  members = NO_MEMBERS,
  cardContext,
}: {
  groupId: string
  messages: ChatMessage[]
  selfId: string | null
  client: KickbackClient
  /** The roster, so a sender's card shows the same presence as everywhere. */
  members?: GroupMember[]
  /**
   * The same context every other card gets.
   *
   * Required: this call site is exactly the one that used to omit the viewer's
   * activity, so a card opened from chat offered a JOIN to the stream the
   * viewer was already watching.
   */
  cardContext: UserCardContext
}) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  /** Which message's sender card is open, keyed by message so it anchors. */
  const [openCardFor, setOpenCardFor] = useState<string | null>(null)
  const analytics = useAnalytics()

  // The sender's card must show the same presence the cluster and the member
  // list show, so it reads the same roster rather than anything chat-local.
  const byUserId = useMemo(
    () => new Map(members.map((member) => [member.user.id, member])),
    [members],
  )
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const { annotations, active } = useMemo(
    () =>
      scanCombos(
        messages.map((message) => ({
          id: message.id,
          userId: message.userId,
          displayName: message.displayName,
          body: message.body,
        })),
      ),
    [messages],
  )

  // Follow the conversation as it arrives.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  /*
   * Combos, recorded once each.
   *
   * Combos are DERIVED from the message list on every render, which is what
   * makes every client agree about them - and what makes them easy to
   * over-report. The counter growing from two to five is one combo, not four,
   * and opening a group with an hour of history in it is not a combo forming
   * now. So both of these are transitions, not states.
   *
   * The emote alone identifies the run: a combo of a different emote is a
   * different combo, and the same emote combo'd twice is separated by the null
   * in between, which resets the marker.
   */
  const activeKey = active ? emoteKey(active.emote) : null
  const activeCount = active?.count ?? 0
  const reportedComboRef = useRef<string | null>(null)

  useEffect(() => {
    if (!activeKey) {
      reportedComboRef.current = null
      return
    }
    if (reportedComboRef.current === activeKey) return
    reportedComboRef.current = activeKey
    analytics.track('combo_formed', { count: activeCount }, { source: 'group' })
  }, [activeKey, activeCount, analytics])

  /**
   * Breaks already on screen when this opened are history, not news.
   *
   * Seeded on the first pass without emitting, so scrolling back through an
   * old conversation does not replay a month of combos as if they were
   * happening now.
   */
  const seenBreaksRef = useRef<Set<string> | null>(null)

  useEffect(() => {
    const first = seenBreaksRef.current === null
    const seen = seenBreaksRef.current ?? new Set<string>()
    seenBreaksRef.current = seen

    for (const [messageId, annotation] of annotations) {
      if (!annotation.brokeCombo) continue
      if (seen.has(messageId)) continue
      seen.add(messageId)
      if (first) continue
      analytics.track('combo_broken', { count: annotation.brokeCombo.count }, { source: 'group' })
    }
  }, [annotations, analytics])

  async function send() {
    const body = draft.trim()
    if (!body || sending) return

    setSending(true)
    setError(null)
    try {
      await client.sendGroupMessage(groupId, body)
      setDraft('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Message not sent.')
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  return (
    <div className="kb-chat">
      <div className="kb-chat-log">
        {messages.length === 0 && (
          <div className="kb-quiet-sub kb-chat-empty">No messages yet. Say something.</div>
        )}

        {messages.map((message) => {
          const annotation = annotations.get(message.id)
          return (
            <div key={message.id} className="kb-msg">
              <div className="kb-msg-head">
                {/*
                  * A span, not a button, and that is load-bearing.
                  *
                  * `<button>` cannot be `display: inline`: Chrome coerces it
                  * to inline-block, because a button may not be split across
                  * lines. That makes the sender name an ATOMIC inline box, and
                  * the line-breaking after an atomic box differs - a message
                  * whose first unbreakable run does not fit in the space left
                  * on the line starts a fresh line instead of filling it, so
                  * the message reads as its own block under the name.
                  *
                  * A span with role="button" is a genuine inline box, so the
                  * name is a word in the sentence again, and is still a
                  * control for anyone using a keyboard or a screen reader.
                  */}
                <span
                  role="button"
                  tabIndex={0}
                  className={`kb-msg-who kb-msg-who-btn${
                    message.userId === selfId ? ' kb-msg-who-self' : ''
                  }`}
                  title={`About ${message.displayName}`}
                  onClick={() =>
                    setOpenCardFor((open) => (open === message.id ? null : message.id))
                  }
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    setOpenCardFor((open) => (open === message.id ? null : message.id))
                  }}
                >
                  {/* The colon belongs to the sender label, so it lives inside
                      the identity: it copies with the name, and clicking it
                      does what clicking the name does.

                      It is not part of the NAME, though. The name carries the
                      sender's colour; the colon is structural punctuation and
                      takes the ordinary chat foreground, so a coloured name
                      does not bleed into the separator after it. */}
                  {message.displayName}
                  <span className="kb-msg-sep">:</span>
                </span>
                <MessageBody body={message.body} />
                {annotation && <ComboBadge annotation={annotation} />}
              </div>

              {openCardFor === message.id && (
                <UserCard
                  user={
                    byUserId.get(message.userId)?.user ?? {
                      id: message.userId,
                      // A sender who has since left the group is still a real
                      // person with a real message; we just know less.
                      username: message.displayName,
                      displayName: message.displayName,
                      avatarUrl: message.avatarUrl,
                      accentColor: '#ff8452',
                    }
                  }
                  presence={byUserId.get(message.userId)?.presence ?? null}
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

      {active && <ActiveComboBar combo={active} />}

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
          maxLength={MAX_LENGTH}
          placeholder="Message"
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
    </div>
  )
}
