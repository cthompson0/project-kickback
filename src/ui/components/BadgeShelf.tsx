import { useEffect, useState } from 'react'
import { humanMessage } from '../../core/errors'
import type { KickbackClient } from '../../client/types'
import type { BadgeDefinition, EarnedBadge } from '../../background/supabaseBackend'

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
 * Every badge here carries its issuer and the heading says so. Watchside must
 * never look like it granted somebody a Twitch badge, and the moment a second
 * issuer exists that distinction has to already be on screen rather than
 * retrofitted.
 */
export function BadgeShelf({ client }: { client: KickbackClient }) {
  const [badges, setBadges] = useState<EarnedBadge[] | null>(null)
  const [catalog, setCatalog] = useState<BadgeDefinition[] | null>(null)
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

  /*
   * Everything that EXISTS, not just what has been earned.
   *
   * Without this the shelf could only ever say "here is what you have", so a
   * person had no way to learn what was possible or how any of it happened.
   * Knowing a badge exists reveals nothing about anybody, which is why the
   * definitions are readable and why this needs no new privacy thinking.
   */
  useEffect(() => {
    let cancelled = false
    client
      .badgeCatalog()
      .then((rows) => {
        if (!cancelled) setCatalog(rows)
      })
      .catch(() => {
        // The shelf still works without it; it simply shows only what is earned.
        if (!cancelled) setCatalog([])
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
      setError(humanMessage(cause, 'Could not update your badge.'))
    } finally {
      setBusy(false)
    }
  }

  if (!badges) return null

  const earned = new Set(badges.map((badge) => badge.key))
  const locked = (catalog ?? []).filter((badge) => !earned.has(badge.key))

  /*
   * An account with nothing earned and nothing to earn has no badge section.
   *
   * But one with nothing earned and a ladder ahead of it does - that is the
   * whole point of showing what is possible, and it is the state every new
   * account is in.
   */
  if (badges.length === 0 && locked.length === 0) return null

  const equipped = badges.find((badge) => badge.displayed) ?? null

  return (
    <div className="kb-badges">
      <div className="kb-section-label">Watchside badges</div>

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

      {/*
        * What is still to earn.
        *
        * Shown greyed and NOT as buttons - there is nothing to press, and a
        * disabled button invites the press anyway. "Locked" is carried by the
        * word in the tooltip and by the heading, never by the colour alone.
        *
        * Deliberately not a progress bar, a counter, or "2 more to go". The
        * ladder is visible; turning it into a target is how a badge shelf
        * becomes pressure to spam invitations at people.
        */}
      {locked.length > 0 && (
        <>
          <div className="kb-section-label kb-section-label-sub">Still to earn</div>
          <div className="kb-badge-row">
            {locked.map((badge) => (
              <span
                key={badge.key}
                className="kb-badge kb-badge-locked"
                title={`${badge.name} (not earned yet) — ${badge.description}`}
              >
                <span className="kb-badge-icon" aria-hidden="true">
                  {badge.icon}
                </span>
                <span className="kb-badge-name">{badge.name}</span>
              </span>
            ))}
          </div>
        </>
      )}

      <div className="kb-quiet-sub">
        {equipped
          ? `Showing ${equipped.name}. Tap it again to show none.`
          : badges.length > 0
            ? 'Tap a badge to show it. Earned by inviting friends to Watchside.'
            : 'Badges are earned when friends you invited start using Watchside.'}
      </div>
    </div>
  )
}
