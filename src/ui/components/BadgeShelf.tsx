import { useEffect, useState } from 'react'
import type { KickbackClient } from '../../client/types'
import type { EarnedBadge } from '../../background/supabaseBackend'

/**
 * The badges this account has earned, and which one it is showing.
 *
 * Deliberately small. A badge is a thing you notice once and then forget you
 * have, so this is a row of them in the account panel rather than a page, a
 * shelf, a collection screen or a progression system. No rarity, no XP, no
 * unlock animation.
 *
 * KICKBACK-ISSUED, SAID OUT LOUD
 *
 * Every badge here carries its issuer and the heading says so. Kickback must
 * never look like it granted somebody a Twitch badge, and the moment a second
 * issuer exists that distinction has to already be on screen rather than
 * retrofitted.
 */
export function BadgeShelf({ client }: { client: KickbackClient }) {
  const [badges, setBadges] = useState<EarnedBadge[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    client
      .badges()
      .then((rows) => {
        if (!cancelled) setBadges(rows)
      })
      .catch(() => {
        // A shelf that fails to load is not worth an error: everything else in
        // the account panel still works, and nothing here is actionable.
        if (!cancelled) setBadges([])
      })
    return () => {
      cancelled = true
    }
  }, [client])

  async function equip(key: string | null) {
    setBusy(true)
    setError(null)
    try {
      await client.setDisplayedBadge(key)
      setBadges((current) =>
        current
          ? current.map((badge) => ({ ...badge, displayed: badge.key === key }))
          : current,
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update your badge.')
    } finally {
      setBusy(false)
    }
  }

  // Nothing earned yet. No empty state, no "keep going" nudge - an account with
  // no badges should simply not have a badge section.
  if (!badges || badges.length === 0) return null

  const equipped = badges.find((badge) => badge.displayed) ?? null

  return (
    <div className="kb-badges">
      <div className="kb-section-label">Kickback badges</div>

      {error && <div className="kb-inline-note">{error}</div>}

      <div className="kb-badge-row">
        {badges.map((badge) => (
          <button
            key={badge.key}
            type="button"
            className={`kb-badge${badge.displayed ? ' kb-badge-on' : ''}`}
            disabled={busy}
            // The description is the whole explanation; it needs no second line
            // on screen.
            title={`${badge.name} — ${badge.description}`}
            aria-pressed={badge.displayed}
            onClick={() => void equip(badge.displayed ? null : badge.key)}
          >
            <span className="kb-badge-icon" aria-hidden="true">
              {badge.icon}
            </span>
            <span className="kb-badge-name">{badge.name}</span>
          </button>
        ))}
      </div>

      <div className="kb-quiet-sub">
        {equipped
          ? `Showing ${equipped.name}. Tap it again to show none.`
          : 'Tap a badge to show it. Earned by inviting friends to Kickback.'}
      </div>
    </div>
  )
}
