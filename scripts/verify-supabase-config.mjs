/**
 * Preflight check for the local Supabase configuration.
 *
 *   npm run verify:config
 *
 * Only Supabase can say whether a publishable key is real. A truncated key is
 * indistinguishable from a good one by inspection - it looks right, it has the
 * right prefix, and every offline test passes - and then fails much later as
 * "Invalid API key" during the OAuth code exchange. This asks the project
 * directly, before you spend a round trip through Twitch finding out.
 *
 * Reads .env.local. Prints no key material.
 */
import { existsSync, readFileSync } from 'node:fs'

const ENV_PATH = '.env.local'

function readEnv() {
  const env = {}
  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const at = trimmed.indexOf('=')
    env[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
  }
  return env
}

async function main() {
  if (!existsSync(ENV_PATH)) {
    console.error(`${ENV_PATH} not found. Copy .env.example to ${ENV_PATH} and fill it in.`)
    return 1
  }

  const env = readEnv()
  const url = env.VITE_SUPABASE_URL
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY

  if (!url || !key) {
    console.error('VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY must both be set.')
    return 1
  }

  console.log('project      :', url)
  console.log('key length   :', key.length, '(value not printed)')

  if (!key.startsWith('sb_publishable_')) {
    console.error('\nThis does not look like a publishable key.')
    console.error('Never put a service-role or secret key in the extension.')
    return 1
  }

  let response
  try {
    response = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } })
  } catch (error) {
    console.error('\nCould not reach the project:', error.message)
    return 1
  }

  if (response.status === 401) {
    console.error('\nREJECTED - Supabase says: Invalid API key.')
    console.error('Re-copy it from Supabase -> Project Settings -> API Keys.')
    console.error('Check the last character; a key short by one still looks correct.')
    return 1
  }

  if (!response.ok) {
    console.error(`\nUnexpected response: HTTP ${response.status}`)
    return 1
  }

  const settings = await response.json()
  const twitchEnabled = settings?.external?.twitch === true

  console.log('key accepted :', 'yes')
  console.log('twitch auth  :', twitchEnabled ? 'enabled' : 'DISABLED')

  if (!twitchEnabled) {
    console.error('\nTwitch is not enabled for this project. Sign-in will fail.')
    console.error('Supabase -> Authentication -> Sign In / Providers -> Twitch.')
    return 1
  }

  console.log('\nConfiguration looks good.')
  return 0
}

// Set exitCode rather than calling process.exit(): exiting while a fetch handle
// is still open aborts the process on Windows before the code is reported.
process.exitCode = await main()
