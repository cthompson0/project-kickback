/**
 * Mutation check for the authorization suite.
 *
 * A green test run only means something if the tests would go red when the
 * protection is removed. This script takes the real migrations, weakens one
 * safeguard at a time, re-runs the suite against the weakened copy, and asserts
 * that the test which is supposed to catch that regression actually fails.
 *
 *   npm run test:authz
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { changedSections, fingerprint } from './schema-fingerprint.mjs'

export const MUTATIONS = [
  {
    name: 'grants: hand DML back to authenticated',
    file: '0002_policies.sql',
    append: `
      grant insert, update, delete on public.presence to authenticated;
      grant insert, update, delete on public.friendships to authenticated;
      grant insert, update, delete on public.user_preferences to authenticated;
    `,
    expect: 'refuses to let a user modify their own presence row directly',
  },
  {
    name: 'RLS: disable row level security on presence',
    file: '0002_policies.sql',
    append: 'alter table public.presence disable row level security;',
    expect: 'hides presence from non-friends entirely',
  },
  {
    // 0022 rewrote respond_to_friend_request to re-check blocks, so 0003's
    // copy is dead SQL. Anchored on the live one.
    name: 'RPC: drop the recipient check when responding to a request',
    file: '0022_blocks.sql',
    from: `  if not found or v_req.to_user <> v_actor then
    raise exception 'kickback: friend request not found' using errcode = 'P0002';
  end if;`,
    to: `  if not found then
    raise exception 'kickback: friend request not found' using errcode = 'P0002';
  end if;`,
    expect: "refuses to let a third party accept someone else's request",
  },
  {
    /*
     * report_presence has moved twice. 0006 added the rate guard, and 0025
     * rewrote it again for destinations - so the note that used to sit here,
     * "0006 redefines report_presence so this must target the live
     * definition", was right about the principle and had itself gone stale.
     * The effectiveness check in the runner is what stops that recurring.
     *
     * The trailing `return;` is load-bearing as an anchor: report_destinations
     * in the same file redacts identically and ends `return 0;`.
     */
    name: 'privacy: let timestamps move while invisible',
    file: '0025_presence_destinations.sql',
    from: `     where user_id = v_actor
       and (status <> 'offline' or platform is not null or channel is not null);
    return;`,
    to: `     where user_id = v_actor;
    return;`,
    expect: 'does not leak an invisible user through a ticking last_seen_at',
  },
  {
    // search_users has been rewritten twice since 0003 - by 0022 for blocks
    // and by 0041 for the rate budget. 0041 holds the live prefix build.
    name: 'search: stop escaping LIKE wildcards',
    file: '0041_search_rate_budget.sql',
    from: `       or (ca.platform_login is not null and ca.platform_login like v_prefix)`,
    to: `       or (ca.platform_login is not null and ca.platform_login like v_login || '%')`,
    expect: 'does not treat an underscore in the query as a wildcard',
  },
  {
    /*
     * Also 0025 now. The leading `end if;` is what makes this unique:
     * report_destinations shares the budget and guards it with byte-identical
     * lines a hundred lines earlier in the same file.
     */
    name: 'presence: remove the write rate guard',
    file: '0025_presence_destinations.sql',
    from: `  end if;

  if not public.consume_presence_budget() then
    raise exception 'kickback: presence rate limit exceeded' using errcode = '53400';
  end if;`,
    to: '  end if;',
    expect: 'refuses a client hammering report_presence',
  },
  {
    name: 'presence: expose the rate counter to clients',
    file: '0006_presence_rate_limit.sql',
    append: 'grant select on public.presence_rate to authenticated;',
    expect: 'keeps the counter table unreadable',
  },
  {
    // send_friend_request is redefined by 0022 and again by 0039. Only the
    // last one runs.
    name: 'requests: drop the self-friending guard',
    file: '0039_operations.sql',
    from: `  if p_target = v_actor then
    raise exception 'kickback: you cannot add yourself' using errcode = '22023';
  end if;`,
    to: '',
    expect: 'refuses self-friending',
  },
  {
    // 0022 drops and recreates this policy to add the block check, so the
    // 0007 version never survives a migration run.
    name: 'groups: open chat to non-members',
    file: '0022_blocks.sql',
    from: `create policy group_messages_select on public.group_messages
  for select to authenticated
  using (public.group_message_visible(group_id, user_id));`,
    to: `create policy group_messages_select on public.group_messages
  for select to authenticated
  using (true);`,
    expect: 'shows a non-member nothing at all',
  },
  {
    name: 'groups: let anyone send to any group',
    file: '0008_group_rpcs.sql',
    from: `  if not public.is_group_member(p_group) then
    raise exception 'kickback: you are not in this group' using errcode = '42501';
  end if;`,
    to: '',
    expect: 'refuses to let a non-member send',
  },
  {
    name: 'groups: drop group-scoped presence',
    file: '0007_groups.sql',
    from: `    or public.is_friend(user_id)
    or public.shares_group_with(user_id)
  );`,
    to: `    or public.is_friend(user_id)
  );`,
    expect: 'lets group members see each other despite not being friends',
  },
  {
    name: 'groups: let members remove each other',
    file: '0008_group_rpcs.sql',
    from: `  if not public.is_group_owner(p_group) then
    raise exception 'kickback: only the group owner can do that' using errcode = '42501';
  end if;
  if p_user = v_actor then`,
    to: `  if p_user = v_actor then`,
    expect: 'refuses a delete or removal by a member',
  },
  {
    // Added with group icons in 0009. Without the ownership check any member
    // could restyle a group that is not theirs.
    name: 'groups: let any member change the icon',
    file: '0009_group_icons.sql',
    from: `  if not exists (
    select 1 from public.groups g
    where g.id = p_group and g.owner_id = v_actor
  ) then
    raise exception 'kickback: group not found' using errcode = 'P0002';
  end if;`,
    to: '',
    expect: 'refuses an icon change by a member or a stranger',
  },
  {
    name: 'groups: drop the icon length bound',
    file: '0009_group_icons.sql',
    from: `  if v_icon is not null and char_length(v_icon) > 24 then
    raise exception 'kickback: group icon is too long' using errcode = '22023';
  end if;

  -- The ownership check is the authorization boundary.`,
    to: '  -- The ownership check is the authorization boundary.',
    expect: 'refuses an icon long enough to be a second name',
  },
  {
    // The bug 0011 fixed: reading the claim that holds the login instead of
    // the one that holds the display name, so every profile was lowercase.
    name: 'identity: read the display name from the login claim',
    file: '0011_twitch_display_name.sql',
    from: `        -- Twitch: the display name, with its capitalisation.
        nullif(btrim(coalesce(p_meta ->> 'nickname', '')), ''),
        nullif(btrim(coalesce(p_meta ->> 'slug', '')), ''),`,
    to: '',
    expect: "keeps Twitch's capitalisation, from the claim that actually carries it",
  },
  {
    name: 'identity: fabricate capitalisation from the login',
    file: '0011_twitch_display_name.sql',
    from: `        coalesce(p_login, '')`,
    to: `        initcap(coalesce(p_login, ''))`,
    expect: 'falls back to the login itself, unaltered, when no name claim arrives',
  },
  {
    name: 'invites: let anyone cancel an invitation',
    file: '0012_cancel_group_invite.sql',
    from: `  if not exists (
    select 1 from public.groups g
    where g.id = p_group and g.owner_id = v_actor
  ) then
    raise exception 'kickback: group not found' using errcode = 'P0002';
  end if;`,
    to: '',
    expect: 'refuses a cancellation by a member or a stranger',
  },
  {
    name: 'invites: let cancellation remove an accepted member',
    file: '0012_cancel_group_invite.sql',
    from: "    and i.status = 'pending'",
    to: '',
    expect: 'refuses to cancel an invitation that was already accepted',
  },
]

