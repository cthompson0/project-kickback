/**
 * Is Watchside ready to be a Chrome Web Store item?
 *
 *   npm run verify:store
 *
 * Deliberately NOT a second packager. `package:beta` answers "is this artifact
 * safe to hand somebody" and already does that job well. This answers a
 * different question: "does the repository still agree with itself about the
 * things a store listing depends on" - the identity, the permissions, the
 * version, and the documents that describe them.
 *
 * Every check here exists because the thing it checks is about to change, or
 * because a disagreement would be discovered by a reviewer or a tester rather
 * than by us.
 *
 * It is offline. It reads files and computes hashes; it never touches the
 * network, so it is safe to run anywhere and cannot be the reason a build is
 * slow.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { EXPECTED_EXTENSION_ID, extensionIdFromKey, redirectUrlFor } from './extension-identity.mjs'

const problems = []
const notes = []
const fail = (message) => problems.push(message)
const note = (message) => notes.push(message)

const manifest = JSON.parse(readFileSync('public/manifest.json', 'utf8'))
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

function step(label) {
  console.log(`\n== ${label}`)
}

// ------------------------------------------------------------------ identity

step('Extension identity')

{
  const derived = extensionIdFromKey(manifest.key ?? '')
  console.log(`  manifest key -> ${derived}`)
  console.log(`  expected     -> ${EXPECTED_EXTENSION_ID}`)
  console.log(`  redirect     -> ${redirectUrlFor(derived)}`)

  if (typeof manifest.key !== 'string' || manifest.key.length < 300) {
    fail('public/manifest.json has no pinned key - Chrome would invent an ID per install')
  } else if (derived !== EXPECTED_EXTENSION_ID) {
    fail(
      `the manifest key produces ${derived}, but scripts/extension-identity.mjs says ` +
        `${EXPECTED_EXTENSION_ID}. Change both together, then update the Supabase ` +
        `redirect allow-list to ${redirectUrlFor(derived)}`,
    )
  }
}

/*
 * Stale copies of the ID.
 *
 * The ID appears in prose as well as in code - a README, a privacy policy, a
 * checkpoint - and prose does not fail a test. When the Web Store assigns its
 * own ID this is what catches the paragraph nobody remembered to edit.
 *
 * Checkpoint reports are exempt: they are a record of what was true when they
 * were written, and rewriting history to match today would make them worthless.
 */
step('Stale extension IDs')

{
  const ID_SHAPE = /\b[a-p]{32}\b/g
  const EXEMPT = ['docs/checkpoints/', 'node_modules', '.git', 'releases', 'dist']

  const walk = (dir, out = []) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      const rel = relative(process.cwd(), path).split('\\').join('/')
      if (EXEMPT.some((skip) => rel.includes(skip))) continue
      if (statSync(path).isDirectory()) walk(path, out)
      else if (/\.(md|ts|tsx|mjs|json|txt)$/.test(entry)) out.push(rel)
    }
    return out
  }

  const stale = []
  for (const file of walk('.')) {
    const text = readFileSync(file, 'utf8')
    for (const found of text.match(ID_SHAPE) ?? []) {
      if (found === EXPECTED_EXTENSION_ID) continue
      stale.push(`${file}: ${found}`)
    }
  }

  if (stale.length > 0) {
    for (const entry of stale) fail(`an extension ID that is not ours: ${entry}`)
  } else {
    console.log('  no ID anywhere disagrees with extension-identity.mjs')
  }
}

// --------------------------------------------------------------- permissions

/*
 * Every permission, and the sentence that justifies it.
 *
 * The store asks for a justification per permission, and the honest way to have
 * one ready is to keep it beside the permission rather than writing it from
 * memory at submission time. A permission with no entry here is one nobody has
 * had to explain out loud, which is exactly when an unnecessary one survives.
 */
const PERMISSION_JUSTIFICATIONS = {
  identity:
    'Sign in with Twitch. chrome.identity.launchWebAuthFlow runs the OAuth flow and ' +
    'getRedirectURL provides the redirect; Watchside holds no client secret and never ' +
    'sees a Twitch password.',
  storage:
    'chrome.storage.local holds the session, the panel position, muted people and the ' +
    'analytics session id. An MV3 service worker is evicted after ~30s idle, so anything ' +
    'held only in memory would be lost between actions.',
  alarms:
    'One periodic alarm refreshes the Supabase session and re-reads the friends list if ' +
    'the realtime socket died quietly. A service worker cannot hold a timer across ' +
    'eviction, so this is the only way to schedule it.',
  notifications:
    'An optional desktop notification when several friends gather on one channel. It is ' +
    'a user preference in the account panel and can be turned off.',
}

const HOST_JUSTIFICATIONS = {
  'https://*.supabase.co/*':
    "Watchside's own backend: authentication, the friend graph, presence, and realtime. " +
    'All application data lives here and nowhere else.',
  'https://7tv.io/*':
    'Public emote metadata for the channel being watched, so chat can render the emotes ' +
    'viewers already see on Twitch. Read-only, unauthenticated, no user data sent.',
  'https://cdn.7tv.app/*':
    'Where those emote images are served from.',
}

