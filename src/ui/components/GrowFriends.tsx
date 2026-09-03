import { useEffect, useRef, useState } from 'react'
import { humanMessage } from '../../core/errors'
import { Avatar } from './Avatar'
import { mutualBucket } from '../../core/analytics'
import { inviteLinkFor } from '../../core/invites'
import type { Friend, FriendRequest, KickbackClient } from '../../client/types'
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

/**
 * What a suggestion row's button should say, from AUTHORITATIVE state.
 *
 * THE DEFECT THIS REPLACES
 *
 * This used to be a local `added: Record<string, string>` map, written when the
 * Add button was pressed and never cleared. So the row said "Requested" for the
 * life of the mount: send a request, cancel it, and the only way back to Add
 * was to leave the surface entirely - which is exactly what a beta user
 * reported, along with the observation that suggestions "could refresh on such
 * actions".
 *
 * The worker already knows the truth. `mutate()` in background/friends.ts
 * awaits `refresh()` before it resolves, so by the time `sendFriendRequest`
 * returns, the friends and outgoing-request lists have been re-read and
 * broadcast. Deriving from those props means a cancel performed anywhere -
 * this surface, the requests list, another tab - is reflected here without a
 * second synchronisation system.
 */
function suggestionAction(
  userId: string,
  friends: Friend[],
  outgoingRequests: FriendRequest[],
): { label: string; actionable: boolean } {
  if (friends.some((friend) => friend.user.id === userId)) {
    return { label: 'Friends', actionable: false }
  }
  if (outgoingRequests.some((request) => request.user.id === userId)) {
    return { label: 'Requested', actionable: false }
  }
  return { label: 'Add', actionable: true }
}

export function FriendSuggestions({
  client,
  friends,
  outgoingRequests,
}: {
  client: KickbackClient
  friends: Friend[]
  outgoingRequests: FriendRequest[]
}) {
  const [suggestions, setSuggestions] = useState<FriendSuggestion[] | null>(null)
  const [busyUserId, setBusyUserId] = useState<string | null>(null)
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

  /*
   * The impression, recorded where the surface is actually drawn.
   *
   * It used to fire at the FETCH, which counted "we asked the server" as
   * "somebody saw suggestions" - including every empty result, for a list that
   * renders nothing when it is empty. The first step of the growth funnel was
   * measuring the wrong thing, in the direction that flatters it.
   *
   * `seen` is a ref rather than state so a re-render cannot emit a second time,
   * and it lives for this mount. One open of the find-friends surface is one
   * impression, which is what a person would count.
   */
  const seen = useRef(false)
  useEffect(() => {
    if (seen.current) return
    if (!suggestions || suggestions.length === 0) return
    seen.current = true
    client.track('friend_suggestion_impression', {
      suggestion_count: suggestions.length,
      top_mutual_bucket: mutualBucket(suggestions[0].mutualCount),
    })
  }, [client, suggestions])

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
      /*
       * Nothing is recorded locally. The worker refreshed before this resolved,
       * so the props already say "Requested" - and, unlike a local map, they
       * will say "Add" again the moment the request is cancelled.
       */
    } catch (cause) {
      setError(humanMessage(cause, 'Could not send that request.'))
    } finally {
      setBusyUserId(null)
    }
  }

  // Still loading. Nothing yet is better than a flash of "nobody to suggest".
  if (!suggestions) return null

  /*
   * Nobody to suggest, said out loud.
   *
   * This used to render null, which is the one thing it must not do HERE. The
   * user has deliberately opened the find-friends surface; silence leaves them
   * unable to tell whether the feature is empty, broken, or absent - and it is
   * empty exactly when they are new, because suggestions come from friends of
   * friends and a new account has neither.
   *
   * So it says why, and points at the two things that do work from a standing
   * start: searching for somebody, and inviting somebody who is not here yet.
   */
  if (suggestions.length === 0) {
    return (
      <div className="kb-suggestions">
        <div className="kb-section-label">People you may know</div>
        <div className="kb-quiet-sub">
          Nobody to suggest yet. Watchside suggests people your friends already
          know, so this fills up as you add a few. Search for somebody above, or
          invite a friend below.
        </div>
      </div>
    )
  }

  return (
    <div className="kb-suggestions">
      <div className="kb-section-label">People you may know</div>
      {error && <div className="kb-inline-note">{error}</div>}

      {suggestions.map((suggestion, index) => {
        const busy = busyUserId === suggestion.userId
        const action = suggestionAction(suggestion.userId, friends, outgoingRequests)

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

            {action.actionable ? (
              <button
                type="button"
                className={`kb-join${busy ? ' kb-join-busy' : ''}`}
                disabled={busy}
                onClick={() => void add(suggestion, index + 1)}
              >
                {busy ? '…' : 'ADD'}
              </button>
            ) : (
              <span className="kb-row-note">{action.label}</span>
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
        Watchside is better with the people you already watch with. Send them your link.
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
