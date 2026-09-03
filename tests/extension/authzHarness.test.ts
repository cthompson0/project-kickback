import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
// @ts-expect-error - plain ESM scripts, deliberately not TypeScript: they run
// under bare node so the security gate does not need a test runner to boot.
import { MUTATIONS, applyMutation } from '../../scripts/verify-authorization-tests.mjs'
// @ts-expect-error - as above.
import { changedSections, fingerprint } from '../../scripts/schema-fingerprint.mjs'

/**
 * Tests for the security gate itself.
 *
 * `npm run test:authz` weakens one safeguard at a time and asserts the db suite
 * notices. It is the thing that makes 616 green database tests mean something -
 * and it had two defects that made it report success it had not earned.
 *
 *   1. SIX OF EIGHTEEN LEVERS EDITED DEAD SQL. Each anchored on a definition
 *      that a later migration replaces: `send_friend_request` in 0003 is
 *      superseded by 0022 and again by 0039, `report_presence` in 0006 by 0025,
 *      `group_messages_select` in 0007 by 0022. The anchor text still existed,
 *      so nothing complained; the mutation changed a file and not the schema.
 *
 *   2. DETECTION WAS INFERRED FROM HUMAN-READABLE OUTPUT. The runner used
 *      `--reporter=verbose` and asked whether the expected test's NAME appeared
 *      anywhere in it. Verbose prints every test name it runs, so that was true
 *      whenever the file executed at all, and the check collapsed to "did the
 *      suite exit nonzero". Any unrelated failure credited every lever.
 *
 * Both are the same underlying mistake - trusting a proxy for the thing you
 * care about - and both are guarded here rather than only in the runner,
 * because a gate that can quietly stop testing is worse than no gate: it is a
 * green light nobody re-examines.
 *
 * These tests are deliberately cheap. The expensive proof - all 18 levers
 * genuinely detected against a green baseline - is `npm run test:authz` itself.
 */

interface Mutation {
  name: string
  file: string
  from?: string
  to?: string
  append?: string
  expect: string
}

const levers = MUTATIONS as Mutation[]

/** A throwaway copy of the real migrations. */
function migrationsCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kb-harness-test-'))
  cpSync('supabase/migrations', dir, { recursive: true })
  return dir
}

describe('every lever still points at code that exists, exactly once', () => {
  /**
   * The cheap half of defect 1, and the half that runs in a second.
   *
   * An anchor that matches nothing means the migration moved. An anchor that
   * matches twice is worse, because `String.replace` silently takes the first
   * one - and 0025 contains two functions that redact presence with
   * byte-identical SQL, so this is a live hazard rather than a theoretical one.
   */
  it.each(levers.map((m) => [m.name, m] as const))('%s', (_name, mutation) => {
    const source = readFileSync(join('supabase', 'migrations', mutation.file), 'utf8')
    if (mutation.append !== undefined) {
      // Append-style levers have no anchor; the file just has to be there.
      expect(source.length).toBeGreaterThan(0)
      return
    }
    const hits = source.split(mutation.from!).length - 1
    expect(hits, `anchor for "${mutation.name}" matches ${hits} places`).toBe(1)
  })

  it('names a migration that is actually applied', () => {
    const applied = new Set(
      readdirSync(join('supabase', 'migrations')).filter((f) => f.endsWith('.sql')),
    )
    for (const mutation of levers) {
      expect(applied.has(mutation.file), `${mutation.file} is not a migration`).toBe(true)
    }
  })
})

