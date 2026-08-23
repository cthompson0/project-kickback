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
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const MUTATIONS = [
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
    name: 'RPC: drop the recipient check when responding to a request',
    file: '0003_rpcs.sql',
    from: `  if not found or v_req.to_user <> v_actor then
    raise exception 'kickback: friend request not found' using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'kickback: friend request already resolved' using errcode = '22023';
  end if;

  if p_accept then`,
    to: `  if not found then
    raise exception 'kickback: friend request not found' using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'kickback: friend request already resolved' using errcode = '22023';
  end if;

  if p_accept then`,
    expect: "refuses to let a third party accept someone else's request",
  },
  {
    // 0006 redefines report_presence, so this must target the live definition -
    // mutating the superseded copy in 0003 proves nothing.
    name: 'privacy: let timestamps move while invisible',
    file: '0006_presence_rate_limit.sql',
    from: `    update public.presence
       set status = 'offline', platform = null, channel = null,
           updated_at = now(), last_seen_at = now()
     where user_id = v_actor
       and (status <> 'offline' or platform is not null or channel is not null);
    return;`,
    to: `    update public.presence
       set status = 'offline', platform = null, channel = null,
           updated_at = now(), last_seen_at = now()
     where user_id = v_actor;
    return;`,
    expect: 'does not leak an invisible user through a ticking last_seen_at',
  },
  {
    name: 'search: stop escaping LIKE wildcards',
    file: '0003_rpcs.sql',
    from: `       or (ca.platform_login is not null and ca.platform_login like v_prefix)`,
    to: `       or (ca.platform_login is not null and ca.platform_login like v_login || '%')`,
    expect: 'does not treat an underscore in the query as a wildcard',
  },
  {
    name: 'presence: remove the write rate guard',
    file: '0006_presence_rate_limit.sql',
    from: `  if not public.consume_presence_budget() then
    raise exception 'kickback: presence rate limit exceeded' using errcode = '53400';
  end if;

  select up.presence_visibility into v_mode`,
    to: `  select up.presence_visibility into v_mode`,
    expect: 'refuses a client hammering report_presence',
  },
  {
    name: 'presence: expose the rate counter to clients',
    file: '0006_presence_rate_limit.sql',
    append: 'grant select on public.presence_rate to authenticated;',
    expect: 'keeps the counter table unreadable',
  },
  {
    name: 'requests: drop the self-friending guard',
    file: '0003_rpcs.sql',
    from: `  if p_target = v_actor then
    raise exception 'kickback: you cannot add yourself' using errcode = '22023';
  end if;`,
    to: '',
    expect: 'refuses self-friending',
  },
  {
    name: 'groups: open chat to non-members',
    file: '0007_groups.sql',
    from: `create policy group_messages_select on public.group_messages
  for select to authenticated
  using (public.is_group_member(group_id));`,
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
]

function runSuite(migrationsDir) {
  try {
    execFileSync('npx', ['vitest', 'run', '--reporter=verbose'], {
      env: { ...process.env, KICKBACK_MIGRATIONS_DIR: migrationsDir },
      encoding: 'utf8',
      stdio: 'pipe',
      shell: process.platform === 'win32',
    })
    return { failed: false, output: '' }
  } catch (error) {
    return { failed: true, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

let broken = 0

for (const mutation of MUTATIONS) {
  const dir = mkdtempSync(join(tmpdir(), 'kickback-mutation-'))
  cpSync('supabase/migrations', dir, { recursive: true })

  const target = join(dir, mutation.file)
  const original = readFileSync(target, 'utf8')

  if (mutation.append) {
    writeFileSync(target, `${original}\n${mutation.append}\n`)
  } else {
    if (!original.includes(mutation.from)) {
      console.error(`SETUP FAIL  ${mutation.name}: anchor no longer present in ${mutation.file}`)
      broken += 1
      rmSync(dir, { recursive: true, force: true })
      continue
    }
    writeFileSync(target, original.replace(mutation.from, mutation.to))
  }

  const { failed, output } = runSuite(dir)
  const caught = failed && output.includes(mutation.expect)

  console.log(
    `${caught ? 'DETECTED' : 'MISSED  '}  ${mutation.name}\n            expected to trip: "${mutation.expect}"`,
  )
  if (!caught) {
    broken += 1
    if (!failed) console.error('            suite stayed green - this regression would ship')
    else console.error('            suite failed, but not on the expected test')
  }

  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${MUTATIONS.length - broken}/${MUTATIONS.length} regressions detected`)
process.exit(broken === 0 ? 0 : 1)
