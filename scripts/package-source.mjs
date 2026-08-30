/**
 * The source archive that accompanies an AMO upload.
 *
 *   node scripts/package-source.mjs
 *
 * WHY THIS EXISTS
 *
 * Mozilla requires a source submission whenever the uploaded add-on was
 * produced by a bundler or minifier, and ours is both. The reviewer's job is to
 * run our build and diff the result against what we uploaded, so the standard
 * they hold it to is exact: "There must be no differences."
 *
 * That makes this a REPRODUCIBILITY artifact, not a code dump. It carries the
 * lockfile, the two public build values, and instructions written for somebody
 * who has never seen this repository - and it deliberately carries nothing
 * else.
 *
 * WHAT IS NOT IN IT, AND WHY THAT IS DESIGNED
 *
 * An ALLOW-LIST, not a deny-list. A deny-list ships whatever nobody thought of,
 * and the things nobody thinks of here are `.keys/kickback-extension.pem` - the
 * Chrome Web Store signing key - `.env.local`, and the authenticated Firefox
 * profiles the E2E harness runs against. One forgotten pattern and a private
 * key goes to a reviewer. So this names what goes in, the scanner from
 * package-shared.mjs reads every file on the way past, and anything unexpected
 * fails the run instead of shipping.
 *
 * THE E2E HARNESS IS EXCLUDED ON PURPOSE
 *
 * `scripts/firefox-e2e/` drives real browsers against real authenticated
 * profiles. A reviewer does not need it to build, cannot run it without
 * credentials nobody should send them, and its presence would only invite the
 * question of where those profiles are. `npm run build` does not reference it.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join, relative } from 'node:path'
import { writeZip } from './zip.mjs'
import { JWT_LITERAL, step, walk } from './package-shared.mjs'

const RELEASES = 'releases'

/**
 * An optional revision label for pre-submission candidates.
 *
 *   WATCHSIDE_AMO_REV=r2 npm run package:amo
 *
 * A candidate is not a release: it may be rebuilt several times before anything
 * is uploaded, and each rebuild is a different decision about what we are
 * asking Mozilla to sign. Overwriting the previous one would erase the record
 * of what changed and why, so a superseded candidate keeps its name and the new
 * one is labelled.
 *
 * Read from the environment rather than argv because npm forwards extra
 * arguments only to the last command in a chained script, and this has to reach
 * both the packager and the source archive.
 */
const REVISION = (process.env.WATCHSIDE_AMO_REV ?? '').trim()
const REV_SUFFIX = REVISION ? `-${REVISION}` : ''

const DIST = 'dist-firefox'

/** The same fixed stamp the extension archive uses; see package-firefox.mjs. */
const DETERMINISTIC_DATE = new Date(1980, 0, 1, 0, 0, 0)

/**
 * Everything `npm ci && npm run build` touches, and nothing else.
 *
 * `tests/` is in the list because it has to be: `npm run build` starts with
 * `tsc -b`, and tsconfig.json references tsconfig.test.json, so a reviewer
 * without the tests gets a compile error rather than a build.
 */
const SOURCE_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'tsconfig.test.json',
  'vite.config.ts',
  'vite.background.config.ts',
  'vite.testlab.config.ts',
  'vitest.config.ts',
  'eslint.config.js',
]

/*
 * `supabase/functions` is here for one reason: `tests/extension/twitchMetadata.test.ts`
 * imports the Edge Function's Twitch client, and `tsc -b` type-checks the tests.
 * Without it the reviewer's build stops at a missing module.
 *
 * `supabase/migrations` and `supabase/.temp` are NOT here. Migrations are the
 * server's contract rather than the add-on's source, and `.temp` is the
 * Supabase CLI's local link state - a project ref and a pooler URL that belong
 * to this machine and to nobody else.
 */
const SOURCE_DIRS = ['public', 'src', 'tests', 'supabase/functions']

/*
 * All of `scripts/` except the E2E harness.
 *
 * Named as a directory rather than a list of files, because the list was wrong:
 * a first attempt itemised the five scripts the packager calls and the
 * reviewer's build failed on `extension-identity.mjs` and on the `.d.mts`
 * declarations that stop `tsc` treating every .mjs import as `any`. A build
 * that has to be reproduced exactly is the wrong place to be clever about what
 * is "needed" - so the rule is the whole directory, minus the one subtree that
 * must not travel.
 */
