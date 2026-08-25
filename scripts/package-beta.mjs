/**
 * Builds the private-beta archive.
 *
 *   npm run package:beta
 *
 * The archive is what a tester actually installs, so this refuses to produce
 * one unless every precondition holds:
 *
 *   - the Supabase key really works        (verify:config)
 *   - the group backend really exists      (verify:groups)
 *   - the build is production, not demo
 *   - the manifest still pins the extension ID the OAuth allow-list expects
 *   - the staged files are exactly the runtime files, nothing else
 *   - neither the staged files nor the finished archive contain a secret
 *
 * Every check fails loudly. A beta that half-works is worse than no beta,
 * because the tester's report is then about our packaging rather than the
 * product.
 *
 * Nothing is copied wholesale: the file list is an allow-list, so a stray file
 * appearing in dist/ cannot silently end up in a tester's hands.
 */
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { listZip, writeZip } from './zip.mjs'
import { verifyGroupSchema } from './verify-group-schema.mjs'
import { verifyAnalyticsSchema } from './verify-analytics.mjs'

const DIST = 'dist'
const RELEASES = 'releases'
/** The folder name a tester selects in Load unpacked. */
const FOLDER = 'Kickback'

const EXPECTED_EXTENSION_ID = 'almhfkicihekhiloapoimglfdoneglni'

/**
 * Exactly what a tester needs at runtime, and nothing else.
 *
 * An allow-list rather than "copy dist/ and delete the bad bits": the failure
 * mode of a deny-list is shipping something nobody thought to exclude.
 */
const RUNTIME_FILES = [
  'manifest.json',
  'kickback-content.js',
  'kickback-background.js',
  'popup.html',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
]

/**
 * Things that must never appear in the package, by name.
 *
 * Matched against the archive path, case-insensitively.
 */
const FORBIDDEN_PATHS = [
  '.env',
  '.keys',
  '.pem',
  '.git',
  'node_modules',
  'dist-demo',
  'src/',
  'tests/',
  'scripts/',
  'supabase/',
  '.map',
  'cookies',
  'local storage',
  'session storage',
  'default/',
  '.crx',
  '.zip',
]

/**
 * Secrets, matched against file contents.
 *
 * Patterns rather than bare words, because the difference between a secret and
 * a mention of one matters. `@supabase/supabase-js` ships a function that
 * asks whether a key starts with "sb_secret_", so the bare prefix appears in
 * the bundle with no key attached; rejecting on that would be a false alarm
 * that teaches us to ignore the scanner. What must never appear is an actual
 * key, so the pattern requires the value.
 *
 * The publishable key is deliberately absent from this list: it is public
 * client config and belongs in the bundle. It cannot be confused with
 * `sb_secret_`, which is a different prefix.
 */
const FORBIDDEN_CONTENT = [
  // A real secret key, not the SDK's prefix check.
  { label: 'a Supabase secret key', pattern: /sb_secret_[A-Za-z0-9_-]{10,}/ },
  { label: 'the service-role role', pattern: /service_role/ },
  { label: 'an OAuth client secret', pattern: /client_secret/ },
  { label: 'a private key block', pattern: /BEGIN (RSA |ENCRYPTED )?PRIVATE KEY/ },
  { label: 'a Postgres connection string', pattern: /postgres(ql)?:\/\// },
  { label: 'a superuser role', pattern: /supabase_admin/ },
  { label: 'an env file line', pattern: /VITE_SUPABASE_PUBLISHABLE_KEY\s*=/ },
]

/**
 * Rules that apply to one file only.
 *
 * `provider_token` lives in supabase-js's session parser, so the service
 * worker legitimately contains the string. The rule that matters is that it
 * never reaches the Twitch page, where page scripts could see it.
 */
const FILE_SCOPED_CONTENT = {
  'kickback-content.js': [
    { label: 'Twitch provider token handling', pattern: /provider_(refresh_)?token/ },
    { label: 'a direct Twitch API call', pattern: /api\.twitch\.tv/ },
  ],
}

/**
 * Demo-mode fingerprints. None of this may reach a tester.
 *
 * The demo client, the mock presence service and the scripted people are all
 * behind a build-time constant, so a production build drops them entirely -
 * including the wording. If any of this survives, the artifact was built in
 * the wrong mode.
 */
const DEMO_MARKERS = [
  'createDemoClient',
  'mockPresenceService',
  'DEMO_UNAVAILABLE',
  'demo mode',
  'The Boys',
  'jakethesnake',
  'Late Night Crew',
  'DEMO_FOLLOWER',
]

/** A JWT-shaped literal. A service-role key is one; a publishable key is not. */
const JWT_LITERAL = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./

const problems = []
const fail = (message) => problems.push(message)

function step(label) {
  console.log(`\n== ${label}`)
}

function run(command, args, env) {
  execFileSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: env ? { ...process.env, ...env } : process.env,
  })
}

