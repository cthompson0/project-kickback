import { useEffect, useMemo, useRef, useState } from 'react'
import { EMOTES, isEmoteOnly, parseMessage } from '../../core/emotes'
import { scanCombos } from '../../core/combos'
import type { ActiveCombo, ComboAnnotation } from '../../core/combos'
import type { ChatMessage, KickbackClient } from '../../client/types'
import { EmoteImage } from './EmoteImage'
import { EmotePicker } from './EmotePicker'
import { UserCard } from './UserCard'
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
  friendIds,
  outgoingRequestIds,
}: {
  groupId: string
  messages: ChatMessage[]
  selfId: string | null
  client: KickbackClient
  /** The roster, so a sender's card shows the same presence as everywhere. */
  members?: GroupMember[]
  friendIds?: ReadonlySet<string>
  outgoingRequestIds?: ReadonlySet<string>
}) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  /** Which message's sender card is open, keyed by message so it anchors. */
  const [openCardFor, setOpenCardFor] = useState<string | null>(null)

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
                <button
                  type="button"
                  // Inline so it stays part of the sentence: the name is a
                  // word in the line, not a control beside it.
                  className={`kb-msg-who kb-msg-who-btn${
                    message.userId === selfId ? ' kb-msg-who-self' : ''
                  }`}
                  title={`About ${message.displayName}`}
                  onClick={() =>
                    setOpenCardFor((open) => (open === message.id ? null : message.id))
                  }
                >
                  {message.displayName}
                </button>
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
                  isFriend={friendIds?.has(message.userId) ?? false}
                  requestPending={outgoingRequestIds?.has(message.userId) ?? false}
                  isSelf={message.userId === selfId}
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
