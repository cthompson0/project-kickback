/**
 * Is the Firefox package the package we meant to build?
 *
 *   npm run verify:firefox
 *
 * The sibling of verify-store.mjs, and it asks the same kind of question: not
 * "does this work" - tests answer that - but "does the artifact on disk agree
 * with everything the repository believes about it".
 *
 * It reads the UNPACKED package under dist-firefox/, which is the same bytes
 * the archive holds, because that is what web-ext lints and what
 * about:debugging loads. Checking the source tree instead would prove the
 * transform is right and say nothing about what was actually produced.
 *
 * Says nothing about Mozilla's own rules - that is `web-ext lint`, run
 * separately so a validator warning and a Watchside invariant never get
 * confused for each other.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, sep } from 'node:path'
import { RUNTIME_FILES, FORBIDDEN_PATHS, walk } from './package-shared.mjs'
import {
  GECKO_DATA_COLLECTION,
  GECKO_ID,
  GECKO_MIN_VERSION,
  SUPABASE_WILDCARD,
  backendOriginsIn,
  manifestFor,
} from './manifest.mjs'
import { EXPECTED_EXTENSION_ID } from './extension-identity.mjs'

/**
 * Which package to verify.
 *
 *   npm run verify:firefox                     the development package
 *   npm run verify:firefox -- --amo            the AMO upload candidate
 *   npm run verify:firefox -- --package=<dir>  any unpacked package
 *
 * WHY THIS IS A FLAG AND NOT A CONSTANT
 *
 * `npm run package:amo` unpacks to dist-firefox/package-amo, and this script
 * only ever read dist-firefox/package. So running the verifier after building
 * an AMO candidate reported PASS - about a completely different archive, built
 * earlier, from possibly different source. The one artifact nobody could
 * verify was the only one that gets uploaded.
 *
 * The default is unchanged, so every existing invocation means what it did.
 */
function packageDir() {
  const explicit = process.argv.find((a) => a.startsWith('--package='))
  if (explicit) return explicit.slice('--package='.length)
  if (process.argv.includes('--amo')) return join('dist-firefox', 'package-amo')
  if (process.argv.includes('--beta')) return join('dist-firefox', 'package-beta')
  return join('dist-firefox', 'package')
}

const PACKAGE = packageDir()
const CHROMIUM_MANIFEST = join('public', 'manifest.json')

if (!existsSync(PACKAGE)) {
  console.error(`No unpacked package at ${PACKAGE} - build it first.`)
  process.exit(1)
}
console.log(`Verifying ${PACKAGE}`)

const problems = []
const notes = []
const fail = (message) => problems.push(message)
const note = (message) => notes.push(message)

function step(label) {
  console.log(`\n== ${label}`)
}

function ok(label, detail = '') {
  console.log(`  ${label.padEnd(46)} ${detail}`)
}

