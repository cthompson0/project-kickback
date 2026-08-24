/**
 * Mutation check for the combo contributor rules.
 *
 * The 2C.1 rules are social claims - "several people are chanting this", "you
 * cannot break your own combo" - and a test can assert a number without ever
 * proving the rule behind it. This breaks each guard in turn and asserts that
 * the test defending it actually goes red.
 *
 *   npm run test:combos
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const SUITE = 'tests/extension/comboContributors.test.ts'
const LEGACY_SUITE = 'tests/extension/combos.test.ts'
const COMBOS = 'src/core/combos.ts'

const MUTATIONS = [
  {
    name: 'contributor: let one person carry the combo alone',
    file: COMBOS,
    from: '      if (message.userId === runLastUserId) {\n        // Same person again: not a second voice, so it adds nothing. The run\n        // survives untouched, waiting for somebody else.\n        continue\n      }',
    to: '',
    expect: 'A A - one person alone is not a combo',
  },
  {
    name: 'contributor: treat a self-repeat as a break instead of a no-op',
    file: COMBOS,
    from: '      if (message.userId === runLastUserId) {\n        // Same person again: not a second voice, so it adds nothing. The run\n        // survives untouched, waiting for somebody else.\n        continue\n      }',
    to: '      if (message.userId === runLastUserId) {\n        closeRun(null)\n        continue\n      }',
    expect: 'A A B - a self-repeat is skipped, and the next person still joins in',
  },
  {
    name: 'contributor: require globally unique contributors',
    file: COMBOS,
    from: '      if (message.userId === runLastUserId) {',
    to: '      if (seenUsers.has(message.userId)) {',
    setup: (source) =>
      source
        .replace(
          '  let runLastUserId: string | null = null',
          '  let runLastUserId: string | null = null\n  const seenUsers = new Set<string>()',
        )
        .replace(
          '      runLastUserId = message.userId\n      continue',
          '      seenUsers.add(message.userId)\n      runLastUserId = message.userId\n      continue',
        )
        // The run's opener has to be recorded too, or this simulates nothing:
        // in A B A the first A was never added, so A was always free to return.
        .replace(
          '      runLastId = message.id\n      runLastUserId = message.userId\n    }',
          '      runLastId = message.id\n      runLastUserId = message.userId\n      seenUsers.add(message.userId)\n    }',
        ),
    expect: 'A B A - the same person may come back round',
  },
  {
    name: 'contributor: stop tracking who went last',
    file: COMBOS,
    from: '      runLastUserId = message.userId\n      continue',
    to: '      continue',
    expect: 'A B A B - alternating indefinitely is fine',
  },
  {
    name: 'breaker: let the last contributor break their own combo',
    file: COMBOS,
    from: '      // You cannot build a combo and then break it yourself for the credit.\n      breaker.userId !== runLastUserId',
    to: '      true',
    expect: 'gives no credit to the last contributor',
  },
  {
    name: 'breaker: credit a different emote as an interruption',
    file: COMBOS,
    from: '    closeRun(emote ? null : message)',
    to: '    closeRun(message)',
    expect: 'gives no credit for joining in with a different emote',
  },
  {
    name: 'breaker: drop the threshold',
    file: COMBOS,
    from: '      runCount >= COMBO_BREAKER_THRESHOLD &&',
    to: '      runCount >= 0 &&',
    expect: 'gives no credit below the threshold',
  },
  {
    name: 'active: report a run of one as active',
    file: COMBOS,
    from: '    runEmote && runCount >= COMBO_MIN_DISPLAY && runLastUserId',
    to: '    runEmote && runCount >= 1 && runLastUserId',
    expect: 'is nothing for a run of one',
  },
  {
    // Proves the run is genuinely terminated, not merely annotated: without
    // the reset, a combo that ended long ago is still reported as running.
    name: 'active: stop terminating the run when it closes',
    file: COMBOS,
    from: '    runEmote = null\n    runCount = 0\n    runLastId = null\n    runLastUserId = null',
    to: '    runLastId = null',
    expect: 'is nothing when the last message is ordinary text',
  },
  {
    name: 'identity: combo on emote name rather than provider and id',
    file: COMBOS,
    from: 'if (emote && runEmote && emoteKey(emote) === emoteKey(runEmote)) {',
    to: 'if (emote && runEmote && emote.name === runEmote.name) {',
    expect: 'does not combo two emotes that merely share a name',
  },
  {
    name: 'legacy: reinstate self-carried combos',
    file: COMBOS,
    from: '      if (message.userId === runLastUserId) {\n        // Same person again: not a second voice, so it adds nothing. The run\n        // survives untouched, waiting for somebody else.\n        continue\n      }',
    to: '',
    expect: 'refuses to let one person carry a combo alone',
    suite: LEGACY_SUITE,
  },
]

const REPORT = join(tmpdir(), 'kickback-combo-mutation.json')

function runSuite(suite) {
  rmSync(REPORT, { force: true })

  let crashOutput = null
  try {
    execFileSync('npx', ['vitest', 'run', suite, '--reporter=json', `--outputFile=${REPORT}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
  } catch (error) {
    crashOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }

  if (!existsSync(REPORT)) return { failures: [], crashed: crashOutput ?? 'no report written' }

  const report = JSON.parse(readFileSync(REPORT, 'utf8'))
  const failures = []
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status === 'failed') failures.push(assertion.title)
    }
  }
  if (failures.length === 0 && (report.numTotalTests ?? 0) === 0) {
    return { failures: [], crashed: crashOutput ?? 'suite ran no tests' }
  }
  return { failures, crashed: null }
}

let failed = 0

for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, 'utf8')

  if (!original.includes(mutation.from)) {
    console.log(`SKIPPED  ${mutation.name}`)
    console.log(`         anchor no longer present in ${mutation.file} - update this check`)
    failed += 1
    continue
  }

  const prepared = mutation.setup ? mutation.setup(original) : original
  writeFileSync(mutation.file, prepared.replace(mutation.from, () => mutation.to))

  let result
  try {
    result = runSuite(mutation.suite ?? SUITE)
  } finally {
    writeFileSync(mutation.file, original)
  }

  if (result.crashed) {
    console.log(`INCONCLUSIVE ${mutation.name}`)
    console.log(`         the mutated source did not run: ${result.crashed.slice(0, 160)}`)
    failed += 1
    continue
  }

  if (result.failures.some((name) => name.includes(mutation.expect))) {
    console.log(`DETECTED ${mutation.name}`)
    console.log(`         caught by: ${mutation.expect}`)
  } else if (result.failures.length > 0) {
    console.log(`MISATTRIBUTED ${mutation.name}`)
    console.log(`         expected: ${mutation.expect}`)
    console.log(`         actual:   ${result.failures.slice(0, 4).join(', ')}`)
    failed += 1
  } else {
    console.log(`UNDETECTED ${mutation.name}`)
    console.log('         no test noticed - the suite does not defend this')
    failed += 1
  }
}

console.log(
  failed === 0
    ? `\nAll ${MUTATIONS.length} combo mutations detected.`
    : `\n${failed} of ${MUTATIONS.length} mutations were not properly detected.`,
)
process.exit(failed === 0 ? 0 : 1)