/** Extension IDs are the first 128 bits of SHA-256 over the DER public key. */
function extensionIdFromKey(base64Key) {
  const hash = createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('hex')
  return [...hash.slice(0, 32)].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join('')
}

function walk(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, base))
    else out.push(relative(base, full).split('\\').join('/'))
  }
  return out
}

function scanContents(root, files, where) {
  for (const file of files) {
    const full = join(root, file)
    const isText = /\.(js|json|html|txt|css|map)$/i.test(file)
    if (!isText) continue

    const text = readFileSync(full, 'utf8')
    for (const { label, pattern } of FORBIDDEN_CONTENT) {
      if (pattern.test(text)) fail(`${where}: ${file} contains ${label}`)
    }
    for (const { label, pattern } of FILE_SCOPED_CONTENT[file] ?? []) {
      if (pattern.test(text)) fail(`${where}: ${file} contains ${label}`)
    }
    for (const marker of DEMO_MARKERS) {
      if (text.includes(marker)) fail(`${where}: ${file} contains demo marker "${marker}"`)
    }
    if (JWT_LITERAL.test(text)) fail(`${where}: ${file} contains a JWT-shaped literal`)
  }
}

function checkPaths(paths, where) {
  for (const path of paths) {
    const lower = path.toLowerCase()
    for (const forbidden of FORBIDDEN_PATHS) {
      if (lower.includes(forbidden)) fail(`${where}: forbidden path "${path}" (matched ${forbidden})`)
    }
  }
}

async function main() {
  // ---------------------------------------------------------- preflight
  step('Verifying Supabase configuration')
  run('node', ['scripts/verify-supabase-config.mjs'])

  /*
   * Analytics and feedback, before anything is built.
   *
   * A tester's report has to be about the product rather than about our
   * deployment, and a Feedback button whose RPC does not exist would produce
   * exactly the wrong kind of first impression. This is also what catches a
   * half-applied schema: everything 0013-0023 add is revoked from clients, so
   * "permission denied" is the healthy answer and absence is the signal.
   */
  step('Verifying the hosted analytics and feedback schema')
  const analytics = await verifyAnalyticsSchema()
  if (!analytics.ok) {
    console.error('\nRefusing to package: telemetry or feedback would be broken for testers.')
    return 1
  }

  step('Verifying the hosted group backend')
  const groups = await verifyGroupSchema()
  if (!groups.ok) {
    console.error('\nRefusing to package: groups and chat would be broken for testers.')
    return 1
  }

  // ------------------------------------------------------------- build
  step('Building the production bundles')
  // A fresh build, so the archive can never contain yesterday's output.
  rmSync(DIST, { recursive: true, force: true })
  /*
   * The beta ZIP is built as private_beta, here rather than in .env.local.
   *
   * Whoever is packaging is also developing, and their .env.local says
   * development - which is right for them and wrong for the archive. Setting
   * it at the build call means the ZIP cannot inherit a local mistake, and a
   * tester's numbers are never mixed into a public cohort by accident.
   */
  run('npm', ['run', 'build'], { VITE_KICKBACK_ENV: 'private_beta' })

  step('Inspecting the build')
  const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'))
  const version = manifest.version
  console.log(`  version        : ${version}`)

  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) fail(`manifest version "${version}" is not x.y.z`)

  if (typeof manifest.key !== 'string' || manifest.key.length < 300) {
    fail('manifest has no pinned key - the extension ID would be random per machine')
  } else {
    const id = extensionIdFromKey(manifest.key)
    console.log(`  extension id   : ${id}`)
    if (id !== EXPECTED_EXTENSION_ID) {
      fail(`extension id ${id} does not match the OAuth allow-list (${EXPECTED_EXTENSION_ID})`)
    }
  }

  for (const file of RUNTIME_FILES) {
    if (!existsSync(join(DIST, file))) fail(`build is missing ${file}`)
  }

  /*
   * The archive must say private_beta, and must not say production.
   *
   * Analytics from testers exist to prove the pipeline works; they must be
   * removable before launch, and that only works if every event they produce
   * is labelled. Checking the artifact rather than the intent, because the
   * environment is a build-time constant and this is what actually shipped.
   */
  const worker = readFileSync(join(DIST, 'kickback-background.js'), 'utf8')
  if (!worker.includes('private_beta')) {
    fail('the worker was not built with VITE_KICKBACK_ENV=private_beta')
  }
  console.log('  analytics env  : private_beta')

  // The demo build writes to dist-demo/, but check anyway: a demo-mode build
  // written into dist/ would look identical from the outside.
  scanContents(DIST, RUNTIME_FILES.filter((f) => existsSync(join(DIST, f))), 'build')

  if (problems.length > 0) return report()

  // ------------------------------------------------------------ stage
  step('Staging the package')
  const staging = mkdtempSync(join(tmpdir(), 'kickback-pkg-'))
  const root = join(staging, FOLDER)
  mkdirSync(root, { recursive: true })

  for (const file of RUNTIME_FILES) {
    const target = join(root, file)
    mkdirSync(join(target, '..'), { recursive: true })
    cpSync(join(DIST, file), target)
  }
  writeFileSync(join(root, 'README-TESTERS.txt'), readmeForTesters(version), 'utf8')

  const staged = walk(root).sort()
  console.log(`  ${staged.length} files`)
  for (const file of staged) console.log(`    ${file}`)

  const expected = [...RUNTIME_FILES, 'README-TESTERS.txt'].sort()
  if (JSON.stringify(staged) !== JSON.stringify(expected)) {
    fail(`staged files do not match the allow-list\n  got:      ${staged}\n  expected: ${expected}`)
  }
  checkPaths(staged, 'staging')
  scanContents(root, staged, 'staging')

  if (problems.length > 0) return report()

  // -------------------------------------------------------------- zip
  step('Writing the archive')
  mkdirSync(RELEASES, { recursive: true })
  const zipPath = join(RELEASES, `Kickback-Private-Beta-v${version}.zip`)
  rmSync(zipPath, { force: true })

  writeZip(
    zipPath,
    staged.map((file) => ({ name: `${FOLDER}/${file}`, source: join(root, file) })),
  )
  console.log(`  ${zipPath}  (${(statSync(zipPath).size / 1024).toFixed(1)} KB)`)

  // --------------------------------------------------------- inspect
  step('Inspecting the finished archive')
  const entries = listZip(zipPath).sort()
  for (const entry of entries) console.log(`    ${entry}`)

  const expectedEntries = expected.map((file) => `${FOLDER}/${file}`).sort()
  if (JSON.stringify(entries) !== JSON.stringify(expectedEntries)) {
    fail(`archive contents do not match the allow-list\n  got: ${entries}`)
  }
  // Check the archive paths too, not just the staging paths: this is the thing
  // that actually gets sent to someone.
  checkPaths(entries, 'archive')

  if (!entries.every((entry) => entry.startsWith(`${FOLDER}/`))) {
    fail(`every entry must live under ${FOLDER}/ so Load unpacked has one folder to select`)
  }

  rmSync(staging, { recursive: true, force: true })

  if (problems.length > 0) return report()

  console.log(`\nPackaged Kickback v${version}`)
  console.log(`  ${zipPath}`)
  console.log(`  extension id ${EXPECTED_EXTENSION_ID}`)
  console.log('\nNext: extract it somewhere fresh and load it with chrome://extensions.')
  return 0
}

