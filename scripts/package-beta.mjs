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
 *   - the manifest still pins the Chrome Web Store item's extension ID, which
 *     is what the OAuth redirect allow-list is keyed on
 *   - the staged files are exactly the runtime files, nothing else
 *   - neither the staged files nor the finished archive contain a secret
 *
 * Two shapes, one set of guarantees: --store produces the flat, key-free
 * archive the Chrome Web Store requires; without it, the nested one a tester
 * selects in Load unpacked.
 *
 * Every check fails loudly. A beta that half-works is worse than no beta,
 * because the tester's report is then about our packaging rather than the
 * product.
 *
 * Nothing is copied wholesale: the file list is an allow-list, so a stray file
 * appearing in dist/ cannot silently end up in a tester's hands.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listZip, writeZip } from './zip.mjs'
import { verifyGroupSchema } from './verify-group-schema.mjs'
import { EXPECTED_EXTENSION_ID, extensionIdFromKey } from './extension-identity.mjs'
import { RUNTIME_FILES, createScanner, run, step, walk } from './package-shared.mjs'
import { backendOriginsIn, grantsOrigin } from './manifest.mjs'
import { verifyAnalyticsSchema } from './verify-analytics.mjs'

const DIST = 'dist'
const RELEASES = 'releases'
/** The folder name a tester selects in Load unpacked. */
const FOLDER = 'Watchside'

/**
 * Two archives, because the two destinations disagree about shape.
 *
 *   sideload  every entry under Watchside/, so Load unpacked has one folder to
 *             select and a tester cannot pick the wrong thing.
 *   store     manifest.json at the ROOT. The Chrome Web Store rejects a package
 *             whose manifest is nested, with an error about the manifest being
 *             missing - which reads as a corrupt file rather than a wrong shape.
 *
 * The store package also drops the manifest `key`, and the reason has changed
 * now that the item exists.
 *
 * It used to be dropped because our key was a local invention that the
 * dashboard would have validated against the item's real one and rejected. That
 * is no longer true: the manifest now carries the STORE's public key, adopted
 * from the item's Package tab, so a local build and the published extension are
 * the same extension to Chrome.
 *
 * It is still dropped, for a smaller reason: the store already owns the item's
 * identity, so the field is redundant there, and whether the dashboard accepts a
 * matching key on an update is not something the documentation actually
 * promises. A package that does not carry the field cannot be rejected for
 * carrying it - and we lose nothing, because the integrity check that field
 * might have provided already happens here, before either archive is written:
 * this script recomputes the ID from the manifest key and refuses to package at
 * all unless it equals EXPECTED_EXTENSION_ID.
 *
 * So drift is caught locally and loudly, rather than at an upload prompt.
 */
const STORE = process.argv.includes('--store')

/**
 * Problems are collected rather than thrown, so one run reports everything
 * wrong with a package instead of the first thing.
 */
const problems = []
const fail = (message) => problems.push(message)

/*
 * The allow-list, the forbidden paths, the secret patterns and the demo
 * markers now live in ./package-shared.mjs, because Watchside packages for two
 * engines and a second copy of that safety net would eventually disagree with
 * this one - and the copy that fell behind would be the one that let something
 * through. The scanners take the `fail` below, so the two packagers share the
 * rules without sharing state.
 */
