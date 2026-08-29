/**
 * Package Watchside for Firefox.
 *
 *   node scripts/package-firefox.mjs          the AMO-shaped candidate
 *   node scripts/package-firefox.mjs --beta   the same, plus a README for a human
 *
 * SAME SOURCE, SAME SAFETY NET, DIFFERENT MANIFEST.
 *
 * This is a sibling of package-beta.mjs rather than a second pipeline: the
 * allow-list, the forbidden paths, the secret patterns and the demo markers all
 * come from ./package-shared.mjs, so a Firefox package cannot be laxer than a
 * Chrome one about what it lets through. What differs is the manifest, which
 * comes from ./manifest.mjs, and the archive's shape.
 *
 * WHY A SEPARATE FILE
 *
 * package-beta.mjs is the path that builds the artifact currently in Chrome Web
 * Store review, and it is bound to Chromium's identity model - it refuses to
 * package unless the manifest key hashes to the permanent extension ID. Firefox
 * has no key and a different identity model, so bolting a third mode onto that
 * control flow would have meant threading "unless Firefox" through the one
 * script that must not change behaviour right now.
 *
 * WHY dist-firefox/
 *
 * Firefox needs bundles built with WATCHSIDE_BROWSER=gecko, which read
 * `browser.*` rather than `chrome.*`. Building those into dist/ would replace
 * the Chromium output. They get their own directory so both can exist and
 * neither can be mistaken for the other.
 *
 * F2 SCOPE. This produces a real, installable, validator-clean development
 * artifact. It is NOT an AMO submission: no source package accompanies it, it
 * is unsigned, and Firefox sign-in does not work yet because no redirect URL is
 * registered. See docs/reports/firefox-f2-packaging-bootstrap-2026-08-28.md.
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
import { RUNTIME_FILES, createScanner, run, step, walk } from './package-shared.mjs'
import { GECKO_ID, GECKO_MIN_VERSION, manifestFor } from './manifest.mjs'

const DIST = 'dist-firefox'
const RELEASES = 'releases'
const BETA = process.argv.includes('--beta')

/**
 * A fixed timestamp for every archive entry.
 *
 * Without this the ZIP is not reproducible: writeZip defaults to the wall clock,
 * so two builds of identical source produce different bytes. That was measured,
 * not assumed - the packaged FILES were byte-identical across builds and only
 * the container differed.
 *
 * It matters beyond tidiness. AMO requires a source-code submission for
 * minified extensions, and the point of one is that a reviewer can rebuild and
 * compare. "Same source in, same bytes out" has to be literally true for that
 * to mean anything.
 *
 * The DOS epoch, built from LOCAL components so `dosTime` reads the same
 * numbers in every timezone. Deliberately not a plausible date: nothing should
 * read a package timestamp and believe it.
 */
const DETERMINISTIC_DATE = new Date(1980, 0, 1, 0, 0, 0)

const problems = []
const fail = (message) => problems.push(message)
const { scanContents, checkPaths } = createScanner(fail)

/**
 * Firefox packages are flat.
 *
 * Unlike Chrome's "Load unpacked", which wants a folder to select, every way of
 * installing a Firefox add-on - about:debugging, web-ext, AMO - expects
 * manifest.json at the root of the archive. So both Firefox artifacts are
 * root-shaped and the only difference between them is the README.
 */