step('Permissions')

{
  for (const permission of manifest.permissions ?? []) {
    if (PERMISSION_JUSTIFICATIONS[permission]) console.log(`  justified  ${permission}`)
    else fail(`permission "${permission}" has no justification in verify-store-readiness.mjs`)
  }
  for (const declared of Object.keys(PERMISSION_JUSTIFICATIONS)) {
    if (!(manifest.permissions ?? []).includes(declared)) {
      fail(`justification for "${declared}" but the manifest no longer requests it`)
    }
  }

  for (const host of manifest.host_permissions ?? []) {
    if (HOST_JUSTIFICATIONS[host]) console.log(`  justified  ${host}`)
    else fail(`host permission "${host}" has no justification in verify-store-readiness.mjs`)
  }
  for (const declared of Object.keys(HOST_JUSTIFICATIONS)) {
    if (!(manifest.host_permissions ?? []).includes(declared)) {
      fail(`justification for "${declared}" but the manifest no longer requests it`)
    }
  }

  // Broad access is the single most common review problem, and we do not need it.
  for (const host of manifest.host_permissions ?? []) {
    if (host.includes('<all_urls>') || /^\*:\/\/\*\//.test(host)) {
      fail(`host permission "${host}" is all-sites access`)
    }
  }
  if ((manifest.permissions ?? []).includes('tabs')) {
    fail('"tabs" grants URL access we do not need - chrome.tabs.create needs no permission')
  }
}

// ------------------------------------------------------------------ versions

step('Version')

{
  console.log(`  manifest ${manifest.version} / package.json ${pkg.version}`)
  if (manifest.version !== pkg.version) {
    fail(`manifest ${manifest.version} and package.json ${pkg.version} disagree`)
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? '')) {
    fail(`version "${manifest.version}" is not x.y.z`)
  }
  /*
   * The store refuses an upload whose version is not higher than the published
   * one. That is its rule to enforce, not ours - but a reminder here is cheaper
   * than finding out after a build.
   */
  note(`upload version ${manifest.version}; the store requires each upload to increase it`)
}

// --------------------------------------------------------------- store name

step('Listing identity')

{
  /*
   * The submitted item is called "Watchside BETA" while the manifest says
   * "Watchside". That is allowed and deliberate - the store name and the
   * manifest name are separate fields - but the manifest name is what a user
   * sees in chrome://extensions, so the two should not tell different stories.
   */
  console.log(`  manifest name: ${manifest.name}`)
  note('store listing name is "Watchside BETA"; the manifest says "Watchside" (both intentional)')

  if (manifest.name.length > 75) fail('manifest name is over the 75-character store limit')
  if ((manifest.description ?? '').length > 132) {
    fail(`description is ${manifest.description.length} chars; the store allows 132`)
  }
  console.log(`  description:   ${manifest.description.length}/132 chars`)
}

// ---------------------------------------------------------------- documents

step('Documents the listing depends on')

{
  const PRIVACY = 'docs/PRIVACY.md'
  if (!existsSync(PRIVACY)) {
    fail(`${PRIVACY} is missing - the store requires a privacy policy URL`)
  } else {
    const policy = readFileSync(PRIVACY, 'utf8')
    /*
     * The policy has to name every permission we ask for. A permission the
     * policy does not mention is one a reviewer will ask about, and one a user
     * cannot find an answer to.
     */
    for (const permission of manifest.permissions ?? []) {
      if (!policy.includes(permission)) fail(`${PRIVACY} does not mention the "${permission}" permission`)
    }
    for (const host of ['supabase', '7tv']) {
      if (!policy.toLowerCase().includes(host)) fail(`${PRIVACY} does not mention ${host}`)
    }
    console.log('  privacy policy names every permission and every host')
  }
}

// -------------------------------------------------------------------- assets

step('Assets')

{
  // Icons ship in the package; the rest are listing assets the owner uploads.
  for (const [size, path] of Object.entries(manifest.icons ?? {})) {
    const file = join('public', path)
    if (existsSync(file)) console.log(`  present    ${size}px  ${path}`)
    else fail(`icon missing: ${file}`)
  }
  if (!manifest.icons?.['128']) fail('no 128px icon - the store uses it as the item icon')

  /*
   * Screenshots are NOT checked for existence on purpose.
   *
   * They are pictures of the running product, they belong in the dashboard
   * rather than in git, and a check that could be satisfied by committing a
   * placeholder would be worse than no check. The owner checklist covers them.
   */
  note('screenshots (1280x800) and the 440x280 promo tile are owner actions - see the checkpoint')
}

// -------------------------------------------------------------------- report

console.log('')
for (const message of notes) console.log(`  note: ${message}`)

if (problems.length > 0) {
  console.error(`\nStore readiness: ${problems.length} problem(s)\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log('\nStore readiness: the repository agrees with itself.')
console.log('This says nothing about the hosted backend - see verify:config and verify:analytics.')
