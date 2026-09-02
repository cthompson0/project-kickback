/**
 * Does the packaged candidate actually contain the work we think we are
 * shipping?
 *
 *   npm run verify:candidate
 *
 * WHY THIS EXISTS
 *
 * M3D has been finished on `main` since before 0.7.0 shipped, and 0.7.0 does not
 * contain it. That is the defining fact of the last three milestones: two
 * complete measurement systems that observe nobody, because nothing ever
 * checked whether the ARTIFACT contained them. "It is on main" and "it is in the
 * build" are different claims, and only one of them affects a user.
 *
 * So this reads the built package - the bytes that would be uploaded - and
 * asserts the presence of every system the release is supposed to carry, plus
 * the absence of everything it must not.
 *
 * WHY STRING PRESENCE IS ENOUGH HERE
 *
 * It is a coarse check and it is the right coarseness. Minification renames
 * identifiers but never string literals, so a wire parameter, an RPC name, a
 * storage key or an OAuth scope survives the bundler exactly. This cannot prove
 * the code around those strings is correct - that is what the 3,000 deterministic
 * tests are for - but it is the only thing that can prove they SHIPPED.
 *
 * A guessed name is the failure mode: an early version of this looked for
 * `record_relationship`, which does not exist, and reported M3D absent from a
 * package that contains it. Every marker below is one that was verified to
 * exist in source first.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const version = JSON.parse(readFileSync('package.json', 'utf8')).version

const PACKAGES = [
  { label: 'Chrome Store candidate', file: `Watchside-Store-v${version}.zip` },
  { label: 'Firefox AMO candidate', file: `Watchside-AMO-Candidate-v${version}.zip` },
]

/**
 * What must be in the bundle, and why.
 *
 * Each marker is a string literal the bundler cannot rename, chosen because it
 * is load-bearing rather than incidental.
 */
const REQUIRED = [
  ['M3D', 'user:read:follows', 'the only Twitch scope Watchside asks for'],
  ['M3D', 'twitch-credential', 'the Edge Function that holds and uses the credential'],
  ['M3D', 'join_measurement_status', 'the event that says whether a JOIN could be measured'],
  ['M3D', 'grantFollowPermission', 'the path for accounts that predate the scope'],
  ['M5A', 'friend_suggestion_impression', 'suggestions, recorded at the render'],
  ['M5A', 'referral_succeeded', 'the growth loop’s outcome'],
  ['M5B', 'watchside/support', 'the support route a broken panel still reaches'],
  ['M5C', 'watchside_campaign', 'the campaign handoff parameter'],
  ['M5C', 'bind_acquisition', 'the RPC that binds a touch to an account'],
  ['M5C', 'watchside:campaignTouch', 'the durable pre-auth hold'],
  ['M5D', 'automatic_room_opened', 'whether the contextual tab is ever opened'],
  ['M5D', 'complementary', 'the panel’s landmark role'],
  ['compat', 'kickback_invite', 'the referral wire contract released clients read'],
]

/** What must NOT be in the bundle. */
const FORBIDDEN = [
  ['user:read:subscriptions', 'a scope on permanent hold'],
  ['user:read:emotes', 'a scope on permanent hold'],
  ['SUPABASE_SERVICE_ROLE', 'a server-only credential name'],
  ['service_role', 'a server-only role name'],
  ['sourceMappingURL', 'a source map reference'],
]

let failures = 0
const fail = (message) => {
  console.log(`  FAIL  ${message}`)
  failures += 1
}

function bundleOf(dir) {
  const parts = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.html')) {
        parts.push(readFileSync(path, 'utf8'))
      }
    }
  }
  return parts.join('\n')
}

console.log(`Watchside converged candidate v${version}\n`)

for (const pkg of PACKAGES) {
  console.log(pkg.label)
  const archive = join('releases', pkg.file)
  if (!existsSync(archive)) {
    fail(`${pkg.file} has not been built`)
    console.log()
    continue
  }

  const dir = mkdtempSync(join(tmpdir(), 'watchside-cand-'))
  try {
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dir}' -Force`,
    ])
    const bundle = bundleOf(dir)

    const missing = REQUIRED.filter(([, marker]) => !bundle.includes(marker))
    for (const [system, marker, why] of missing) {
      fail(`${system}: "${marker}" is not in the package - ${why}`)
    }
    if (missing.length === 0) {
      const systems = [...new Set(REQUIRED.map(([s]) => s))]
      console.log(`  ok    carries ${systems.join(' + ')} (${REQUIRED.length} markers)`)
    }

    const leaked = FORBIDDEN.filter(([marker]) => bundle.includes(marker))
    for (const [marker, why] of leaked) fail(`"${marker}" is in the package - ${why}`)
    if (leaked.length === 0) console.log(`  ok    none of the ${FORBIDDEN.length} forbidden markers`)

    // The manifest must agree about the version, or the Store rejects the upload
    // for a reason that reads as unrelated.
    const manifestPath = join(dir, 'manifest.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest.version !== version) {
        fail(`manifest says ${manifest.version}, package.json says ${version}`)
      } else {
        console.log(`  ok    manifest version ${manifest.version}`)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  console.log()
}

console.log(
  failures === 0
    ? `The candidate carries M3D + M5A-M5D and nothing it must not.`
    : `${failures} candidate problem(s) found.`,
)
process.exit(failures === 0 ? 0 : 1)