async function main() {
  // ------------------------------------------------------------- build
  step('Building the Gecko bundles')
  rmSync(DIST, { recursive: true, force: true })
  run('npm', ['run', 'build'], {
    // Same reasoning as the Chrome beta: whoever packages is also developing,
    // and their .env.local says development. Setting it here means the archive
    // cannot inherit a local mistake.
    VITE_KICKBACK_ENV: 'private_beta',
    WATCHSIDE_BROWSER: 'gecko',
    WATCHSIDE_OUT_DIR: DIST,
  })

  step('Inspecting the build')
  const source = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'))
  const version = source.version
  console.log(`  version        : ${version}`)
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) fail(`manifest version "${version}" is not x.y.z`)

  for (const file of RUNTIME_FILES) {
    if (!existsSync(join(DIST, file))) fail(`build is missing ${file}`)
  }

  const background = readFileSync(join(DIST, 'kickback-background.js'), 'utf8')
  const content = readFileSync(join(DIST, 'kickback-content.js'), 'utf8')

  if (!background.includes('private_beta')) {
    fail('the background bundle was not built with VITE_KICKBACK_ENV=private_beta')
  }

  /*
   * The whole point of the package: it must speak Gecko.
   *
   * A Firefox archive built from the Chromium bundles would install and then
   * fail at the first awaited storage read, because Firefox's chrome.* alias is
   * callback-shaped. That failure is silent, so it is checked here rather than
   * discovered.
   */
  if (!/browser\.storage\.local\./.test(background)) {
    fail('the background bundle does not use browser.* - it was not built for Gecko')
  }
  if (/chrome\.(storage|identity|notifications|alarms|tabs|runtime)\./.test(background)) {
    fail('the background bundle still contains a chrome.* namespace')
  }
  if (/chrome\.(storage|identity|notifications|alarms|tabs|runtime)\./.test(content)) {
    fail('the content bundle still contains a chrome.* namespace')
  }
  console.log('  engine         : gecko (browser.*)')
  console.log('  analytics env  : private_beta')

  scanContents(DIST, RUNTIME_FILES.filter((f) => existsSync(join(DIST, f))), 'build')
  if (problems.length > 0) return report()

  // ------------------------------------------------------------ stage
  step('Staging the package')
  const staging = mkdtempSync(join(tmpdir(), 'watchside-firefox-'))
  mkdirSync(staging, { recursive: true })

  for (const file of RUNTIME_FILES) {
    const target = join(staging, file)
    mkdirSync(join(target, '..'), { recursive: true })
    cpSync(join(DIST, file), target)
  }

  /*
   * The manifest is DERIVED, never hand-maintained.
   *
   * public/manifest.json stays the single source of truth and stays a Chromium
   * manifest; manifestFor('gecko') changes exactly three keys. Two files that
   * had to agree about permissions, version and icons would eventually
   * disagree, and a user would find out before we did.
   */
  const manifest = manifestFor('gecko', source)
  writeFileSync(
    join(staging, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  )

  console.log(`  gecko id       : ${manifest.browser_specific_settings?.gecko?.id}`)
  console.log(`  min firefox    : ${manifest.browser_specific_settings?.gecko?.strict_min_version}`)

  if (manifest.browser_specific_settings?.gecko?.id !== GECKO_ID) {
    fail(`gecko id is not ${GECKO_ID} - the OAuth redirect URL derives from it`)
  }
  if (manifest.browser_specific_settings?.gecko?.strict_min_version !== GECKO_MIN_VERSION) {
    fail(`strict_min_version is not ${GECKO_MIN_VERSION}`)
  }
  if (manifest.key) fail('the Firefox package still carries the Chromium manifest key')
  if (manifest.background?.service_worker) {
    fail('the Firefox package still declares a service worker; Gecko needs an event page')
  }

  if (BETA) writeFileSync(join(staging, 'README-TESTERS.txt'), readmeForTesters(version), 'utf8')

  const staged = walk(staging).sort()
  console.log(`  ${staged.length} files`)
  for (const file of staged) console.log(`    ${file}`)

  const expected = (BETA ? [...RUNTIME_FILES, 'README-TESTERS.txt'] : [...RUNTIME_FILES]).sort()
  if (JSON.stringify(staged) !== JSON.stringify(expected)) {
    fail(`staged files do not match the allow-list\n  got:      ${staged}\n  expected: ${expected}`)
  }
  checkPaths(staged, 'staging')
  scanContents(staging, staged, 'staging')

  if (problems.length > 0) return report()

  // -------------------------------------------------------------- zip
  step('Writing the archive')
  mkdirSync(RELEASES, { recursive: true })
  const zipPath = join(
    RELEASES,
    BETA ? `Watchside-Firefox-Beta-v${version}.zip` : `Watchside-Firefox-v${version}.zip`,
  )
  rmSync(zipPath, { force: true })

  writeZip(
    zipPath,
    // Flat: manifest.json at the root, as every Firefox install path expects.
    staged.map((file) => ({ name: file, source: join(staging, file) })),
    { date: DETERMINISTIC_DATE },
  )
  console.log(`  ${zipPath}  (${(statSync(zipPath).size / 1024).toFixed(1)} KB)`)

  step('Inspecting the finished archive')
  const entries = listZip(zipPath).sort()
  for (const entry of entries) console.log(`    ${entry}`)
  if (JSON.stringify(entries) !== JSON.stringify(expected)) {
    fail(`archive contents do not match the allow-list\n  got: ${entries}`)
  }
  checkPaths(entries, 'archive')
  if (!entries.includes('manifest.json')) {
    fail('manifest.json must be at the ROOT of a Firefox package')
  }

  /*
   * The unpacked staging directory is kept, not deleted.
   *
   * web-ext lint and about:debugging both want a directory, and re-deriving it
   * from the zip would be a second code path that could differ from the one
   * that produced the archive. This IS the archive, unzipped.
   */
  const unpacked = join(DIST, BETA ? 'package-beta' : 'package')
  rmSync(unpacked, { recursive: true, force: true })
  mkdirSync(unpacked, { recursive: true })
  for (const file of staged) {
    const target = join(unpacked, file)
    mkdirSync(join(target, '..'), { recursive: true })
    cpSync(join(staging, file), target)
  }
  rmSync(staging, { recursive: true, force: true })

  if (problems.length > 0) return report()

  console.log(`\nPackaged Watchside for Firefox v${version}`)
  console.log(`  ${zipPath}`)
  console.log(`  sha256 ${createHash('sha256').update(readFileSync(zipPath)).digest('hex')}`)
  console.log(`  unpacked ${unpacked}`)
  console.log(`  gecko id ${GECKO_ID}`)
  console.log('\nThis is a DEVELOPMENT artifact. It is unsigned, has no AMO source')
  console.log('package, and Firefox sign-in does not work until the redirect URL is')
  console.log('registered with Supabase. Next: npm run verify:firefox')
  return 0
}

function report() {
  console.error(`\nPackaging failed - ${problems.length} problem(s):\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\nNo archive was written.')
  return 1
}

function readmeForTesters(version) {
  return [
    `Watchside v${version} - Firefox development build`,
    '',
    'This is an UNSIGNED development build. It installs temporarily and is',
    'removed when Firefox closes. It is not from addons.mozilla.org and is not',
    'yet a finished Firefox product.',
    '',
    'To install:',
    '',
    '1. Unzip this file somewhere you can find again.',
    '2. Open Firefox and go to  about:debugging#/runtime/this-firefox',
    '3. Click "Load Temporary Add-on...".',
    '4. Select the manifest.json from the folder you unzipped.',
    '5. Open any twitch.tv page. The Watchside panel appears on the right.',
    '',
    'KNOWN LIMITATION: signing in does not work yet. The Firefox sign-in',
    'redirect has not been registered with the backend, so "Continue with',
    'Twitch" will fail. That is the next milestone, not a bug to report.',
    '',
    'Everything that does not need an account - the panel, its layout, the',
    'toolbar icon - is worth looking at.',
    '',
  ].join('\n')
}

process.exit(await main())
