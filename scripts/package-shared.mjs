/**
 * The parts of packaging that must be identical for every browser.
 *
 * Watchside now produces packages for two engines. What may differ between
 * them is the manifest and the archive's shape; what must NOT differ is the
 * safety net - which files are allowed in, which paths can never appear, and
 * which strings would mean a secret or a demo build had escaped.
 *
 * Two copies of that list would eventually disagree, and the copy that fell
 * behind would be the one that let something through. So there is one copy,
 * here, imported by both packagers.
 *
 * Everything in this file is pure or takes its reporting channel as an
 * argument, so neither packager inherits the other's state.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative } from 'node:path'

/**
 * Exactly what the extension needs at runtime, and nothing else.
 *
 * An allow-list rather than "copy dist/ and delete the bad bits": the failure
 * mode of a deny-list is shipping something nobody thought to exclude.
 */
export const RUNTIME_FILES = [
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
 * Things that must never appear in a package, by name.
 *
 * Matched against the archive path, case-insensitively. `.map` is on the list
 * because a source map would hand a reader the unminified source - which is a
 * decision to make deliberately, in an AMO source submission, not by accident
 * in a shipped archive.
 */
export const FORBIDDEN_PATHS = [
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
 * a mention of one matters. `@supabase/supabase-js` ships a function that asks
 * whether a key starts with "sb_secret_", so the bare prefix appears in the
 * bundle with no key attached; rejecting on that would be a false alarm that
 * teaches us to ignore the scanner. What must never appear is an actual key,
 * so the pattern requires the value.
 *
 * The publishable key is deliberately absent: it is public client config and
 * belongs in the bundle. It cannot be confused with `sb_secret_`, which is a
 * different prefix.
 */
export const FORBIDDEN_CONTENT = [
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
 * `provider_token` lives in supabase-js's session parser, so the background
 * bundle legitimately contains the string. The rule that matters is that it
 * never reaches the Twitch page, where page scripts could see it.
 */
export const FILE_SCOPED_CONTENT = {
  'kickback-content.js': [
    { label: 'Twitch provider token handling', pattern: /provider_(refresh_)?token/ },
    { label: 'a direct Twitch API call', pattern: /api\.twitch\.tv/ },
  ],
}

/**
 * Demo-mode fingerprints. None of this may reach a user.
 *
 * The demo client, the mock presence service and the scripted people are all
 * behind a build-time constant, so a production build drops them entirely -
 * including the wording. If any of this survives, the artifact was built in the
 * wrong mode.
 */
export const DEMO_MARKERS = [
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
export const JWT_LITERAL = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./

export function step(label) {
  console.log(`\n== ${label}`)
}

export function run(command, args, env) {
  execFileSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: env ? { ...process.env, ...env } : process.env,
  })
}

/** Every file under `dir`, as forward-slash paths relative to `base`. */
export function walk(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, base))
    else out.push(relative(base, full).split('\\').join('/'))
  }
  return out
}

/**
 * The content and path scanners, bound to a caller's failure channel.
 *
 * Taking `fail` as an argument rather than owning a module-level array is what
 * lets two packagers share these without sharing state - and lets a test drive
 * them without a process.
 */
export function createScanner(fail) {
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
        if (lower.includes(forbidden)) {
          fail(`${where}: forbidden path "${path}" (matched ${forbidden})`)
        }
      }
    }
  }

  return { scanContents, checkPaths }
}