const { scanContents, checkPaths } = createScanner(fail)

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
    console.log(`  extension id   : ${id}${STORE ? ' (key removed from the store package)' : ''}`)
    if (id !== EXPECTED_EXTENSION_ID) {
      fail(`extension id ${id} does not match the OAuth allow-list (${EXPECTED_EXTENSION_ID})`)
    }
  }

  /*
   * The manifest must grant the backend the build actually talks to.
   *
   * The Firefox packager has always derived this grant from the bundle. Chrome
   * declares it statically as `https://*.supabase.co/*`, so for as long as the
   * backend was a Supabase subdomain nothing had to check - the wildcard
   * covered it by shape. A branded backend is not covered by that wildcard,
   * and the failure would be silent here and loud at a user.
   */
  const built = readFileSync(join(DIST, 'kickback-background.js'), 'utf8')
  const backends = backendOriginsIn(built)
  if (backends.length !== 1) {
    fail(`expected exactly one backend origin in the build, found ${backends.length}`)
  } else if (!grantsOrigin(manifest.host_permissions ?? [], backends[0])) {
    fail(
      `host_permissions does not grant the backend the build talks to (${backends[0]}): ` +
        JSON.stringify(manifest.host_permissions),
    )
  } else {
    console.log(`  backend        : ${backends[0]}`)
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
  const root = STORE ? staging : join(staging, FOLDER)
  mkdirSync(root, { recursive: true })

  for (const file of RUNTIME_FILES) {
    const target = join(root, file)
    mkdirSync(join(target, '..'), { recursive: true })
    cpSync(join(DIST, file), target)
  }

  if (STORE) {
    // Same manifest, minus the one field the store owns.
    const { key, ...withoutKey } = manifest
    if (!key) fail('expected a key to remove from the store manifest')
    writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(withoutKey, null, 2)}\n`, 'utf8')
  } else {
    // Install, use, update and troubleshooting, for somebody who has never
    // opened chrome://extensions. Pointless inside a store package.
    writeFileSync(join(root, 'README-TESTERS.txt'), readmeForTesters(version), 'utf8')
  }

  const staged = walk(root).sort()
  console.log(`  ${staged.length} files`)
  for (const file of staged) console.log(`    ${file}`)

  const expected = (STORE ? [...RUNTIME_FILES] : [...RUNTIME_FILES, 'README-TESTERS.txt']).sort()
  if (JSON.stringify(staged) !== JSON.stringify(expected)) {
    fail(`staged files do not match the allow-list\n  got:      ${staged}\n  expected: ${expected}`)
  }
  checkPaths(staged, 'staging')
  scanContents(root, staged, 'staging')

  if (problems.length > 0) return report()

  // -------------------------------------------------------------- zip
  step('Writing the archive')
  mkdirSync(RELEASES, { recursive: true })
  const zipPath = join(
    RELEASES,
    STORE ? `Watchside-Store-v${version}.zip` : `Watchside-Private-Beta-v${version}.zip`,
  )
  rmSync(zipPath, { force: true })

  writeZip(
    zipPath,
    staged.map((file) => ({
      name: STORE ? file : `${FOLDER}/${file}`,
      source: join(root, file),
    })),
  )
  console.log(`  ${zipPath}  (${(statSync(zipPath).size / 1024).toFixed(1)} KB)`)

  // --------------------------------------------------------- inspect
  step('Inspecting the finished archive')
  const entries = listZip(zipPath).sort()
  for (const entry of entries) console.log(`    ${entry}`)

  const expectedEntries = expected.map((file) => (STORE ? file : `${FOLDER}/${file}`)).sort()
  if (JSON.stringify(entries) !== JSON.stringify(expectedEntries)) {
    fail(`archive contents do not match the allow-list\n  got: ${entries}`)
  }
  // Check the archive paths too, not just the staging paths: this is the thing
  // that actually gets sent to someone.
  checkPaths(entries, 'archive')

  if (STORE) {
    // The one thing that makes it a store package rather than a sideload one.
    if (!entries.includes('manifest.json')) {
      fail('manifest.json must be at the ROOT of a store package, not inside a folder')
    }
    const staleKey = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).key
    if (staleKey) fail('the store package still carries a manifest key')
  } else if (!entries.every((entry) => entry.startsWith(`${FOLDER}/`))) {
    fail(`every entry must live under ${FOLDER}/ so Load unpacked has one folder to select`)
  }

  rmSync(staging, { recursive: true, force: true })

  if (problems.length > 0) return report()

  console.log(`\nPackaged Watchside v${version}`)
  console.log(`  ${zipPath}`)
  // Printed so a report can quote the exact artifact, rather than "the zip".
  console.log(`  sha256 ${createHash('sha256').update(readFileSync(zipPath)).digest('hex')}`)

  if (STORE) {
    console.log(`  key omitted - the store item already owns ${EXPECTED_EXTENSION_ID}`)
    console.log('\nNext: upload it as a new package on the existing Chrome Web Store item.')
    console.log('The item ID does not change, so no redirect or allow-list work follows.')
  } else {
    console.log(`  extension id ${EXPECTED_EXTENSION_ID}`)
    console.log('\nNext: extract it somewhere fresh and load it with chrome://extensions.')
  }
  return 0
}

function report() {
  console.error(`\nPackaging failed - ${problems.length} problem(s):\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\nNo archive was written.')
  return 1
}

function readmeForTesters(version) {
  return `WATCHSIDE - PRIVATE BETA v${version}
======================================

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
6. Select the extracted "Watchside" folder - the one holding this file.
7. Open Twitch.
8. Click "Continue with Twitch" in the Watchside panel.

That's it. Watchside appears on the right-hand side of Twitch.


USE
---

- Add friends by Twitch username, or by Watchside friend code.
- See what your friends are watching.
- Click JOIN to go watch with them.
- Friends on the stream you're already watching show up as HERE.
- Create groups. Group members don't all have to be friends.
- Group chat supports Watchside emotes and 7TV emotes.
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
3. Go to chrome://extensions and click the reload arrow on Watchside.
4. Refresh your Twitch tab.

Keeping the same folder path matters. Chrome treats a folder in a new
location as a different install, which means signing in again and
setting the panel up again. Same folder = you stay signed in.


TROUBLESHOOTING
---------------

Nothing appears on Twitch
  Refresh the Twitch tab. If it's still missing, go to chrome://extensions
  and check Watchside is enabled.

Sign-in doesn't finish
  Make sure you're not blocking pop-ups for Twitch, and try again.

Something looks broken
  Tell me - that's the point of the beta.


VERSION
-------

v${version} - shown in the bottom-left of the Watchside panel.
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