describe('a mutation that changes nothing cannot be mistaken for a missing test', () => {
  /**
   * Defect 1, stated as the property that prevents it.
   *
   * This is the case the old harness got exactly backwards: it saw a green
   * suite and reported "this regression would ship", when in fact no regression
   * existed because the edit never reached the database. The fingerprint is
   * what tells those apart, so this proves the fingerprint can tell them apart.
   */
  it('sees no schema change when a superseded definition is edited', async () => {
    const dir = migrationsCopy()
    try {
      const before = await fingerprint(dir)
      expect(before.failed).toBeNull()

      /*
       * The exact stale edit that used to be lever 8: remove the self-friending
       * guard from 0003. `send_friend_request` is redefined by 0022 and again
       * by 0039, so the built schema is unaffected - which is precisely why
       * this belongs in a test rather than in somebody's memory.
       */
      const target = join(dir, '0003_rpcs.sql')
      const source = readFileSync(target, 'utf8')
      const guard =
        "  if p_target = v_actor then\n" +
        "    raise exception 'kickback: you cannot add yourself' using errcode = '22023';\n" +
        '  end if;'
      expect(source.includes(guard), 'the dead 0003 guard should still be there').toBe(true)
      writeFileSync(target, source.replace(guard, ''))

      const after = await fingerprint(dir)
      expect(after.failed).toBeNull()
      expect(changedSections(before, after)).toEqual([])
      expect(after.digest).toBe(before.digest)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('sees a schema change when the definition that survives is edited', async () => {
    // The same guard, removed from 0039 instead - the one that actually runs.
    const dir = migrationsCopy()
    try {
      const before = await fingerprint(dir)
      const target = join(dir, '0039_operations.sql')
      const source = readFileSync(target, 'utf8')
      const guard =
        '  if p_target = v_actor then\n' +
        "    raise exception 'kickback: you cannot add yourself' using errcode = '22023';\n" +
        '  end if;'
      expect(source.split(guard).length - 1).toBe(1)
      writeFileSync(target, source.replace(guard, ''))

      const after = await fingerprint(dir)
      expect(after.failed).toBeNull()
      expect(changedSections(before, after)).toContain('functions')
      expect(after.digest).not.toBe(before.digest)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('every shipped lever changes the schema it claims to weaken', async () => {
    /*
     * The property applied to all eighteen at once, which is what stops this
     * regressing the next time a migration supersedes an older definition.
     *
     * This rebuilds the schema nineteen times and is the slowest test in the
     * repository by a wide margin - it is here rather than left to
     * `npm run test:authz` because that gate is easy to skip locally and this
     * one runs on every `npm test`.
     */
    const base = await fingerprint('supabase/migrations')
    expect(base.failed).toBeNull()

    const ineffective: string[] = []
    for (const mutation of levers) {
      const dir = migrationsCopy()
      try {
        const applied = applyMutation(mutation, dir)
        expect(applied.ok, `${mutation.name}: ${applied.reason ?? ''}`).toBe(true)

        const mutated = await fingerprint(dir)
        expect(mutated.failed, `${mutation.name} broke the migrations`).toBeNull()
        if (changedSections(base, mutated).length === 0) ineffective.push(mutation.name)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    expect(ineffective, 'these levers edit SQL a later migration replaces').toEqual([])
  }, 900_000)
})

describe('detection is attributed, so an unrelated failure cannot green-wash a lever', () => {
  /**
   * Defect 2, stated as the property that prevents it.
   *
   * The old rule was `suiteFailed && verboseOutput.includes(expectedTestName)`.
   * Because the verbose reporter prints the names of PASSING tests too, the
   * second clause was satisfied by the test merely existing - so the rule was
   * effectively `suiteFailed`, and 29 unrelated failures in a worktree with no
   * dist/ reported all eighteen levers as detected.
   *
   * The rule is now "one of the FAILED assertion titles contains the expected
   * one". These tests exercise that predicate directly on the shape the JSON
   * reporter produces, which is the part that has to be right.
   */
  const failedTitles = (report: {
    testResults?: { assertionResults?: { title: string; status: string }[] }[]
  }) => {
    const failures: string[] = []
    for (const file of report.testResults ?? []) {
      for (const assertion of file.assertionResults ?? []) {
        if (assertion.status === 'failed') failures.push(assertion.title)
      }
    }
    return failures
  }

  const detected = (report: Parameters<typeof failedTitles>[0], expected: string) =>
    failedTitles(report).some((title) => title.includes(expected))

  it('does not count a lever as detected when only unrelated tests fail', () => {
    const report = {
      testResults: [
        {
          assertionResults: [
            { title: 'refuses self-friending', status: 'passed' },
            { title: 'bundles the manifest into dist/', status: 'failed' },
            { title: 'ships the right icons', status: 'failed' },
          ],
        },
      ],
    }
    // The old rule saw the expected name in the output and said yes.
    expect(JSON.stringify(report)).toContain('refuses self-friending')
    // The new rule asks whether it FAILED.
    expect(detected(report, 'refuses self-friending')).toBe(false)
  })

  it('counts a lever as detected only when its own assertion fails', () => {
    const report = {
      testResults: [
        {
          assertionResults: [
            { title: 'refuses self-friending', status: 'failed' },
            { title: 'something else entirely', status: 'passed' },
          ],
        },
      ],
    }
    expect(detected(report, 'refuses self-friending')).toBe(true)
  })

  it('still counts it when the expected assertion fails alongside others', () => {
    // A mutation may legitimately break more than one test. What matters is
    // that the named one is among them.
    const report = {
      testResults: [
        {
          assertionResults: [
            { title: 'refuses self-friending', status: 'failed' },
            { title: 'bundles the manifest into dist/', status: 'failed' },
          ],
        },
      ],
    }
    expect(detected(report, 'refuses self-friending')).toBe(true)
  })

  it('is not fooled by a passing test whose name contains the expected one', () => {
    const report = {
      testResults: [
        {
          assertionResults: [{ title: 'refuses self-friending twice', status: 'passed' }],
        },
      ],
    }
    expect(detected(report, 'refuses self-friending')).toBe(false)
  })
})

describe('the runner refuses to grade against a red baseline', () => {
  /**
   * The third guard, and the one that would have saved several hours.
   *
   * A worktree without `dist/` fails 29 tests that have nothing to do with
   * authorization. Grading mutations in that state produced a perfect 18/18,
   * which read as "the pre-change tree was fine" and very nearly became
   * evidence that a UI pass had broken the database.
   */
  it('reads the source and finds the refusal, with an explanation', () => {
    const runner = readFileSync(join('scripts', 'verify-authorization-tests.mjs'), 'utf8')
    expect(runner).toContain('REFUSING TO RUN')
    // And it must be a pre-flight of the UNMUTATED suite, not a post-hoc guess.
    expect(runner).toMatch(/runSuite\('supabase\/migrations'\)/)
  })

  it('no longer decides anything from verbose output', () => {
    const runner = readFileSync(join('scripts', 'verify-authorization-tests.mjs'), 'utf8')
    // Comments out first: the old reporter and the old predicate are both
    // quoted, by name, in the comments that explain why they are gone.
    const code = runner.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toContain('--reporter=verbose')
    expect(code).toContain('--reporter=json')
    // The specific expression that caused it, gone rather than merely unused.
    expect(code).not.toMatch(/output\.includes\(mutation\.expect\)/)
  })
})
