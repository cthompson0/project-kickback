/**
 * Do the builds people are actually running still work against this backend?
 *
 *   npm run verify:released
 *
 * WHY THIS EXISTS, AND WHY IT READS THE ZIPS
 *
 * Every milestone since 0.7.0 shipped has advanced the schema - 0033 through
 * 0038 - while Chrome 0.7 has been live and Firefox 0.6 has been sitting in
 * AMO's first-review queue. Additive-only was the intent at each step and was
 * argued in each migration's header, but nothing ever CHECKED it against the
 * artifact somebody is running. "Additive by inspection" is how a client gets
 * stranded by the one call nobody remembered it made.
 *
 * So this reads the RELEASED PACKAGES rather than the source they came from.
 * Source tells you what HEAD calls; only the artifact tells you what a person
 * on 0.7 calls, and those diverge the moment a call site is removed.
 *
 * WHAT IT PROVES
 *
 *   * every RPC the released worker invokes still exists in the schema, and is
 *     still granted to `authenticated`;
 *   * every Edge Function it invokes still exists in the repository;
 *   * the analytics event registry has only ever been added to, never
 *     deleted from - which is what keeps an old client's events recorded.
 *
 * That last one is the quiet failure. `analytics_track` SKIPS unknown event
 * names rather than rejecting the batch, so removing a name from the registry
 * would not break an old client - it would silently stop recording it, and the
 * gap would show up weeks later as a funnel that thinned out for no reason.
 *
 * WHAT IT CANNOT PROVE
 *
 * That the runtime behaviour is unchanged - only that the surface an old client
 * reaches for is still there. Behavioural compatibility is what the DB suites
 * cover, against real Postgres.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const RELEASES = 'releases'
const MIGRATIONS = join('supabase', 'migrations')
const FUNCTIONS = join('supabase', 'functions')

/**
 * The builds that are live or queued, and therefore must not be stranded.
 *
 * KEPT CURRENT DELIBERATELY. This list said "Firefox 0.6.0 (awaiting first AMO
 * review)" for a while after Mozilla approved 0.8.0 and made it the build
 * Firefox users actually run - so the script was proving compatibility for a
 * version nobody had while saying nothing about the one everybody had. A
 * compatibility check aimed at the wrong artifact is worse than none, because
 * it reports success.
 *
 * 0.6.0 stays alongside it: AMO does not force updates instantly, so somebody
 * is still running it.
 */
const RELEASED = [
  { label: 'Chrome 0.7.0 (live)', file: 'Watchside-Store-v0.7.0.zip' },
  { label: 'Chrome 0.8.0 (submitted, in review)', file: 'Watchside-Store-v0.8.0.zip' },
  { label: 'Firefox 0.8.0 (live on AMO)', file: 'Watchside-AMO-Candidate-v0.8.0.zip' },
  { label: 'Firefox 0.6.0 (still installed by some)', file: 'Watchside-Firefox-v0.6.0.zip' },
]

let failures = 0
const fail = (message) => {
  console.log(`  FAIL  ${message}`)
  failures += 1
}
const pass = (message) => console.log(`  ok    ${message}`)

// --------------------------------------------------------------- the schema

const schema = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
  .join('\n')

/** Function names the schema defines, however they are declared. */
const definedFunctions = new Set(
  [...schema.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.([a-z0-9_]+)\s*\(/gi)].map(
    (m) => m[1].toLowerCase(),
  ),
)

/** Function names granted to the client role. */
const grantedFunctions = new Set(
  [...schema.matchAll(/grant\s+execute\s+on\s+function\s+public\.([a-z0-9_]+)\s*\([^)]*\)\s*to\s+authenticated/gi)].map(
    (m) => m[1].toLowerCase(),
  ),
)

/** Analytics event names the contract knows. */
const registeredEvents = new Set(
  [...schema.matchAll(/^\s*\('([a-z0-9_]+)',/gim)].map((m) => m[1]),
)

const edgeFunctions = new Set(existsSync(FUNCTIONS) ? readdirSync(FUNCTIONS) : [])

// ------------------------------------------------------------- the artifacts

function unpack(file) {
  const dir = mkdtempSync(join(tmpdir(), 'watchside-rc-'))
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${join(RELEASES, file)}' -DestinationPath '${dir}' -Force`,
  ])
  return dir
}