function report() {
  console.error(`\nPackaging failed - ${problems.length} problem(s):\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\nNo archive was written.')
  return 1
}

function readmeForTesters(version) {
  return `KICKBACK - PRIVATE BETA v${version}
=====================================

See who's around on Twitch, what they're watching, and jump in with one click.

This is a private beta. Please don't share it around.


INSTALL
-------

1. Extract this ZIP somewhere you won't delete it later.
   (Documents or Desktop is fine. Not your Downloads folder.)
2. Open Chrome.
3. Go to:  chrome://extensions
4. Turn on "Developer mode" (top right).
5. Click "Load unpacked".
6. Select the extracted "Kickback" folder - the one holding this file.
7. Open Twitch.
8. Click "Continue with Twitch" in the Kickback panel.

That's it. Kickback appears on the right-hand side of Twitch.


USE
---

- Add friends by Twitch username, or by Kickback friend code.
- See what your friends are watching.
- Click JOIN to go watch with them.
- Friends on the stream you're already watching show up as HERE.
- Create groups. Group members don't all have to be friends.
- Group chat supports Kickback emotes and 7TV emotes.
- When people chant the same emote, it forms a combo.
- Drag the panel by its header. Resize it from the bottom corners.
- Minimise it with the button in the top right; the badge still counts.
- Panel in a silly place? Click your avatar, then "Reset layout".


UPDATES
-------

When I send a new ZIP:

1. Extract the new ZIP.
2. Copy its files into the SAME folder you installed from,
   replacing the old ones. Keep the folder in the same place.
3. Go to chrome://extensions and click the reload arrow on Kickback.
4. Refresh your Twitch tab.

Keeping the same folder path matters. Chrome treats a folder in a new
location as a different install, which means signing in again and
setting the panel up again. Same folder = you stay signed in.


TROUBLESHOOTING
---------------

Nothing appears on Twitch
  Refresh the Twitch tab. If it's still missing, go to chrome://extensions
  and check Kickback is enabled.

Sign-in doesn't finish
  Make sure you're not blocking pop-ups for Twitch, and try again.

Something looks broken
  Tell me - that's the point of the beta.


VERSION
-------

v${version} - shown in the bottom-left of the Kickback panel.
Please include it if you report something.


FEEDBACK
--------

Just use Twitch normally for a few days.

Tell me what feels useful, what's annoying, what's confusing, what's
broken, and anything that feels obviously missing.

Blunt is helpful.
`
}

process.exit(await main())