const SOURCE_SCRIPT_DIR = 'scripts'
const SOURCE_SCRIPT_EXCLUDE = /^firefox-e2e\//

/**
 * Paths that must never appear, checked by name as well as by content.
 *
 * Belt and braces over the allow-list: if somebody widens SOURCE_DIRS one day,
 * this is the thing that still refuses.
 */
const FORBIDDEN = [
  /(^|[\\/])\.keys([\\/]|$)/,
  /\.pem$/,
  /(^|[\\/])\.env\.local$/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])seeds\.local\.json$/,
  /(^|[\\/])dist(-[a-z]+)?([\\/]|$)/,
  /(^|[\\/])releases([\\/]|$)/,
  /(^|[\\/])firefox-e2e([\\/]|$)/,
]

/**
 * Credential VALUES, not the vocabulary of credentials.
 *
 * package-shared.mjs matches bare words - `service_role`, `client_secret`,
 * `supabase_admin` - which is right for a built bundle, where those words have
 * no business appearing at all. In SOURCE they appear constantly and correctly:
 * `tests/extension/bundle.test.ts` is the test that asserts the bundle contains
 * no secrets, so it has to name every one of them, and package-shared.mjs is
 * the pattern list itself. Reusing those patterns here flags the security
 * machinery for being about security.
 *
 * So these match things that can only be an actual leak: a key with a body, a
 * real PEM block, a signed token, a connection string carrying a password.
 * Whether a file may be here at all is answered separately, by the allow-list
 * and by FORBIDDEN above - which is where `.env.local`, `.keys/` and `*.pem`
 * are refused by name.
 */