const REPORT = join(tmpdir(), 'kickback-authz-report.json')

/**
 * Run the suite against a migrations directory and return WHICH TESTS FAILED.
 *
 * THE DEFECT THIS REPLACES
 *
 * This used to run with `--reporter=verbose` and decide detection with
 * `failed && output.includes(mutation.expect)`. The verbose reporter prints the
 * name of every test it runs, passing ones included - so the second half of
 * that condition was true for any mutation whose test file merely executed. In
 * practice the check collapsed to "did the suite exit nonzero", and any
 * unrelated failure credited every lever at once.
 *
 * That is not hypothetical. A baseline run in a worktree with no `dist/` had 29
 * unrelated failures and reported all eighteen mutations as detected, which
 * very nearly became evidence that a UI change had broken authorization.
 *
 * The JSON reporter gives per-assertion results, so detection can be attributed
 * to the assertion that is supposed to do the catching.
 */
export function runSuite(migrationsDir) {
  rmSync(REPORT, { force: true })

  let crashOutput = null
  try {
    execFileSync('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${REPORT}`], {
      env: { ...process.env, KICKBACK_MIGRATIONS_DIR: migrationsDir },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
  } catch (error) {
    // A nonzero exit is the NORMAL case here - the suite is meant to go red.
    // Only a missing report means the run itself fell over.
    crashOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }

  if (!existsSync(REPORT)) {
    return { failures: [], total: 0, crashed: crashOutput ?? 'no report written' }
  }

  const report = JSON.parse(readFileSync(REPORT, 'utf8'))
  const failures = []
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status === 'failed') failures.push(assertion.title)
    }
  }
  const total = report.numTotalTests ?? 0
  if (total === 0) {
    return { failures, total, crashed: crashOutput ?? 'suite ran no tests' }
  }
  return { failures, total, crashed: null }
}

/**
 * Write one weakened copy of the migrations.
 *
 * The uniqueness check is not fussiness. `report_destinations` and
 * `report_presence` sit in the same file and redact identically, so an anchor
 * matching both would silently mutate the wrong function - `String.replace`
 * takes the first match, which is the one nobody meant.
 */
