/**
 * Mutation check for the external-emote suite.
 *
 * The emote tests assert properties that are easy to write and easy to
 * silently lose: identity by provider+id rather than by name, provider
 * payloads being untrusted, and one channel's emotes not surviving into the
 * next. This script breaks each of those in the real source, re-runs the
 * suite, and asserts that the test which is supposed to notice actually goes
 * red. A safeguard no test defends is not a safeguard.
 *
 *   npm run test:emotes
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const SUITE = 'tests/extension/externalEmotes.test.ts'

const MUTATIONS = [
  {
    name: 'combos: match on name instead of provider+id',
    file: 'src/core/combos.ts',
    from: 'if (emote && runEmote && emoteKey(emote) === emoteKey(runEmote)) {',
    to: 'if (emote && runEmote && emote.name === runEmote.name) {',
    expect: 'does not combo two different emotes that share a name',
  },
  {
    name: 'identity: key an emote by its name',
    file: 'src/core/emotes.ts',
    from: 'return `${emote.provider}:${emote.id}`',
    to: 'return `${emote.provider}:${emote.name}`',
    expect: 'combos a renamed emote with its earlier self',
  },
  {
    name: 'urls: trust the host the provider sent',
    file: 'src/background/sevenTv.ts',
    from: '  const url = externalEmoteUrl(\'7tv\', raw.id)\n  if (!url) return null',
    to: '  const url =\n    (raw as { data?: { host?: { url?: string } } }).data?.host?.url ??\n    externalEmoteUrl(\'7tv\', raw.id)\n  if (!url) return null',
    expect: 'ignores a provider-supplied host and derives the URL itself',
  },
  {
    name: 'urls: stop validating the emote id',
    file: 'src/core/emotes.ts',
    from: '  if (!EXTERNAL_ID.test(id)) return null\n  switch (provider) {',
    to: '  switch (provider) {',
    expect: 'refuses to build a URL from an id that is not an id',
  },
  {
    name: 'names: accept whatever the provider called it',
    file: 'src/background/sevenTv.ts',
    from: '  if (!BARE_NAME.test(name)) return null',
    to: '  if (name.length === 0) return null',
    expect: 'drops a name that could not be typed as a word',
  },
  {
    name: 'tokens: render a token whose provider yields no URL',
    file: 'src/core/emotes.ts',
    from: '  const url = externalEmoteUrl(provider, id)\n  if (!url) return null',
    to: '  const url = externalEmoteUrl(provider, id)',
    expect: 'shows an unparseable token as literal text rather than guessing',
  },
  {
    name: 'tokens: stop validating the emote name in a token',
    file: 'src/core/emotes.ts',
    from: '  if (!EXTERNAL_NAME.test(name)) return null\n',
    to: '',
    expect: 'shows an unparseable token as literal text rather than guessing',
  },
  {
    name: 'catalog: keep the old channel set after navigating away',
    file: 'src/background/emoteCatalog.ts',
    from: '      channelSet = target ? (channelCache.get(target) ?? null) : null',
    to: '      if (target) channelSet = channelCache.get(target) ?? channelSet',
    expect: 'drops the previous channel set the instant the channel changes',
  },
  {
    name: 'catalog: let an in-flight load land on the wrong channel',
    file: 'src/background/emoteCatalog.ts',
    from: '      if (channel === target) channelSet = entry',
    to: '      channelSet = entry',
    expect: 'discards a channel load that lands after the user has moved on',
  },
  {
    name: 'send: resolve emote names case-insensitively',
    file: 'src/background/emoteCatalog.ts',
    from: '        if (!byName.has(emote.name)) byName.set(emote.name, emote)',
    to: '        if (!byName.has(emote.name.toLowerCase())) byName.set(emote.name.toLowerCase(), emote)',
    alsoFrom: '          const emote = byName.get(part)',
    alsoTo: '          const emote = byName.get(part.toLowerCase())',
    expect: 'is case sensitive, the way emote names are',
  },
  {
    name: 'send: let global emotes outrank the channel',
    file: 'src/background/emoteCatalog.ts',
    from: '    return [...(channelSet?.emotes ?? []), ...(globalSet?.emotes ?? [])]',
    to: '    return [...(globalSet?.emotes ?? []), ...(channelSet?.emotes ?? [])]',
    expect: 'gives the channel emote the name when global has one too',
  },
  {
    name: 'picker: lift the per-section cap',
    file: 'src/background/emoteCatalog.ts',
    from: 'export const SEARCH_LIMIT = 60',
    to: 'export const SEARCH_LIMIT = 100000',
    expect: 'caps each section so a huge channel cannot flood the picker',
  },
  {
    name: '7tv: take the first fuzzy search hit',
    file: 'src/background/sevenTv.ts',
    from: '            entry.username.toLowerCase() === clean &&',
    to: '            typeof entry.username === \'string\' &&',
    expect: 'rejects a fuzzy match that is not the login asked for',
  },
]

const REPORT = join(tmpdir(), 'kickback-emote-mutation.json')

/**
 * Runs the suite and returns the names of the tests that failed.
 *
 * Reads the JSON report rather than scraping console output. A mutation that
 * stops the suite compiling would otherwise look identical to one a test
 * caught, and telling those apart is the whole point of this script.
 */
function runSuite() {
  rmSync(REPORT, { force: true })

  let crashOutput = null
  try {
    execFileSync(
      'npx',
      ['vitest', 'run', SUITE, '--reporter=json', `--outputFile=${REPORT}`],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      },
    )
  } catch (error) {
    crashOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }

  if (!existsSync(REPORT)) {
    return { failures: [], crashed: crashOutput ?? 'no report written' }
  }

  const report = JSON.parse(readFileSync(REPORT, 'utf8'))
  const failures = []
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status === 'failed') failures.push(assertion.title)
    }
  }
  // A report with no tests at all means the file never ran.
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

  let mutated = original.replace(mutation.from, () => mutation.to)
  if (mutation.alsoFrom) {
    if (!original.includes(mutation.alsoFrom)) {
      console.log(`SKIPPED  ${mutation.name} - secondary anchor missing`)
      failed += 1
      continue
    }
    mutated = mutated.replace(mutation.alsoFrom, () => mutation.alsoTo)
  }

  writeFileSync(mutation.file, mutated)
  let result
  try {
    result = runSuite()
  } finally {
    writeFileSync(mutation.file, original)
  }

  if (result.crashed) {
    // A mutation that will not even build proves nothing about the tests.
    console.log(`INCONCLUSIVE ${mutation.name}`)
    console.log(`         the mutated source did not run: ${result.crashed.slice(0, 200)}`)
    failed += 1
    continue
  }

  const caught = result.failures.some((name) => name.includes(mutation.expect))
  if (caught) {
    console.log(`DETECTED ${mutation.name}`)
    console.log(`         caught by: ${mutation.expect}`)
  } else if (result.failures.length > 0) {
    // Something went red, but not the test that claims to defend this.
    console.log(`MISATTRIBUTED ${mutation.name}`)
    console.log(`         expected: ${mutation.expect}`)
    console.log(`         actual:   ${result.failures.join(', ')}`)
    failed += 1
  } else {
    console.log(`UNDETECTED ${mutation.name}`)
    console.log(`         no test noticed - the suite does not defend this`)
    failed += 1
  }
}

console.log(
  failed === 0
    ? `\nAll ${MUTATIONS.length} emote mutations detected.`
    : `\n${failed} of ${MUTATIONS.length} mutations were not properly detected.`,
)
process.exit(failed === 0 ? 0 : 1)
