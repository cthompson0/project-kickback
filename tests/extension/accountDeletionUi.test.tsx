import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountCard } from '../../src/ui/components/AuthStates'
import type { KickbackClient, KickbackIdentity } from '../../src/client/types'

/**
 * Deleting an account must be findable, and must be hard to do by accident.
 *
 * Those two pull in opposite directions, which is the whole design problem. A
 * control nobody can find is not a deletion path - it is a compliance claim.
 * A control one stray click completes destroys somebody's social graph.
 *
 * The resolution: the button is in the account panel next to Sign out, and it
 * opens a confirmation that cannot be completed without typing the account's
 * Twitch login. What is asserted here is that the destructive step is NOT
 * reachable in one click.
 */

const IDENTITY: KickbackIdentity = {
  userId: 'kb-user-1',
  displayName: 'Sk8bo',
  avatarUrl: null,
  twitchLogin: 'sk8bo',
  friendCode: 'KB-7QX4-M2P9',
  presenceVisibility: 'visible',
}

function installWindow(): void {
  if (typeof globalThis.window === 'undefined') {
    ;(globalThis as { window?: unknown }).window = { matchMedia: () => ({ matches: false }) }
  }
}

function account(): string {
  installWindow()
  return renderToStaticMarkup(
    <AccountCard
      client={{ badges: async () => [] } as unknown as KickbackClient}
      identity={IDENTITY}
      onSignOut={() => {}}
      onDeleted={() => {}}
      onVisibilityChange={() => {}}
      preferences={{ gatheringNotifications: true }}
      onPreferencesChange={() => {}}
      mutedUserIds={[]}
      knownPeople={[]}
      onUnmute={() => {}}
      blocked={[]}
      onUnblock={() => {}}
      onFeedback={() => {}}
      onClose={() => {}}
      onResetLayout={() => {}}
    />,
  )
}

describe('the account panel offers deletion', () => {
  it('has a Delete account control', () => {
    expect(account()).toContain('Delete account')
  })

  it('keeps it visually distinct from Sign out', () => {
    const markup = account()
    expect(markup).toContain('kb-danger-btn')
    expect(markup).toContain('Sign out')
  })

  /**
   * The important one: nothing destructive is reachable from the first click.
   *
   * On first render there is no confirmation field and no "Delete permanently"
   * button, so the control that actually deletes cannot be hit by a mis-tap.
   */
  it('does not expose the destructive step until asked', () => {
    const markup = account()
    expect(markup).not.toContain('Delete permanently')
    expect(markup).not.toContain('kb-danger-confirm')
    expect(markup).not.toContain('to confirm')
  })
})

describe('the confirmation is a real check, not theatre', () => {
  const source = readFileSync('src/ui/components/AuthStates.tsx', 'utf8')
  const section = source.slice(
    source.indexOf('function DeleteAccountSection'),
    source.indexOf('export function AccountCard'),
  )

  it('requires the typed text to match before deletion is possible', () => {
    expect(section).toContain('disabled={!matches || busy}')
    expect(section).toMatch(/typed\.trim\(\)\.toLowerCase\(\) === phrase\.toLowerCase\(\)/)
  })

  it('asks for the account’s own login rather than a generic word', () => {
    expect(section).toContain('const phrase = login ?? ')
    expect(section).toContain('to confirm')
  })

  it('says plainly that it cannot be undone', () => {
    expect(section).toContain('cannot be undone')
    expect(section).toContain('permanently')
  })

  it('says it does not touch the Twitch account', () => {
    expect(section).toContain('does not')
    expect(section).toContain('Twitch account')
  })

  /** A failure must leave the user able to try again, and must say so. */
  it('reports failure instead of pretending it worked', () => {
    expect(section).toContain('setError(result.error')
    expect(section).toContain('setBusy(false)')
  })

  it('closes the panel only when the server confirmed', () => {
    // onDeleted is called on the ok branch, and nowhere else.
    const okBranch = section.slice(section.indexOf('if (result.ok)'))
    expect(okBranch).toContain('onDeleted()')
    expect(section.match(/onDeleted\(\)/g)).toHaveLength(1)
  })
})
