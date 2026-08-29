/**
 * Asks the hosted Supabase project whether the group backend is really there.
 *
 *   npm run verify:groups
 *
 * WHY THIS EXISTS, AND HOW TO READ ITS ANSWERS
 *
 * An earlier version of this check reported migrations 0007/0008 as missing
 * when they were in fact applied. The mistake was reading PostgREST's error
 * codes as a single "did it work" boolean. They are not:
 *
 *   42501     permission denied      -> the object EXISTS. Anonymous callers
 *                                       have no rights on it, which is exactly
 *                                       Watchside's design: tables are reached
 *                                       only through SECURITY DEFINER RPCs.
 *   PGRST205  table not in schema    -> the table is genuinely absent.
 *   PGRST202  no such function       -> no function of that NAME AND SHAPE.
 *                                       Guessing the parameter names wrong
 *                                       produces this too, so the signatures
 *                                       below must match the migrations.
 *
 * So "permission denied" is the healthy answer here, and treating it as a
 * failure is what produced two incorrect reports.
 *
 * This runs with the publishable key only. It never authenticates, never
 * writes, and never prints key material.
 */
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const ENV_PATH = '.env.local'
const NIL = '00000000-0000-0000-0000-000000000000'

/** Signatures must match supabase/migrations/0007 and 0008 exactly. */
const TABLES = ['groups', 'group_members', 'group_invites', 'group_messages', 'rate_limits']

const FUNCTIONS = [
  ['create_group', { p_name: 'x' }],
  ['rename_group', { p_group: NIL, p_name: 'x' }],
  ['delete_group', { p_group: NIL }],
  ['invite_to_group', { p_group: NIL, p_target: NIL }],
  ['respond_to_group_invite', { p_invite: NIL, p_accept: true }],
  ['leave_group', { p_group: NIL }],
  ['remove_group_member', { p_group: NIL, p_user: NIL }],
  ['send_group_message', { p_group: NIL, p_body: 'x' }],
  ['list_groups', {}],
  ['list_group_members', { p_group: NIL }],
  ['list_group_invites', {}],
  ['list_group_messages', { p_group: NIL }],
  ['is_group_member', { p_group: NIL }],
  ['shares_group_with', { p_other: NIL }],
  ['consume_presence_budget', {}],
  // 0009. Group icons need the new RPC and the two-argument create_group.
  ['set_group_icon', { p_group: NIL, p_icon: 'x' }],
  ['create_group', { p_name: 'x', p_icon: 'x' }],
  // 0010. The invite button reads its state from this.
  ['list_group_sent_invites', { p_group: NIL }],
  // 0011. Twitch display names. These are revoked from every client role,
  // so "permission denied" is the healthy answer and absence is the signal.
  ['display_name_from_meta', { p_meta: {}, p_login: 'x' }],
  ['login_from_meta', { p_meta: {} }],
  // 0012. Withdrawing an invitation nobody has answered.
  ['cancel_group_invite', { p_group: NIL, p_target: NIL }],
]

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

async function codeOf(response) {
  const text = await response.text()
  try {
    return JSON.parse(text).code ?? null
  } catch {
    return null
  }
}

export async function verifyGroupSchema({ quiet = false } = {}) {
  const log = (...parts) => {
    if (!quiet) console.log(...parts)
  }

  if (!existsSync(ENV_PATH)) {
    console.error(`${ENV_PATH} not found - cannot check the hosted project.`)
    return { ok: false, missing: ['(no configuration)'] }
  }

  const env = readEnv()
  const url = env.VITE_SUPABASE_URL
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) {
    console.error('VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY must both be set.')
    return { ok: false, missing: ['(no configuration)'] }
  }

  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json' }
  const missing = []

  log('project      :', url)
  log('checking     : migrations 0006 - 0012 against the hosted database\n')

  for (const table of TABLES) {
    let code
    try {
      code = await codeOf(await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, { headers }))
    } catch (error) {
      console.error(`Could not reach the project: ${error.message}`)
      return { ok: false, missing: ['(unreachable)'] }
    }
    // PGRST205 is the only answer that means the table is not there.
    const present = code !== 'PGRST205'
    log(`  table    ${present ? 'present' : 'MISSING'}  ${table}${present ? '' : '  <-- not applied'}`)
    if (!present) missing.push(`table ${table}`)
  }

  for (const [name, args] of FUNCTIONS) {
    let code
    try {
      code = await codeOf(
        await fetch(`${url}/rest/v1/rpc/${name}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(args),
        }),
      )
    } catch (error) {
      console.error(`Could not reach the project: ${error.message}`)
      return { ok: false, missing: ['(unreachable)'] }
    }
    const present = code !== 'PGRST202'
    log(`  function ${present ? 'present' : 'MISSING'}  ${name}${present ? '' : '  <-- not applied'}`)
    if (!present) missing.push(`function ${name}`)
  }

  if (missing.length > 0) {
    console.error('\nDATABASE MIGRATION REQUIRED.')
    console.error('The hosted database is missing part of the group backend, so what')
    console.error('depends on it would be broken for every tester:\n')
    for (const item of missing) console.error(`  - ${item}`)
    console.error('')
    console.error('To fix it:')
    console.error('  1. npm run db:bundle')
    console.error('  2. Open the Supabase dashboard -> SQL Editor')
    console.error('  3. Paste all of supabase/.generated/apply_all.sql and run it')
    console.error('  4. Re-run npm run verify:groups\n')
    return { ok: false, missing }
  }

  log('\nGroup backend is applied. Groups and group chat have a database to talk to.')
  return { ok: true, missing: [] }
}

// pathToFileURL, not string surgery: a Windows drive letter never matches a
// naive file:// prefix, and the check would silently do nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ok } = await verifyGroupSchema()
  process.exit(ok ? 0 : 1)
}