const SOURCE_SECRETS = [
  { label: 'a Supabase secret key', pattern: /sb_secret_[A-Za-z0-9_-]{10,}/ },
  { label: 'a private key block', pattern: /-----BEGIN (RSA |ENCRYPTED )?PRIVATE KEY-----/ },
  {
    label: 'a connection string with credentials',
    pattern: /postgres(ql)?:\/\/[^\s:@'"`]+:[^\s@'"`]+@/,
  },
  { label: 'a client secret value', pattern: /client_secret["'\s:=]+[A-Za-z0-9]{20,}/ },
]

const problems = []
const fail = (message) => problems.push(message)

/**
 * The two public build values, read back out of the BUILT bundle.
 *
 * Not from `.env.local`, which is where a service-role key would be if anybody
 * ever pasted one there. These two are already compiled into the artifact we
 * upload - a reviewer can read them out of it - so writing them here reveals
 * nothing and is the only way the rebuild can match byte for byte.
 */
function publicBuildValues() {
  const bundle = join(DIST, 'kickback-background.js')
  if (!existsSync(bundle)) {
    fail(`no ${bundle} - run npm run package:firefox first`)
    return null
  }
  const source = readFileSync(bundle, 'utf8')

  const origins = [...new Set([...source.matchAll(/https:\/\/[a-z0-9-]+\.supabase\.co/g)].map((m) => m[0]))]
  const keys = [...new Set([...source.matchAll(/sb_publishable_[A-Za-z0-9_-]+/g)].map((m) => m[0]))]

  if (origins.length !== 1) fail(`expected one Supabase origin in the bundle, found ${origins.length}`)
  if (keys.length !== 1) fail(`expected one publishable key in the bundle, found ${keys.length}`)
  /*
   * The one thing that must never be here. A publishable key is client-safe by
   * design and protected by row-level security; a service-role key bypasses all
   * of it. They are distinguishable by prefix, so this is checkable rather than
   * a matter of care.
   *
   * Matched on a key BODY, not on the prefix. A looser `sb_secret_` fires on
   * supabase-js itself, whose key validator carries both prefixes as string
   * literals in order to reject one of them - a false positive that says
   * "secret leaked" about a library doing exactly the right thing.
   */
  for (const { label, pattern } of SOURCE_SECRETS) {
    if (pattern.test(source)) fail(`the built bundle contains ${label}`)
  }

  return { origin: origins[0] ?? null, key: keys[0] ?? null }
}

function reviewerEnv({ origin, key }) {
  return `# Build values for reproducing the AMO upload.
#
# Both are PUBLIC. They are compiled into the extension you are reviewing and
# can be read straight out of kickback-background.js in the uploaded archive.
# The publishable key is client-safe and is protected by row-level security on
# the server; it is not a secret and grants nothing on its own.
#
# Copy this file to .env.local before building.

VITE_SUPABASE_URL=${origin}
VITE_SUPABASE_PUBLISHABLE_KEY=${key}
VITE_KICKBACK_MODE=production
`
}

function reviewerReadme({ version, sha256, origin, candidateName }) {
  return `# Watchside ${version} — building the Firefox add-on from source

This archive rebuilds the uploaded add-on exactly. Everything below has been run
end to end; there are no manual steps and nothing is fetched except npm packages.

## What produced the upload

| | |
| --- | --- |
| Uploaded file | \`${candidateName}\` |
| SHA256 | \`${sha256}\` |
| Built on | Windows 11, Node ${process.versions.node}, npm ${npmVersion()} |
| Bundler | Vite (rollup) + esbuild, via \`npm run build\` |
| Minified | yes — this is why a source submission accompanies it |

## Environment

The default reviewer image (Ubuntu 24.04, Node 24.x, npm 11.x) is sufficient.
No global tools, no native compilation, no network access beyond the npm
registry, and no environment variable you have to invent.

Any Node 24.x should reproduce these bytes. The build is deterministic: the
bundlers are pinned by \`package-lock.json\`, and every entry in the output ZIP
is written with a fixed timestamp, so two builds of this source produce
identical archives rather than archives that differ only by clock.

## Build

\`\`\`sh
npm ci                  # installs exactly the versions in package-lock.json
cp .env.amo .env.local  # two PUBLIC build values; see the comments in that file
npm run package:firefox
\`\`\`

That is the whole sequence.

## Expected output

\`\`\`
releases/Watchside-Firefox-v${version}.zip   the archive
dist-firefox/package/                        the same files, unpacked
\`\`\`

\`npm run package:firefox\` prints a SHA256 when it finishes. Compare the
**unpacked contents** in \`dist-firefox/package/\` against the archive you are
reviewing:

\`\`\`sh
unzip -o ${candidateName} -d /tmp/uploaded
diff -r /tmp/uploaded dist-firefox/package
\`\`\`

That diff is expected to be empty.

The two archive filenames differ by design: \`Watchside-Firefox-*.zip\` is what
the build script writes, and the AMO candidate is that same archive under a name
that says what it is for. Their contents are identical.

## What the build does

1. \`tsc -b\` type-checks the app, the build config and the tests.
2. \`vite build\` bundles the content script; \`vite build -c vite.background.config.ts\`
   bundles the background.
3. \`scripts/package-firefox.mjs\` derives the Firefox manifest from
   \`public/manifest.json\` (see \`scripts/manifest.mjs\`), stages the runtime files
   against an allow-list, scans every file for anything secret-shaped, and
   writes the ZIP with fixed timestamps.

The Firefox manifest is DERIVED rather than checked in, which is why you will
not find one in \`public/\`. \`scripts/manifest.mjs\` is where the Gecko
differences live: the event-page background, the add-on id, the minimum Firefox
version, the data-collection declaration, and the Supabase host permission
narrowed from the Chromium wildcard to \`${origin}\`.

## Not included, and why

- \`node_modules/\` — restored by \`npm ci\` from the included lockfile.
- \`.env.local\` — the developer's own file. \`.env.amo\` carries the two public
  values the build actually needs.
- \`scripts/firefox-e2e/\` — an end-to-end harness that drives real browsers
  against authenticated profiles. It is not part of the build, and it is not
  something to hand to a third party.
- \`.keys/\`, \`releases/\`, \`dist*/\` — signing material, previous archives, and
  build output.
`
}

function npmVersion() {
  try {
    return process.env.npm_config_user_agent?.match(/npm\/(\S+)/)?.[1] ?? 'see package-lock.json'
  } catch {
    return 'see package-lock.json'
  }
}

/**
 * The secret scan, retuned for SOURCE rather than for a built artifact.
 *
 * package-shared.mjs's scanner is the right one for an extension package and
 * the wrong one here, twice over. Its path rules forbid `src/`, `tests/` and
 * `scripts/` outright - correct for something being shipped to users, and the
 * exact opposite of what a source archive is - and its content rules only look
 * at .js/.json/.html, so every .ts and .tsx file would go unread.
 *
 * So the dangerous CONTENT patterns are reused verbatim and the path rules are
 * not. The one rule dropped is the env-file line, because .env.amo exists to
 * carry precisely that line with the public value in it.
 */

const SCANNABLE = /.(ts|tsx|js|jsx|mjs|cjs|json|html|css|md|txt|yml|yaml)$/i

function scanSource(entries) {
  for (const { name, path } of entries) {
    if (!SCANNABLE.test(name)) continue
    const text = readFileSync(path, 'utf8')
    for (const { label, pattern } of SOURCE_SECRETS) {
      if (pattern.test(text)) fail(`${name} contains ${label}`)
    }
    if (JWT_LITERAL.test(text)) fail(`${name} contains a JWT-shaped literal`)
  }
}

function collect() {
  const entries = []

  const add = (path) => {
    const rel = relative('.', path).split('\\').join('/')
    if (FORBIDDEN.some((pattern) => pattern.test(rel))) {
      fail(`refusing to include ${rel}`)
      return
    }
    entries.push({ name: rel, path })
  }

  for (const file of SOURCE_FILES) {
    if (!existsSync(file)) {
      fail(`missing source file: ${file}`)
      continue
    }
    add(file)
  }

  for (const dir of SOURCE_DIRS) {
    if (!existsSync(dir)) {
      fail(`missing source directory: ${dir}`)
      continue
    }
    // walk() yields paths relative to the directory it was given, so the
    // directory goes back on before anything tries to read them.
    for (const rel of walk(dir)) add(join(dir, rel))
  }

  for (const rel of walk(SOURCE_SCRIPT_DIR)) {
    if (SOURCE_SCRIPT_EXCLUDE.test(rel)) continue
    add(join(SOURCE_SCRIPT_DIR, rel))
  }

  return entries
}

function main() {
  step('Reading the built bundle')
  const values = publicBuildValues()
  if (problems.length > 0) return report()
  console.log(`  backend        : ${values.origin}`)
  console.log('  publishable key: present, client-safe prefix')

  const version = JSON.parse(readFileSync('package.json', 'utf8')).version
  const candidate = join(RELEASES, `Watchside-AMO-Candidate-v${version}${REV_SUFFIX}.zip`)
  if (!existsSync(candidate)) {
    fail(`no ${candidate} - run npm run package:amo, which builds it first`)
    return report()
  }
  const sha256 = createHash('sha256').update(readFileSync(candidate)).digest('hex')

  step('Collecting source')
  const entries = collect()
  if (problems.length > 0) return report()
  console.log(`  files          : ${entries.length}`)

  step('Scanning for anything secret-shaped')
  scanSource(entries)
  if (problems.length > 0) return report()
  console.log('  scanned        : every text file, for keys and credentials')

  const generated = [
    { name: '.env.amo', body: reviewerEnv(values) },
    { name: 'REVIEWER-BUILD.md', body: reviewerReadme({ version, sha256, origin: values.origin, candidateName: basename(candidate) }) },
  ]

  step('Writing the archive')
  mkdirSync(RELEASES, { recursive: true })
  const out = join(RELEASES, `Watchside-AMO-Source-v${version}${REV_SUFFIX}.zip`)

  writeZip(
    out,
    [
      ...entries.map((e) => ({ name: e.name, source: readFileSync(e.path) })),
      ...generated.map((g) => ({ name: g.name, source: Buffer.from(g.body, 'utf8') })),
    ],
    { date: DETERMINISTIC_DATE },
  )

  const bytes = statSync(out).size
  const digest = createHash('sha256').update(readFileSync(out)).digest('hex')

  console.log(`\nSource package for AMO v${version}`)
  console.log(`  ${out}`)
  console.log(`  sha256 ${digest}`)
  console.log(`  ${(bytes / 1024).toFixed(0)} KiB, ${entries.length + generated.length} entries`)
  console.log(`  documents ${candidate} (${sha256.slice(0, 16)}…)`)
  console.log('\nContains REVIEWER-BUILD.md and .env.amo. No node_modules, no')
  console.log('secrets, no signing keys, no E2E profiles.')

  return 0
}

function report() {
  console.error('\nSource packaging FAILED')
  for (const problem of problems) console.error(`  - ${problem}`)
  return 1
}

process.exit(main())
