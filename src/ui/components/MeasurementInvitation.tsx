import { useState } from 'react'
import type { KickbackClient, MeasurementReadiness } from '../../client/types'

/**
 * The one-time invitation shown to people whose Twitch authorization predates
 * the measurement permission.
 *
 * WHY THIS EXISTS AT ALL
 *
 * New authorizations ask for `user:read:follows` on the ordinary Twitch consent
 * screen, so for anybody joining after M3D there is nothing to find and nothing
 * to prompt. This is purely a MIGRATION surface for the people who signed in
 * before that was true. It is a cohort that only shrinks, and this component
 * should eventually be deletable.
 *
 * WHY IT IS NOT BURIED IN THE ACCOUNT PANEL
 *
 * It was, and that was wrong. Nobody opens their account settings looking for a
 * permission they have never heard of, so "discoverable in Account" meant "not
 * discoverable". The account control still exists as the deliberate way back
 * for somebody who said no and changed their mind - but it is a fallback, not
 * the way people are expected to find this.
 *
 * WHY IT IS SAFE TO PUT ON THE MAIN SURFACE
 *
 * It renders inside the panel body, in normal flow, above the tabs. It is not a
 * modal, it does not steal focus, and nothing about it sits between a JOIN click
 * and arriving on Twitch. That last point is not decoration: a consent window at
 * the JOIN would delay the social moment AND contaminate the very baseline it
 * exists to enable, because "do you already follow them" stops being answerable
 * once we have interrupted the person on their way there.
 *
 * WHAT "NOT NOW" MEANS
 *
 * It is remembered, and it is the end of the asking. Nothing re-raises this on
 * the next startup, the next session or the next page. It is a dismissal and not
 * a refusal - the account panel keeps a one-line way to grant it later - but
 * from Watchside's side the conversation is over unless the person restarts it.
 */
export function MeasurementInvitation({
  client,
  readiness,
  dismissed,
  onDismissedChange,
}: {
  client: KickbackClient
  readiness: MeasurementReadiness | null
  dismissed: boolean
  onDismissedChange: (dismissed: boolean) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /*
   * Exactly one state is invited, and the exclusions matter more than the
   * inclusion:
   *
   *   ready                    nothing to ask for
   *   needs_reauthorization    genuinely broken; an optional-permission story
   *                            would send them down entirely the wrong path
   *   temporarily_unavailable  Watchside's problem, not theirs
   *   null                     we could not ask the server, which is not the
   *                            same as "not permitted" - a network blip must
   *                            never manufacture a consent prompt
   */
  if (readiness !== 'needs_follow_permission') return null
  if (dismissed) return null

  const grant = (): void => {
    setBusy(true)
    setError(null)
    client
      .grantFollowPermission()
      .then((result) => {
        setBusy(false)
        // Declining on Twitch reports no error, because nothing went wrong -
        // somebody simply said no, which is a supported answer.
        if (!result.ok && result.error) setError(result.error)
      })
      .catch(() => {
        setBusy(false)
        setError('Watchside could not reach Twitch just then.')
      })
  }

  return (
    <div className="kb-invite" role="region" aria-label="Help measure creator discovery">
      <div className="kb-invite-title">Help measure creator discovery</div>
      <p className="kb-invite-body">
        When you join a creator through a friend, Watchside can check whether you
        already follow them. It is how we find out whether friends genuinely help
        people discover someone new.
      </p>
      <p className="kb-invite-note">
        Optional. Everything in Watchside works without it, and it never changes
        who you follow.
      </p>
      {error && <p className="kb-invite-error">{error}</p>}
      <div className="kb-invite-actions">
        <button type="button" className="kb-signin-btn" disabled={busy} onClick={grant}>
          {busy ? 'Opening Twitch…' : 'Continue with Twitch'}
        </button>
        <button
          type="button"
          className="kb-ghost-btn kb-ghost-btn-inline"
          disabled={busy}
          onClick={() => onDismissedChange(true)}
        >
          Not now
        </button>
      </div>
    </div>
  )
}