/**
 * The bundled worker, wherever the package put it.
 *
 * The Chrome Store package is flat; the private-beta package nests one folder
 * deep. Searching rather than assuming keeps this working across both.
 */
function workerSource(dir) {
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.name.endsWith('-background.js')) return readFileSync(path, 'utf8')
    }
  }
  return null
}

console.log('Watchside released-client compatibility\n')
console.log(`  schema functions   : ${definedFunctions.size}`)
console.log(`  granted to clients : ${grantedFunctions.size}`)
console.log(`  registered events  : ${registeredEvents.size}\n`)

for (const release of RELEASED) {
  console.log(release.label)
  const archive = join(RELEASES, release.file)
  if (!existsSync(archive)) {
    /*
     * Absent is a FAILURE, not a skip. A compatibility check that quietly
     * passes when it cannot find the thing it is checking is worse than none,
     * because it reports success for work it did not do.
     */
    fail(`${release.file} is not in ${RELEASES}/ - cannot verify this client`)
    console.log()
    continue
  }

  const dir = unpack(release.file)
  try {
    const worker = workerSource(dir)
    if (!worker) {
      fail('no background bundle found inside the package')
      continue
    }

    // ---- RPCs ------------------------------------------------------------
    const rpcs = new Set(
      [...worker.matchAll(/\.rpc\(\s*["'`]([a-z0-9_]+)["'`]/gi)].map((m) => m[1].toLowerCase()),
    )
    const missingRpcs = [...rpcs].filter((name) => !definedFunctions.has(name))
    const ungranted = [...rpcs].filter(
      (name) => definedFunctions.has(name) && !grantedFunctions.has(name),
    )

    if (missingRpcs.length > 0) fail(`RPCs no longer defined: ${missingRpcs.join(', ')}`)
    else pass(`all ${rpcs.size} RPCs it calls still exist`)

    if (ungranted.length > 0) fail(`RPCs no longer granted to authenticated: ${ungranted.join(', ')}`)
    else pass('all of them are still granted to authenticated')

    // ---- Edge Functions --------------------------------------------------
    const invoked = new Set(
      [...worker.matchAll(/functions\.invoke\(\s*["'`]([a-z0-9-]+)["'`]/gi)].map((m) => m[1]),
    )
    const missingFunctions = [...invoked].filter((name) => !edgeFunctions.has(name))
    if (missingFunctions.length > 0) fail(`Edge Functions removed: ${missingFunctions.join(', ')}`)
    else pass(`all ${invoked.size} Edge Functions it calls still exist`)

    // ---- analytics -------------------------------------------------------
    /*
     * The risk here is REMOVAL, not mismatch.
     *
     * `analytics_track` skips an unknown event name rather than rejecting the
     * batch, so deleting a name from the registry would not break an old
     * client - it would silently stop recording it, and the gap would surface
     * weeks later as a funnel that thinned out for no reason.
     *
     * A first attempt guessed which quoted strings in the minified bundle were
     * event names, by suffix. It produced four false positives immediately -
     * `post_social_ended`, `session_ended`, `stream_ended`, `request_sent` are
     * internal discriminators and enum members, not events. Minified code
     * cannot be read that way.
     *
     * So this checks the property that actually matters, directly against the
     * schema: the registry is only ever added to. If nothing is ever removed,
     * every name any released client emits is still registered by construction.
     */
    const removals = [
      ...schema.matchAll(/deletes+froms+public.analytics_event_names[^;]*/gi),
    ].map((m) => m[0].replace(/s+/g, ' ').slice(0, 120))
    if (removals.length > 0) {
      fail(`the event registry is deleted from: ${removals.join(' | ')}`)
    } else {
      pass(`the event registry is append-only (${registeredEvents.size} names, none removed)`)
    }

    // ---- manifest --------------------------------------------------------
    const manifestPath = (() => {
      const stack = [dir]
      while (stack.length > 0) {
        const current = stack.pop()
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const path = join(current, entry.name)
          if (entry.isDirectory()) stack.push(path)
          else if (entry.name === 'manifest.json') return path
        }
      }
      return null
    })()
    if (manifestPath) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      pass(`manifest version ${manifest.version}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  console.log()
}

console.log(
  failures === 0
    ? 'Released clients remain compatible with this backend.'
    : `${failures} compatibility problem(s) found.`,
)
process.exit(failures === 0 ? 0 : 1)
