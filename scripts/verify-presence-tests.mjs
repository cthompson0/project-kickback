/**
 * Mutation check for presence consistency.
 *
 * The bug this defends against was not a crash and not a wrong string - it was
 * two copies of the same fact drifting apart, which every individual assertion
 * about either copy would have passed. So the tests assert that the copies are
 * the *same value*, and this script proves those assertions bite.
 *
 *   npm run test:presence
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const SUITE = 'tests/extension/presenceConsistency.test.ts'
const PERSON_SUITE = 'tests/extension/personPresence.test.ts'
const INDEX = 'src/background/presenceIndex.ts'
const PERSON = 'src/core/personPresence.ts'
const CARD_SUITE = 'tests/extension/cardConsistency.test.tsx'
const CARD = 'src/ui/components/UserCard.tsx'
const GROUP = 'src/core/groupPresence.ts'

const MUTATIONS = [
  {
    // The original bug, restored: group rosters keep whatever presence they
    // were fetched with, and never hear about a change again.
    name: 'index: stop stamping group members',
    file: INDEX,
    from: '      const presence = index[member.user.id]\n      return presence && presence !== member.presence ? { ...member, presence } : member',
    to: '      return member',
    expect: 'agrees on a member who is visibly watching',
  },
  {
    name: 'index: stop stamping friends',
    file: INDEX,
    from: '    const presence = index[friend.user.id]\n    return presence && presence !== friend.presence ? { ...friend, presence } : friend',
    to: '    return friend',
    expect: 'agrees on a member who is visibly watching',
  },
  {
    name: 'index: let a realtime patch lose to an older snapshot',
    file: INDEX,
    from: 'export function setPresence(index: PresenceIndex, presence: Presence): PresenceIndex {\n  if (index[presence.userId] === presence) return index\n  return { ...index, [presence.userId]: presence }',
    to: 'export function setPresence(index: PresenceIndex, presence: Presence): PresenceIndex {\n  return mergePresence(index, [presence])',
    expect: 'lets a realtime patch win over a snapshot regardless of timestamps',
  },
  {
    name: 'index: keep the older of two snapshots',
    file: INDEX,
    from: '  return bAt >= aAt ? b : a',
    to: '  return a',
    expect: 'keeps the freshest of two snapshots for one person',
  },
  {
    name: 'index: treat a vanished row as merely quiet',
    file: INDEX,
    from: "    [userId]: { userId, status: 'offline', activity: { type: 'idle' }, since: now },",
    to: '    [userId]: current,',
    expect: 'treats a vanished presence row as offline, not as stale data',
  },
  {
    name: 'index: never forget anyone',
    file: INDEX,
    from: '    if (drop.has(userId)) {\n      changed = true\n      continue\n    }',
    to: '',
    expect: 'forgets people we can no longer see',
  },
  {
    // The half that made the bug invisible to client-side fixes: the channel
    // only ever subscribed to friends.
    name: 'subscription: watch friends only',
    file: INDEX,
    from: '  for (const roster of Object.values(members)) {\n    for (const member of roster) ids.add(member.user.id)\n  }',
    to: '',
    expect: 'watches friends and group members alike',
  },
  {
    name: 'subscription: subscribe to ourselves',
    file: INDEX,
    from: '  if (selfId) ids.delete(selfId)',
    to: '',
    expect: 'never subscribes to itself',
  },
  {
    name: 'subscription: return an unstable order',
    file: INDEX,
    from: '  return [...ids].sort()',
    to: '  return [...ids].reverse()',
    expect: 'is stable, so an unchanged set does not resubscribe',
  },

  // ------------------------------------------------- same-channel JOIN
  {
    // The reported bug: the card offered a JOIN that reloaded the stream the
    // viewer was already watching.
    name: 'presence: offer JOIN to where the viewer already is',
    file: PERSON,
    from: "  const here = viewerChannel(viewer)\n  if (here !== null && here === channel) {\n    return { kind: 'watching_with_you', channel, canJoin: false }\n  }",
    to: '',
    expect: 'reports watching with you when both are on the same channel',
    suite: PERSON_SUITE,
  },
  {
    name: 'presence: keep JOIN enabled while watching together',
    file: PERSON,
    from: "    return { kind: 'watching_with_you', channel, canJoin: false }",
    to: "    return { kind: 'watching_with_you', channel, canJoin: true }",
    expect: 'offers no JOIN to where the viewer already is',
    suite: PERSON_SUITE,
  },
  {
    name: 'presence: compare channels case-sensitively',
    file: PERSON,
    from: '  const channel = presence.activity.channel?.trim().toLowerCase()\n  if (!channel) return',
    to: '  const channel = presence.activity.channel?.trim()\n  if (!channel) return',
    expect: 'matches the same channel however either side was cased',
    suite: PERSON_SUITE,
  },
  {
    name: 'presence: treat a viewer with no channel as being everywhere',
    file: PERSON,
    from: '  if (here !== null && here === channel) {',
    to: '  if (here === null || here === channel) {',
    expect: 'never claims someone is with a viewer who has no channel',
    suite: PERSON_SUITE,
  },
  {
    name: 'join guard: let the action navigate to the current channel',
    file: PERSON,
    from: '  const target = destination?.trim().toLowerCase()\n  if (!target) return false\n  return viewerChannel(viewer) === target',
    to: '  return false',
    expect: 'recognises a destination the viewer is already at',
    suite: PERSON_SUITE,
  },

  // ---------------------------------------------------- self exclusion
  {
    // The viewer appeared in their own "watching with you" row.
    name: 'self: count the viewer as one of the other people',
    file: GROUP,
    from: '    if (selfId !== null && (entry.userId ?? entry.presence?.userId) === selfId) continue',
    to: '',
    expect: 'leaves the viewer out of the people they are watching with',
    suite: PERSON_SUITE,
  },
  {
    name: 'self: identify the viewer only by their presence row',
    file: GROUP,
    from: '(entry.userId ?? entry.presence?.userId) === selfId',
    to: 'entry.presence?.userId === selfId',
    expect: 'excludes the viewer even when they have shared no presence at all',
    suite: PERSON_SUITE,
  },
  {
    name: 'self: count the viewer as somebody who is around',
    file: GROUP,
    from: '      (selfId === null || (entry.userId ?? entry.presence?.userId) !== selfId) &&\n      isAround(entry.presence, now),',
    to: '      isAround(entry.presence, now),',
    expect: 'counts only other people as being around',
    suite: PERSON_SUITE,
  },

  // ------------------------------------------------ the card's context
  {
    // The reported bug, restored: the card decides without knowing what the
    // viewer is doing, so the chat entry point offers a same-channel JOIN.
    name: 'card: decide without the viewer context',
    file: CARD,
    from: '    : describePresence(presence, context.viewerActivity)',
    to: '    : describePresence(presence, null)',
    expect: 'says watching with you, and offers no JOIN from group chat',
    suite: CARD_SUITE,
  },
  {
    name: 'card: read your own presence like anybody else',
    file: CARD,
    from: '    ? describeSelf(context.viewerActivity)',
    to: '    ? describePresence(presence, context.viewerActivity)',
    expect: 'reports your own activity from the local path, not from presence',
    suite: CARD_SUITE,
  },
  {
    name: 'card: let a self card offer friendship controls',
    file: CARD,
    from: '  const isSelf = context.selfId !== null && user.id === context.selfId',
    to: '  const isSelf = false',
    expect: 'offers no friendship controls',
    suite: CARD_SUITE,
  },
  {
    name: 'self: report yourself as joinable',
    file: PERSON,
    from: "    ? { kind: 'watching_elsewhere', channel, canJoin: false }",
    to: "    ? { kind: 'watching_elsewhere', channel, canJoin: true }",
    expect: 'reports what you are watching, with nowhere to join',
    suite: CARD_SUITE,
  },
]

const REPORT = join(tmpdir(), 'kickback-presence-mutation.json')

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

  writeFileSync(mutation.file, original.replace(mutation.from, () => mutation.to))
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
    ? `\nAll ${MUTATIONS.length} presence mutations detected.`
    : `\n${failed} of ${MUTATIONS.length} mutations were not properly detected.`,
)

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(failed === 0 ? 0 : 1)
}