function main() {
  if (!existsSync(PACKAGE)) {
    console.error(`No Firefox package at ${PACKAGE}.\nRun: npm run package:firefox`)
    return 1
  }

  const source = JSON.parse(readFileSync(CHROMIUM_MANIFEST, 'utf8'))
  const manifest = JSON.parse(readFileSync(join(PACKAGE, 'manifest.json'), 'utf8'))
  const files = walk(PACKAGE).sort()

  // ------------------------------------------------------- the manifest
  step('Manifest')

  if (manifest.manifest_version !== 3) fail(`manifest_version is ${manifest.manifest_version}, not 3`)
  else ok('manifest version', '3')

  if (manifest.name !== source.name) fail(`name "${manifest.name}" differs from Chromium`)
  else ok('name', manifest.name)

  if (manifest.version !== source.version) fail(`version "${manifest.version}" differs from Chromium`)
  else ok('version', manifest.version)

  const gecko = manifest.browser_specific_settings?.gecko
  if (gecko?.id !== GECKO_ID) fail(`gecko id is "${gecko?.id}", expected "${GECKO_ID}"`)
  else ok('gecko id', gecko.id)

  if (gecko?.strict_min_version !== GECKO_MIN_VERSION) {
    fail(`strict_min_version is "${gecko?.strict_min_version}", expected "${GECKO_MIN_VERSION}"`)
  } else ok('strict_min_version', gecko.strict_min_version)

  /*
   * The Chromium identity must not be in here.
   *
   * `key` is what pins the Chrome Web Store item. A Firefox package carrying it
   * would be claiming an identity that means nothing to Gecko and everything to
   * Chrome.
   */
  if (manifest.key) fail('the Firefox manifest still carries the Chromium key')
  else ok('chromium key', 'absent')

  if (manifest.background?.service_worker) {
    fail('the Firefox manifest declares a service worker; Gecko needs an event page')
  } else ok('service_worker', 'absent')

  const scripts = manifest.background?.scripts
  if (!Array.isArray(scripts) || scripts[0] !== 'kickback-background.js' || scripts.length !== 1) {
    fail(`background.scripts is ${JSON.stringify(scripts)}, expected ["kickback-background.js"]`)
  } else ok('background', 'event page -> kickback-background.js')

  // The transform is the only thing allowed to have produced this - and with
  // the origin the BUNDLE names, so a manifest granting a project the code does
  // not talk to fails here rather than at a user's sign-in.
  const built = readFileSync(join(PACKAGE, 'kickback-background.js'), 'utf8')
  const origins = backendOriginsIn(built)
  if (origins.length !== 1) fail(`expected one backend origin in the bundle, found ${origins.length}`)
  const derived = manifestFor('gecko', source, { supabaseOrigin: origins[0] })
  if (JSON.stringify(manifest) !== JSON.stringify(derived)) {
    fail('the packaged manifest is not what manifestFor("gecko") produces from public/manifest.json')
  } else ok('derived from the canonical manifest', 'exactly')

  // ---------------------------------------------------- what it asks for
  step('Capabilities')

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

  if (!same(manifest.permissions, source.permissions)) {
    fail(`permissions differ from Chromium: ${JSON.stringify(manifest.permissions)}`)
  } else ok('permissions', JSON.stringify(manifest.permissions))

  /*
   * Host permissions are NARROWER than Chromium's, on purpose and in one place.
   *
   * Chromium asks for every Supabase project on the internet; Firefox asks for
   * ours. So this cannot be an equality check any more - it asserts the shape
   * of the divergence instead: the wildcard is gone, exactly one Supabase
   * origin remains, it is the one the bundle talks to, and nothing else moved.
   */
  const narrowed = `${origins[0]}/*`
  const expectedHosts = source.host_permissions.map((p) => (p === SUPABASE_WILDCARD ? narrowed : p))
  if (!same(manifest.host_permissions, expectedHosts)) {
    fail(`host permissions are not Chromium's with the backend narrowed: ${JSON.stringify(manifest.host_permissions)}`)
  } else ok('host permissions', JSON.stringify(manifest.host_permissions))

  if (manifest.host_permissions.some((p) => p.includes('*.supabase.co'))) {
    fail('the Supabase wildcard survived into the Firefox manifest')
  } else ok('backend grant', `narrowed to ${narrowed}`)

  const declared = manifest.browser_specific_settings?.gecko?.data_collection_permissions
  if (JSON.stringify(declared) !== JSON.stringify(GECKO_DATA_COLLECTION)) {
    fail('data_collection_permissions is not the declared mapping')
  } else ok('data collection', declared.required.join(', '))

  if (manifest.browser_specific_settings?.gecko_android) {
    fail('gecko_android is present - Watchside is desktop-only and untested on Android')
  } else ok('android', 'not claimed (desktop-only)')

  if (!same(manifest.content_scripts, source.content_scripts)) {
    fail('content_scripts differ from Chromium')
  } else ok('content scripts', 'twitch.tv only')

  if (manifest.optional_permissions || manifest.optional_host_permissions) {
    fail('the Firefox package asks for optional permissions Chromium does not')
  }

  // --------------------------------------------------------- the files
  step('Contents')

  const expected = [...RUNTIME_FILES].sort()
  const extra = files.filter((f) => !expected.includes(f) && f !== 'README-TESTERS.txt')
  const missing = expected.filter((f) => !files.includes(f))
  if (missing.length) fail(`package is missing: ${missing.join(', ')}`)
  if (extra.length) fail(`package contains unexpected files: ${extra.join(', ')}`)
  if (!missing.length && !extra.length) ok('files', `${files.length}, all on the allow-list`)

  for (const path of files) {
    const lower = path.toLowerCase()
    for (const forbidden of FORBIDDEN_PATHS) {
      // .zip is on the shared list because an archive must not nest one; a
      // package directory legitimately holds none either, so the rule stands.
      if (lower.includes(forbidden)) fail(`forbidden path "${path}" (matched ${forbidden})`)
    }
  }

  for (const size of [16, 32, 48, 128]) {
    const icon = join(PACKAGE, `icons/icon-${size}.png`)
    if (!existsSync(icon) || statSync(icon).size === 0) fail(`icon-${size}.png missing or empty`)
  }
  ok('icons', '16 / 32 / 48 / 128')

  // ------------------------------------------------------- the bundles
  step('Engine')

  const background = readFileSync(join(PACKAGE, 'kickback-background.js'), 'utf8')
  const content = readFileSync(join(PACKAGE, 'kickback-content.js'), 'utf8')

  /*
   * The check this whole gate exists for.
   *
   * A Firefox package built from the Chromium bundles installs cleanly and then
   * fails at the first awaited storage read, because Gecko's chrome.* alias is
   * callback-shaped and returns undefined rather than throwing. Nothing about
   * the manifest would reveal it.
   */
  const geckoNamespaces = ['storage', 'identity', 'notifications', 'alarms', 'tabs', 'runtime']
  const usedByBackground = geckoNamespaces.filter((ns) => background.includes(`browser.${ns}.`))
  if (usedByBackground.length !== geckoNamespaces.length) {
    fail(
      `the background bundle does not reach every browser.* namespace; missing ${geckoNamespaces
        .filter((ns) => !usedByBackground.includes(ns))
        .join(', ')}`,
    )
  } else ok('background uses browser.*', geckoNamespaces.join(', '))

  if (!content.includes('browser.runtime.connect')) {
    fail('the content bundle does not open a port through browser.runtime')
  } else ok('content uses browser.*', 'runtime.connect')

  for (const [label, text] of [['background', background], ['content', content]]) {
    const leaked = geckoNamespaces.filter((ns) => text.includes(`chrome.${ns}.`))
    if (leaked.length) fail(`the ${label} bundle still contains chrome.${leaked.join(', chrome.')}`)
  }
  ok('no chrome.* namespace', 'in either bundle')

  /*
   * The content script opens a port and nothing else. Background-only APIs
   * reaching the Twitch page would be inert but would still be code that has no
   * business there - and a reviewer would be right to ask why.
   */
  const leakedToPage = ['storage', 'identity', 'notifications', 'alarms', 'tabs'].filter((ns) =>
    content.includes(`browser.${ns}.`),
  )
  if (leakedToPage.length) {
    fail(`background-only APIs reached the content script: browser.${leakedToPage.join(', browser.')}`)
  } else ok('content script scope', 'runtime only')

  if (!background.includes('private_beta')) {
    fail('the background bundle was not built with VITE_KICKBACK_ENV=private_beta')
  } else ok('analytics env', 'private_beta')

  // ------------------------------------------------------ leak checks
  step('Leaks')

  if (files.some((f) => f.endsWith('.map'))) fail('the package contains a source map')
  else ok('source maps', 'none')

  for (const file of files.filter((f) => /\.(js|json|html|txt)$/i.test(f))) {
    const text = readFileSync(join(PACKAGE, file), 'utf8')
    if (/sb_secret_[A-Za-z0-9_-]{10,}/.test(text)) fail(`${file} contains a Supabase secret key`)
    if (/service_role/.test(text)) fail(`${file} names the service-role role`)
    if (/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./.test(text)) {
      fail(`${file} contains a JWT-shaped literal`)
    }
  }
  ok('secrets', 'none found')

  // --------------------------------------------- Chromium is untouched
  step('Chromium')

  /*
   * Packaging for a second browser must not have moved the first one.
   *
   * public/manifest.json is what Vite copies into dist/ and therefore what the
   * Chrome Web Store package is built from, so the Chromium identity is checked
   * against the canonical source rather than against a build that may not exist
   * on this machine.
   */
  if (typeof source.key !== 'string' || source.key.length < 300) {
    fail('the canonical manifest lost its Chromium key')
  } else ok('chromium key intact', `${EXPECTED_EXTENSION_ID}`)

  if (source.background?.service_worker !== 'kickback-background.js') {
    fail('the canonical manifest no longer declares the Chromium service worker')
  } else ok('chromium background', 'service worker')

  if (source.browser_specific_settings) {
    fail('the canonical Chromium manifest has acquired Gecko settings')
  } else ok('chromium manifest', 'no gecko settings')

  // --------------------------------------------------------- summary
  step('Determinism')

  const digest = createHash('sha256')
  for (const file of files) {
    digest.update(file)
    digest.update(readFileSync(join(PACKAGE, file)))
  }
  ok('content digest', digest.digest('hex').slice(0, 32) + '...')
  /*
   * The archive is reproducible because every entry carries a FIXED timestamp,
   * not because a ZIP has none. writeZip defaults to the wall clock, and with
   * that default two builds of identical source produced different bytes - the
   * packaged files were byte-identical and only the container differed. The
   * Firefox packager pins the date; see DETERMINISTIC_DATE there.
   */
  note('reproducible: two builds of the same source produce byte-identical archives')

  /*
   * This named the development package unconditionally, which is how a
   * verified AMO candidate came to be described as "a DEVELOPMENT package".
   */
  if (PACKAGE.endsWith('package-amo')) {
    note('this is the AMO UPLOAD CANDIDATE: unsigned until Mozilla signs it')
    note('it must be uploaded with its source archive - npm run package:source')
  } else {
    note('this is a DEVELOPMENT package: unsigned, no AMO source package')
  }
  note('Firefox sign-in does not work until the redirect URL is registered (F3)')
  note(`run npx web-ext lint --source-dir ${PACKAGE.split(sep).join("/")} for Mozilla's own rules`)

  console.log('')
  for (const message of notes) console.log(`  note: ${message}`)

  if (problems.length) {
    console.error(`\nFirefox package verification FAILED - ${problems.length} problem(s):\n`)
    for (const problem of problems) console.error(`  - ${problem}`)
    return 1
  }

  console.log('\nFirefox package: the repository agrees with itself.')
  console.log('This says nothing about Mozilla policy - see web-ext lint.')
  return 0
}

process.exit(main())
