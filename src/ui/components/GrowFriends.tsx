import { useEffect, useState } from 'react'
import { Avatar } from './Avatar'
import { mutualBucket } from '../../core/analytics'
import { inviteLinkFor } from '../../core/invites'
import type { KickbackClient } from '../../client/types'
import type { FriendSuggestion } from '../../background/supabaseBackend'

/**
 * The two answers to "how do I get enough friends here for this to be useful".
 *
 * PEOPLE YOU MAY KNOW comes from the graph that already exists: friends of
 * friends, with how much overlap there is. INVITE comes from the graph that
 * does not: a link that brings somebody new in and remembers who brought them.
 *
 * Both live under Find friends rather than in the main panel, because neither
 * is something a person needs while watching a stream - they are what you go
 * looking for when the map is emptier than you want it to be.
 */

// ------------------------------------------------------------- suggestions

/**
 * How many friends in common, said the way a person would say it.
 *
 * The count and never the names: naming a mutual would publish a friendship
 * that neither of them offered. See 0026 for the reasoning; this is only the
 * wording.
 */
function mutualLabel(count: number): string {
  return count === 1 ? '1 mutual friend' : `${count} mutual friends`
}

export function FriendSuggestions({ client }: { client: KickbackClient }) {
  const [suggestions, setSuggestions] = useState<FriendSuggestion[] | null>(null)
  const [busyUserId, setBusyUserId] = useState<string | null>(null)
  const [added, setAdded] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    client
      .suggestFriends()
      .then((rows) => {
        if (!cancelled) setSuggestions(rows)
      })
      .catch(() => {
        // A suggestion list that fails to load is not worth an error message:
        // the search box above it still works, which is the important half.
        if (!cancelled) setSuggestions([])
      })
    return () => {
      cancelled = true
    }
  }, [client])

  async function add(suggestion: FriendSuggestion, position: number) {
    setBusyUserId(suggestion.userId)
    setError(null)
    const bucket = mutualBucket(suggestion.mutualCount)
    client.track('friend_suggestion_add_clicked', { mutual_bucket: bucket, position })

    try {
      const outcome = await client.sendFriendRequest(suggestion.userId)
      client.track('friend_suggestion_request_created', {
        mutual_bucket: bucket,
        outcome,
      })
      setAdded((current) => ({
        ...current,
        [suggestion.userId]:
          outcome === 'friends' || outcome === 'already_friends' ? 'Friends' : 'Requested',
      }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send that request.')
    } finally {
      setBusyUserId(null)
    }
  }

  // Nothing to say yet, or genuinely nobody to suggest. Neither deserves an
  // empty-state lecture - the invite section below is the real answer.
  if (!suggestions || suggestions.length === 0) return null

  return (
    <div className="kb-suggestions">
      <div className="kb-section-label">People you may know</div>
      {error && <div className="kb-inline-note">{error}</div>}

      {suggestions.map((suggestion, index) => {
        const busy = busyUserId === suggestion.userId
        const done = added[suggestion.userId]

        return (
          <div className="kb-row" key={suggestion.userId}>
            <Avatar
              user={{
                id: suggestion.userId,
                username: suggestion.twitchLogin ?? suggestion.displayName,
                displayName: suggestion.displayName,
                avatarUrl: suggestion.avatarUrl,
              }}
              showDot={false}
            />
            <div className="kb-row-main">
              <div className="kb-row-name">{suggestion.displayName}</div>
              <div className="kb-row-status">
                <span className="kb-mutuals">{mutualLabel(suggestion.mutualCount)}</span>
              </div>
            </div>

            {done ? (
              <span className="kb-row-note">{done}</span>
            ) : (
              <button
                type="button"
                className={`kb-join${busy ? ' kb-join-busy' : ''}`}
                disabled={busy}
                onClick={() => void add(suggestion, index + 1)}
              >
                {busy ? '…' : 'ADD'}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ------------------------------------------------------------------ invite

/**
 * One durable link, and what it has achieved.
 *
 * The count is shown because it is the honest reason to share again - somebody
 * who has brought three friends in can see that it worked. It is deliberately
 * not a leaderboard, a streak or a progress bar toward a prize.
 */
export function InviteFriends({
  client,
  referralCount,
}: {
  client: KickbackClient
  referralCount: number
}) {
  const [code, setCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    client
      .inviteCode()
      .then((value) => {
        if (!cancelled) setCode(value)
      })
      .catch(() => {
        if (!cancelled) setError('Could not create your invite link.')
      })
    return () => {
      cancelled = true
    }
  }, [client])

  const link = code ? inviteLinkFor(code) : null

  async function copy() {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      client.track('invite_link_shared', { method: 'copy' })
      window.setTimeout(() => setCopied(false), 2_000)
    } catch {
      // Clipboard permission can be refused inside a content script. The link
      // is on screen and selectable, so this is a downgrade, not a failure.
      setError('Copy the link above.')
    }
  }

  return (
    <div className="kb-invite">
      <div className="kb-section-label">Invite a friend</div>
      <div className="kb-quiet-sub">
        Kickback is better with the people you already watch with. Send them your link.
      </div>

      {error && <div className="kb-inline-note">{error}</div>}

      {link && (
        <>
          {/* Readonly rather than a div: it can be selected and copied by hand
              when the clipboard API is refused. */}
          <input className="kb-invite-link" type="text" value={link} readOnly spellCheck={false} />
          <button type="button" className="kb-invite-copy" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy invite link'}
          </button>
        </>
      )}

      {referralCount > 0 && (
        <div className="kb-quiet-sub kb-invite-count">
          {referralCount === 1
            ? '1 friend has joined through your link.'
            : `${referralCount} friends have joined through your link.`}
        </div>
      )}
    </div>
  )
}
