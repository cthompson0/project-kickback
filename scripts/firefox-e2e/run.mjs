/**
 * The Firefox end-to-end gate.
 *
 *   npm run verify:firefox:e2e             every scenario
 *   npm run verify:firefox:e2e -- gravity  only scenarios whose name matches
 *
 * Deliberately NOT part of `npm test`. It launches real browsers and the
 * lifecycle scenario has to out-wait an event page suspending, so folding it
 * into the fast suite would make ordinary development miserable. It is a
 * release gate, run alongside `verify:firefox` and `web-ext lint`.
 *
 * Exits non-zero on the first scenario failure, having printed the failed
 * assertion, the browser and extension versions, the page URLs, and any
 * background or page errors - so a red run is actionable without a rerun.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PACKAGE_DIR, findFirefox, seedProfile } from './harness.mjs'

const SCENARIOS = join('scripts', 'firefox-e2e', 'scenarios')

/** A failure carries its own explanation. */
export class AssertionError extends Error {}

export function makeAssert(name) {
  const checks = []
  const ok = (label, condition, detail) => {
    checks.push({ label, pass: Boolean(condition), detail })
    if (!condition) {
      throw new AssertionError(`${name}: ${label}${detail ? ` — ${detail}` : ''}`)
    }
    console.log(`    ok  ${label}${detail ? `  (${detail})` : ''}`)
  }
  ok.equal = (label, actual, expected) =>
    ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  ok.checks = checks
  return ok
}

async function main() {
  const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'))

  let firefox
  try {
    firefox = findFirefox()
  } catch (error) {
    console.error(String(error.message))
    return 1
  }

  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'manifest.json'), 'utf8'))

  console.log('Watchside Firefox E2E')
  console.log(`  firefox    : ${firefox}`)
  console.log(`  extension  : ${manifest.name} ${manifest.version} (${manifest.browser_specific_settings.gecko.id})`)
  console.log(`  package    : ${PACKAGE_DIR}`)

  const files = readdirSync(SCENARIOS)
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => !filter.length || filter.some((needle) => f.includes(needle)))
    .sort()

  if (!files.length) {
    console.error(`\nNo scenarios matched ${JSON.stringify(filter)}`)
    return 1
  }

  const results = []
  const started = Date.now()

  for (const file of files) {
    const module = await import(pathToFileURL(join(process.cwd(), SCENARIOS, file)).href)
    const scenario = module.default
    console.log(`\n== ${scenario.name}`)
    if (scenario.why) console.log(`   ${scenario.why}`)

    /*
     * A social scenario needs an authenticated actor, and a missing one is a
     * FAILURE rather than a skip. A permanently-skipped social test decays
     * into looking like coverage, which is worse than having none.
     */
    const missing = (scenario.requires || [])
      .map((actor) => seedProfile(actor))
      .filter((seed) => !seed.present)
    if (missing.length) {
      const detail = missing.map((s) => s.key + (s.path ? ' (path not found: ' + s.path + ')' : ' is not set')).join('; ')
      const error = new AssertionError(scenario.name + ': required seed profile unavailable - ' + detail)
      results.push({ name: scenario.name, pass: false, ms: 0, error })
      console.error('   FAIL  ' + error.message)
      break
    }

    const at = Date.now()
    let driver = null
    try {
      const run = await scenario.run({ assert: makeAssert(scenario.name) })
      driver = run?.driver ?? null
      results.push({ name: scenario.name, pass: true, ms: Date.now() - at })
      console.log(`   PASS  (${((Date.now() - at) / 1000).toFixed(1)}s)`)
    } catch (error) {
      results.push({ name: scenario.name, pass: false, ms: Date.now() - at, error })
      console.error(`   FAIL  ${error.message}`)
      if (error.diagnostics) {
        console.error('   diagnostics:')
        console.error(
          String(JSON.stringify(error.diagnostics, null, 2))
            .split('\n')
            .map((l) => `     ${l}`)
            .join('\n'),
        )
      }
      if (!(error instanceof AssertionError) && error.stack) {
        console.error(String(error.stack).split('\n').slice(0, 6).map((l) => `     ${l}`).join('\n'))
      }
      break
    } finally {
      if (driver) await driver.close().catch(() => {})
    }
  }

  const failed = results.filter((r) => !r.pass).length
  console.log(`\n${'-'.repeat(60)}`)
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(38)} ${(r.ms / 1000).toFixed(1)}s`)
  }
  console.log(
    `\n${results.length - failed}/${results.length} scenarios passed in ${((Date.now() - started) / 1000).toFixed(0)}s`,
  )
  if (files.length !== results.length) {
    console.log(`  ${files.length - results.length} scenario(s) not run - the gate stops at the first failure`)
  }
  return failed ? 1 : 0
}

process.exit(await main())
