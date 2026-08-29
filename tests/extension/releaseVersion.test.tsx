import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountCard } from '../../src/ui/components/AuthStates'
import type { KickbackClient, KickbackIdentity, KickbackPreferences } from '../../src/client/types'

/**
 * One version, in one place, all the way to the screen.
 *
 * WHY THIS TEST EXISTS
 *
 * The question we actually ask a beta tester is "what version are you
 * running?", and until 0.4.1 there was no dependable place for them to read it
 * - the panel footer carries it, but the footer is easy to miss and is replaced
 * by the layout hint on a first run. So the account panel shows it now.
 *
 * The failure mode worth guarding is not the rendering; it is DRIFT. There are
 * two files that must agree - package.json and public/manifest.json - and four
 * build configs that read the manifest into __KICKBACK_VERSION__. If somebody
 * bumps one and forgets the other, Chrome reports one version, the account
 * panel reports another, and a tester's answer becomes useless exactly when it
 * matters. `npm run verify:store` also checks the two files agree; this checks
 * the same thing plus the part that reaches the user.
 *
 * Note what is deliberately NOT asserted: the literal string "0.4.1". Pinning
 * the number here would mean editing this file on every release, which is the
 * habit that lets a real drift through unnoticed. The invariant is agreement,
 * not a particular value.
 */

const PACKAGE = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: string }
const MANIFEST = JSON.parse(readFileSync('public/manifest.json', 'utf8')) as { version?: string }

describe('the version has exactly one source', () => {
  it('agrees between package.json and the manifest', () => {
    expect(MANIFEST.version).toBe(PACKAGE.version)
  })

  it('is a plain x.y.z, which is all the store accepts', () => {
    expect(MANIFEST.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  /**
   * The constant every build config defines from the manifest. If this drifts,
   * the shipped bundle and the packaged manifest disagree about what they are.
   */
  it('is what the build constant carries', () => {
    expect(__KICKBACK_VERSION__).toBe(MANIFEST.version)
  })

  it('is read from the manifest by every config that defines the constant', () => {
    for (const config of [
      'vite.config.ts',
      'vite.background.config.ts',
      'vite.testlab.config.ts',
      'vitest.config.ts',
    ]) {
      const source = readFileSync(config, 'utf8')
      expect(source).toContain('__KICKBACK_VERSION__')
      // Read from the manifest, never typed in. This is the property that
      // makes a single bump sufficient.
      expect(source).toContain("readFileSync('public/manifest.json'")
    }
  })
})

// ------------------------------------------------------------------ the UI

const IDENTITY: KickbackIdentity = {
  userId: 'me-uuid',
  displayName: 'AnoterosTV',
  avatarUrl: null,
  twitchLogin: 'anoterostv',
  friendCode: 'KB-TEST',
  presenceVisibility: 'visible',
}

const PREFERENCES: KickbackPreferences = {
  gatheringNotifications: false,
}

function renderAccount(): string {
  return renderToStaticMarkup(
    <AccountCard
      // The badge shelf reads through the client; an empty one renders nothing.
      client={{ badges: async () => [] } as unknown as KickbackClient}
      identity={IDENTITY}
      onSignOut={() => {}}
      onVisibilityChange={() => {}}
      preferences={PREFERENCES}
      onPreferencesChange={() => {}}
      onResetLayout={() => {}}
      mutedUserIds={[]}
      knownPeople={[]}
      onUnmute={() => {}}
      blocked={[]}
      onUnblock={() => {}}
      onClose={() => {}}
      onFeedback={() => {}}
    />,
  )
}

describe('the account panel shows which build this is', () => {
  it('renders the version, labelled so it can be read aloud', () => {
    expect(renderAccount()).toContain(`Kickback v${__KICKBACK_VERSION__}`)
  })

  it('shows the same version the manifest ships', () => {
    expect(renderAccount()).toContain(`Kickback v${MANIFEST.version}`)
  })

  /**
   * The whole point is that a tester can read it back, so it must not be an
   * unselectable decoration or a title attribute nobody hovers.
   */
  it('puts it in the document text rather than in an attribute', () => {
    const html = renderAccount()
    const marker = `Kickback v${MANIFEST.version}`
    expect(html).toContain(`>${marker}<`)
  })

  /**
   * A version line is a tempting place to start attaching diagnostics. It is
   * the wrong place: Feedback already assembles those in the service worker
   * and sends them deliberately. This is the guard that keeps it a version
   * line.
   */
  it('carries nothing but the version', () => {
    const html = renderAccount()
    const line = html.match(/kb-account-version[^>]*>([^<]*)</)?.[1] ?? ''
    expect(line).toBe(`Kickback v${MANIFEST.version}`)
    for (const forbidden of ['me-uuid', 'KB-TEST', 'anoterostv', 'http', '@']) {
      expect(line).not.toContain(forbidden)
    }
  })
})

// ----------------------------------------------------------- the changelog

describe('the changelog describes the version being shipped', () => {
  const CHANGELOG = readFileSync('CHANGELOG.md', 'utf8')

  it('has an entry for the current version', () => {
    expect(CHANGELOG).toContain(`## ${MANIFEST.version} —`)
  })

  it('keeps the previous release in it, so history is not rewritten', () => {
    expect(CHANGELOG).toContain('## 0.4.0 —')
  })

  /**
   * The temporary Stream Room availability fix is genuinely temporary, and the
   * changelog must not present unfinished architecture as a finished feature.
   * That note is load-bearing rather than decorative.
   */
  it('marks the Stream Room relief as temporary rather than as a feature', () => {
    // Whitespace-tolerant: this is wrapped prose, and a line break falling
    // between two words must not be the thing that fails a release.
    expect(CHANGELOG).toMatch(/temporary\s+lifecycle\s+behavior/i)
    expect(CHANGELOG).toContain('multi-destination')
  })

  /** The privacy claim is one we have to keep, so it is written down. */
  it('states what the diagnostics never contain', () => {
    expect(CHANGELOG).toMatch(/No\s+message\s+bodies,\s+channel\s+names,\s+URLs,\s+emails/i)
  })
})