export function applyMutation(mutation, dir) {
  const target = join(dir, mutation.file)
  const original = readFileSync(target, 'utf8')

  if (mutation.append) {
    writeFileSync(target, `${original}\n${mutation.append}\n`)
    return { ok: true }
  }

  const hits = original.split(mutation.from).length - 1
  if (hits === 0) {
    return { ok: false, reason: `anchor no longer present in ${mutation.file}` }
  }
  if (hits > 1) {
    return { ok: false, reason: `anchor matches ${hits} places in ${mutation.file} - narrow it` }
  }

  writeFileSync(target, original.replace(mutation.from, () => mutation.to))
  return { ok: true }
}

/**
 * One lever, start to finish.
 *
 * Two questions in order, because they fail differently and the second is only
 * meaningful once the first passes:
 *
 *   1. does this mutation change the schema the tests actually run against?
 *      Six levers had stopped doing so - each edited a definition that a later
 *      migration replaces - and a mutation that changes nothing cannot be
 *      "missed" by a test. Reporting that as a missing test, which is what the
 *      old harness did, points the reader at the wrong file entirely.
 *
 *   2. does the assertion that claims to catch it actually fail?
 */
export async function verifyMutation(mutation, baseline) {
  const dir = mkdtempSync(join(tmpdir(), 'kickback-mutation-'))
  try {
    cpSync('supabase/migrations', dir, { recursive: true })

    const applied = applyMutation(mutation, dir)
    if (!applied.ok) return { verdict: 'BROKEN ANCHOR', detail: applied.reason }

    const mutated = await fingerprint(dir)
    if (mutated.failed) {
      return { verdict: 'WILL NOT APPLY', detail: mutated.failed.slice(0, 200) }
    }

    const changed = changedSections(baseline, mutated)
    if (changed.length === 0) {
      return {
        verdict: 'INEFFECTIVE',
        detail:
          'the mutated SQL never reaches the built schema - a later migration ' +
          'supersedes it. Repoint this lever at the definition that survives.',
      }
    }

    const { failures, crashed } = runSuite(dir)
    if (crashed) return { verdict: 'INCONCLUSIVE', detail: crashed.slice(0, 200) }

    const caught = failures.filter((title) => title.includes(mutation.expect))
    if (caught.length === 0) {
      return {
        verdict: 'NOT DETECTED',
        detail:
          failures.length === 0
            ? `changed ${changed.join(', ')} and every test still passed - this regression would ship`
            : `changed ${changed.join(', ')}; ${failures.length} test(s) failed, none of them "${mutation.expect}"`,
      }
    }
    return {
      verdict: 'DETECTED',
      detail: `caught by "${caught[0]}" (changed ${changed.join(', ')})`,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function main() {
  /*
   * THE BASELINE MUST BE GREEN, AND THAT IS CHECKED RATHER THAN ASSUMED.
   *
   * Every verdict below is "did the expected assertion fail". If some test is
   * ALREADY failing - a stale build artifact, a half-finished edit, a worktree
   * without dist/ - then a mutation can be credited with a failure it had
   * nothing to do with. Running once, unmutated, first is what makes the rest
   * of this run mean anything.
   */
  process.stdout.write('Baseline: building the schema and running the suite unmutated... ')
  const baseline = await fingerprint('supabase/migrations')
  if (baseline.failed) {
    console.error(`\nthe migrations do not apply cleanly: ${baseline.failed}`)
    process.exit(1)
  }

  const clean = runSuite('supabase/migrations')
  if (clean.crashed) {
    console.error(`\nthe suite could not run: ${clean.crashed}`)
    process.exit(1)
  }
  if (clean.failures.length > 0) {
    console.error('\nREFUSING TO RUN: the suite is already red before any mutation.')
    console.error('Every verdict here is "did the expected assertion fail", which')
    console.error('means nothing while something else is failing too. Fix these first:')
    for (const title of [...new Set(clean.failures)].slice(0, 10)) {
      console.error(`  - ${title}`)
    }
    process.exit(1)
  }
  console.log(`green (${clean.total} tests), schema ${baseline.digest.slice(0, 12)}\n`)

  let broken = 0

  for (const mutation of MUTATIONS) {
    const { verdict, detail } = await verifyMutation(mutation, baseline)
    console.log(`${verdict.padEnd(14)} ${mutation.name}`)
    console.log(`               ${detail}`)
    if (verdict !== 'DETECTED') broken += 1
  }

  console.log(`\n${MUTATIONS.length - broken}/${MUTATIONS.length} mutations detected`)
  if (broken > 0) {
    console.error(
      '\nA lever that is not DETECTED is a hole in the harness or in the tests.\n' +
        'INEFFECTIVE means the mutation edits SQL a later migration replaces - repoint it.\n' +
        'NOT DETECTED means the assertion named by the lever did not fail - that is a\n' +
        'missing or weakened test, and the more serious of the two.',
    )
  }
  process.exit(broken === 0 ? 0 : 1)
}

// Importable by tests/extension/authzHarness.test.ts without running anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
