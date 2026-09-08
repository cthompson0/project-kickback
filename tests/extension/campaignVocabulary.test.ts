import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MEDIUMS, PROVIDERS, SOURCES } from '../../scripts/campaign-vocabulary.mjs'

/**
 * The tooling's copy of the campaign vocabulary agrees with the database's.
 *
 * WHY THIS TEST EXISTS
 *
 * Four things have to agree about what a valid campaign looks like: the check
 * constraints in the migrations, `scripts/campaign-vocabulary.mjs`, the minting
 * tool that validates against it, and the site build that pre-renders a page
 * per campaign. The database is authoritative; the others exist so a bad
 * campaign fails at the terminal instead of at a paste.
 *
 * A duplicate list is fine RIGHT UP UNTIL it drifts, and drift here is silent:
 * the tool would happily mint a campaign the database then refuses, or - worse -
 * refuse one the database would have accepted, and somebody would work around
 * the tool by writing SQL by hand.
 *
 * The same technique `analyticsContract.test.ts` already uses for the event
 * vocabulary: read the SQL, and assert the two say the same thing.
 */

const sql = (file: string) => readFileSync(join('supabase', 'migrations', file), 'utf8')

/** Every quoted value inside the named `in (...)` list of a check constraint. */
function checkValues(text: string, column: string): string[] {
  const pattern = new RegExp(`${column}\\s+in\\s*\\(([^)]*)\\)`, 'i')
  const match = pattern.exec(text)
  if (!match) throw new Error(`no "in (...)" check found for ${column}`)
  return [...match[1].matchAll(/'([^']+)'/g)].map((found) => found[1])
}

describe('the campaign vocabulary is one vocabulary', () => {
  it('matches the source list 0038 constrained, which 0045 did not touch', () => {
    expect([...SOURCES].sort()).toEqual(checkValues(sql('0038_acquisition_attribution.sql'), 'source').sort())
  })

  it('matches the provider list 0045 constrained', () => {
    const migration = sql('0045_acquisition_provider_metadata.sql')
    expect([...PROVIDERS].sort()).toEqual(checkValues(migration, 'provider').sort())
  })

  it('matches the medium list 0045 constrained', () => {
    const migration = sql('0045_acquisition_provider_metadata.sql')
    expect([...MEDIUMS].sort()).toEqual(checkValues(migration, 'medium').sort())
  })

  /*
   * `reddit` was already a source in 0038. Pinned because the temptation when
   * adding "Reddit support" is to add it again somewhere, and a second Reddit
   * in a closed set is how a rollup splits one campaign across two rows.
   */
  it('already had reddit as a source before this milestone', () => {
    expect(checkValues(sql('0038_acquisition_attribution.sql'), 'source')).toContain('reddit')
  })

  /*
   * A short list is the feature. Every entry is a provider somebody had a
   * reason to name; a speculative one is a value that will be typed by accident
   * and then reported on.
   */
  it('names no provider we have no reason to name', () => {
    expect(PROVIDERS.length).toBeLessThanOrEqual(10)
    for (const provider of PROVIDERS) {
      expect(provider).toMatch(/^[a-z][a-z0-9]*$/)
    }
  })

  /*
   * There is deliberately no 'direct' and no 'none'. 0040 refused a direct
   * bucket because Watchside cannot tell somebody who typed the store URL from
   * somebody whose campaign touch expired, and a null provider is the honest
   * way to say "no paid provider" without inventing a fact about people.
   */
  it('has no direct bucket hiding in the provider or medium list', () => {
    for (const list of [PROVIDERS, MEDIUMS]) {
      expect(list).not.toContain('direct')
      expect(list).not.toContain('none')
      expect(list).not.toContain('unknown')
    }
  })
})

describe('UTMs are outbound only', () => {
  /*
   * THE RULE THE WHOLE DESIGN RESTS ON.
   *
   * Attribution comes from the opaque campaign code, resolved server-side. A
   * visitor who edits ?utm_source= must change nothing. That holds only while
   * nothing anywhere READS a utm parameter, so this asserts the absence
   * directly rather than trusting it.
   */
  const searched = [
    join('src', 'core', 'acquisition.ts'),
    join('src', 'content', 'index.tsx'),
    join('src', 'background', 'index.ts'),
    join('docs', 'web', 'watchside-app', 'js', 'route.js'),
    join('docs', 'web', 'watchside-app', 'js', 'campaign.js'),
  ]

  it('never reads a utm parameter anywhere in the product or the site', () => {
    for (const file of searched) {
      const text = readFileSync(file, 'utf8')
      for (const utm of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
        expect(text, `${file} reads ${utm}`).not.toContain(utm)
      }
    }
  })

  it('never reads a provider click identifier', () => {
    for (const file of searched) {
      const text = readFileSync(file, 'utf8')
      for (const clickId of ['rdt_cid', 'fbclid', 'gclid', 'ttclid', 'msclkid']) {
        expect(text, `${file} reads ${clickId}`).not.toContain(clickId)
      }
    }
  })

  /*
   * The database must not have grown somewhere to put one either. A column
   * named for a UTM on a user-scoped table is the shape this design exists to
   * refuse: arbitrary client-supplied text in a table later read as if it were
   * authoritative.
   */
  it('stores no utm value and no referrer on any user-scoped table', () => {
    /*
     * Comments stripped first. 0045 explains the outbound-only rule at length
     * and names `?utm_source=` while doing it, so a raw substring check would
     * fail on the very paragraph that documents the guarantee - the same trap
     * two assertions in campaignPages.test.ts already fell into.
     */
    const migration = sql('0045_acquisition_provider_metadata.sql')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*--.*$/gm, '')

    for (const forbidden of ['utm_', 'referrer', 'landing_url', 'user_agent', 'ip_address']) {
      expect(migration, `0045 introduces ${forbidden}`).not.toContain(forbidden)
    }
  })
})
