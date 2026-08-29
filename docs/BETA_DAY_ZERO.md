# Private Beta — Day 0 sanitization

Getting the hosted database to a clean measurement baseline before the first
real tester installs Watchside.

**This has been done.** The document is now a record of what was run and what it
produced, not a plan. Part 1 remains reusable — it is a read-only audit, safe to
run at any time.

**This was not a database reset.** No table was dropped, no migration re-run, no
schema, RLS, function, view or auth configuration touched. What was removed was
development residue that would otherwise have been counted as beta behaviour.

> **Everything in this document is run by the owner** in the Supabase SQL editor.
> Nothing here can be performed from the repository: `.env.local` holds only the
> publishable (anon) key, and every table involved is either revoked from client
> roles outright or gated by RLS that requires a real user session. The SQL
> editor runs as the project owner, which is the only role that can see or
> change any of this.

---

## Day 0

> ### Private Beta Day 0
>
> ## `2026-08-26 20:45:37.549219+00`

**The hosted `private_beta` analytics baseline began at zero at that instant.**
Every `private_beta` event in the database was deleted — 462 of them — and the
first event recorded after that timestamp is the first event of the real private
beta. There is no earlier beta data to exclude, no partial history to reason
around, and no cutoff to remember: the environment starts empty.

`development` analytics were preserved (93 events), so the two are separable and
always were — the environment is a build-time constant.

Every later measurement is "since Day 0". The denominator is exact.

---

## Part 1 — The audit (read-only, one query)

This ran before the cleanup, and it is what every decision in Part 4 was made
from. It remains reusable: paste the whole block into the Supabase SQL editor
and run it once, any time, to get the current shape of the cohort as a single
grid — `seq | section | subject | details`.

It is **read-only**: SELECTs, CTEs, joins, aggregation and JSON construction
only. No DELETE, UPDATE, INSERT, TRUNCATE, ALTER or DROP, and it calls no
function that mutates anything — `analytics_reset_environment` is *not* invoked
here, only in Part 2.

It has been validated against the real migrations on a real Postgres, with
seeded accounts, friendships, a block, a group, invites and analytics in two
environments — so the column and function names are known-good rather than
assumed. (That validation is how the two-argument signature of
`display_name_from_meta` was caught.)

**Nothing secret is emitted.** No tokens, no passwords, no JWTs, no session
rows, no raw auth metadata — the Twitch login and display name come out through
the same helper functions the product itself uses.

```sql
-- ===========================================================================
-- KICKBACK — BETA DAY 0 AUDIT.  READ ONLY.  Run once, copy the whole grid back.
--
-- Contains only SELECTs, CTEs, joins, aggregation and JSON construction.
-- No DELETE / UPDATE / INSERT / TRUNCATE / ALTER / DROP, and it calls no
-- function that mutates anything.
--
-- Emits one grid: seq | section | subject | details(jsonb)
-- ===========================================================================
with
env_counts as (
  select environment, count(*) as events, count(distinct actor_id) as actors,
         min(occurred_at) as first_seen, max(occurred_at) as last_seen
  from public.analytics_events group by environment
),
-- Per-actor event split, which is what decides whether the private_beta reset
-- would take an analytics_actors row (and its is_internal flag) with it.
actor_events as (
  select u.id as user_id,
         count(e.id) filter (where e.environment = 'private_beta')  as beta_events,
         count(e.id) filter (where e.environment <> 'private_beta') as other_events,
         count(e.id) as total_events
  from public.users u
  left join public.analytics_events e on e.actor_id = u.id
  group by u.id
),
person as (
  select u.id,
         u.display_name,
         u.created_at as kickback_created_at,
         ca.platform_login  as twitch_login,
         au.created_at      as auth_created_at,
         au.last_sign_in_at,
         public.login_from_meta(au.raw_user_meta_data) as meta_login,
         public.display_name_from_meta(
           au.raw_user_meta_data,
           public.login_from_meta(au.raw_user_meta_data)
         ) as meta_display_name,
         a.is_internal,
         a.environments as analytics_environments,
         coalesce(ae.beta_events, 0)  as beta_events,
         coalesce(ae.other_events, 0) as other_events,
         coalesce(ae.total_events, 0) as total_events,
         (select count(*) from public.friendships f     where f.user_id  = u.id) as friends,
         (select count(*) from public.friend_requests r where (r.from_user = u.id or r.to_user = u.id)
                                                          and r.status = 'pending')          as pending_requests,
         (select count(*) from public.blocks b          where b.blocker_id = u.id)           as blocks_made,
         (select count(*) from public.blocks b          where b.blocked_id = u.id)           as blocked_by,
         (select count(*) from public.group_members gm  where gm.user_id = u.id)             as groups_joined,
         (select count(*) from public.group_messages gmsg where gmsg.user_id = u.id)         as group_messages,
         (select count(*) from public.feedback fb       where fb.user_id = u.id)             as feedback_sent,
         (select presence_visibility from public.user_preferences p where p.user_id = u.id)  as presence_visibility
  from public.users u
  left join auth.users au on au.id = u.id
  left join public.connected_accounts ca on ca.user_id = u.id and ca.platform = 'twitch'
  left join public.analytics_actors a on a.user_id = u.id
  left join actor_events ae on ae.user_id = u.id
),
-- Auth users with no public.users row are orphans worth seeing.
orphan_auth as (
  select au.id, au.created_at, au.last_sign_in_at,
         public.login_from_meta(au.raw_user_meta_data) as meta_login
  from auth.users au
  left join public.users u on u.id = au.id
  where u.id is null
)

-- ------------------------------------------------------------- 1. SUMMARY
select 100 as seq, 'SUMMARY' as section, 'context' as subject,
       jsonb_build_object(
         'now', now(),
         'analytics_schema_version', public.analytics_schema_version()
       ) as details
union all
select 110, 'SUMMARY', 'row_counts',
       jsonb_build_object(
         'analytics_events',      (select count(*) from public.analytics_events),
         'analytics_actors',      (select count(*) from public.analytics_actors),
         'analytics_event_names', (select count(*) from public.analytics_event_names),
         'analytics_environments',(select count(*) from public.analytics_environments),
         'feedback',              (select count(*) from public.feedback),
         'presence',              (select count(*) from public.presence),
         'presence_rate',         (select count(*) from public.presence_rate),
         'rate_limits',           (select count(*) from public.rate_limits),
         'room_messages',         (select count(*) from public.room_messages),
         'together_reactions',    (select count(*) from public.together_reactions),
         'users',                 (select count(*) from public.users),
         'auth_users',            (select count(*) from auth.users),
         'connected_accounts',    (select count(*) from public.connected_accounts),
         'user_preferences',      (select count(*) from public.user_preferences),
         'friendships',           (select count(*) from public.friendships),
         'friend_requests',       (select count(*) from public.friend_requests),
         'blocks',                (select count(*) from public.blocks),
         'groups',                (select count(*) from public.groups),
         'group_members',         (select count(*) from public.group_members),
         'group_invites',         (select count(*) from public.group_invites),
         'group_messages',        (select count(*) from public.group_messages),
         'twitch_metadata_cache', (select count(*) from public.twitch_metadata_cache)
       )
union all
select 120, 'SUMMARY', 'analytics_by_environment: ' || environment,
       jsonb_build_object('events', events, 'actors', actors,
                          'first_seen', first_seen, 'last_seen', last_seen)
from env_counts
union all
select 130, 'SUMMARY', 'registered_environments',
       jsonb_build_object('names', (select jsonb_agg(name order by name)
                                    from public.analytics_environments))

-- ---------------------------------------------------------- 2. AUTH USERS
union all
select 200, 'AUTH USERS',
       coalesce(twitch_login, meta_login, display_name, id::text),
       jsonb_build_object(
         'user_id', id,
         'display_name', display_name,
         'twitch_login', twitch_login,
         'meta_login', meta_login,
         'meta_display_name', meta_display_name,
         'auth_created_at', auth_created_at,
         'kickback_created_at', kickback_created_at,
         'last_sign_in_at', last_sign_in_at,
         'friends', friends,
         'pending_requests', pending_requests,
         'blocks_made', blocks_made,
         'blocked_by', blocked_by,
         'groups_joined', groups_joined,
         'group_messages', group_messages,
         'feedback_sent', feedback_sent,
         'presence_visibility', presence_visibility,
         'analytics_events_total', total_events,
         'analytics_events_private_beta', beta_events,
         'analytics_events_other_env', other_events,
         'is_internal', is_internal,
         'analytics_environments', analytics_environments
       )
from person
union all
select 210, 'AUTH USERS', 'ORPHAN auth user (no public.users row): ' || coalesce(meta_login, id::text),
       jsonb_build_object('user_id', id, 'created_at', created_at,
                          'last_sign_in_at', last_sign_in_at, 'meta_login', meta_login)
from orphan_auth

-- ------------------------------------------------------- 3. RELATIONSHIPS
union all
-- One row per pair. Friendships are stored as two rows, so this collapses them
-- and reports whether the reciprocal row is actually there - a missing one is
-- corruption worth seeing, not a friendship.
select 300, 'RELATIONSHIPS',
       'friendship: ' || a.display_name || ' <-> ' || b.display_name,
       jsonb_build_object('user_a', f.user_id, 'user_b', f.friend_id,
                          'login_a', ca.platform_login, 'login_b', cb.platform_login,
                          'created_at', f.created_at,
                          'reciprocal_row_exists',
                            exists (select 1 from public.friendships r
                                     where r.user_id = f.friend_id and r.friend_id = f.user_id))
from public.friendships f
join public.users a on a.id = f.user_id
join public.users b on b.id = f.friend_id
left join public.connected_accounts ca on ca.user_id = a.id and ca.platform = 'twitch'
left join public.connected_accounts cb on cb.user_id = b.id and cb.platform = 'twitch'
where f.user_id < f.friend_id
union all
select 310, 'RELATIONSHIPS',
       'request(' || r.status || '): ' || a.display_name || ' -> ' || b.display_name,
       jsonb_build_object('id', r.id, 'from_user', r.from_user, 'to_user', r.to_user,
                          'from_login', ca.platform_login, 'to_login', cb.platform_login,
                          'status', r.status, 'created_at', r.created_at,
                          'responded_at', r.responded_at)
from public.friend_requests r
join public.users a on a.id = r.from_user
join public.users b on b.id = r.to_user
left join public.connected_accounts ca on ca.user_id = a.id and ca.platform = 'twitch'
left join public.connected_accounts cb on cb.user_id = b.id and cb.platform = 'twitch'

-- ---------------------------------------------------------------- 4. BLOCKS
union all
select 400, 'BLOCKS',
       'block: ' || a.display_name || ' -> ' || b.display_name,
       jsonb_build_object('blocker_id', bl.blocker_id, 'blocked_id', bl.blocked_id,
                          'blocker_login', ca.platform_login, 'blocked_login', cb.platform_login,
                          'created_at', bl.created_at)
from public.blocks bl
join public.users a on a.id = bl.blocker_id
join public.users b on b.id = bl.blocked_id
left join public.connected_accounts ca on ca.user_id = a.id and ca.platform = 'twitch'
left join public.connected_accounts cb on cb.user_id = b.id and cb.platform = 'twitch'

-- ---------------------------------------------------------------- 5. GROUPS
union all
select 500, 'GROUPS', 'group: ' || g.name,
       jsonb_build_object(
         'group_id', g.id, 'name', g.name, 'created_at', g.created_at,
         'owner_id', g.owner_id, 'owner', o.display_name,
         'member_count',  (select count(*) from public.group_members m  where m.group_id = g.id),
         'invite_count',  (select count(*) from public.group_invites i  where i.group_id = g.id and i.status = 'pending'),
         'message_count', (select count(*) from public.group_messages x where x.group_id = g.id),
         'members', (select jsonb_agg(u2.display_name order by u2.display_name)
                     from public.group_members m2
                     join public.users u2 on u2.id = m2.user_id
                     where m2.group_id = g.id),
         'grants_presence_visibility_between_members', true
       )
from public.groups g
join public.users o on o.id = g.owner_id

-- -------------------------------------------------------- 6. GROUP MEMBERS
union all
select 600, 'GROUP MEMBERS', g.name || ': ' || u.display_name,
       jsonb_build_object('group_id', m.group_id, 'group_name', g.name,
                          'user_id', m.user_id, 'login', ca.platform_login,
                          'role', m.role, 'joined_at', m.joined_at)
from public.group_members m
join public.groups g on g.id = m.group_id
join public.users u on u.id = m.user_id
left join public.connected_accounts ca on ca.user_id = u.id and ca.platform = 'twitch'

-- -------------------------------------------------------- 7. GROUP INVITES
union all
select 700, 'GROUP INVITES',
       g.name || ' (' || i.status || '): ' || a.display_name || ' -> ' || b.display_name,
       jsonb_build_object('id', i.id, 'group_id', i.group_id, 'group_name', g.name,
                          'from_user', i.from_user, 'to_user', i.to_user,
                          'status', i.status, 'created_at', i.created_at)
from public.group_invites i
join public.groups g on g.id = i.group_id
join public.users a on a.id = i.from_user
join public.users b on b.id = i.to_user

-- -------------------------------------------- 8. ANALYTICS / INTERNAL STATUS
union all
select 800, 'ANALYTICS / INTERNAL STATUS',
       'is_internal: ' || coalesce(p.twitch_login, p.display_name, p.id::text),
       jsonb_build_object('user_id', p.id, 'display_name', p.display_name,
                          'twitch_login', p.twitch_login,
                          'is_internal', p.is_internal,
                          'total_events', p.total_events)
from person p
where p.is_internal is true
union all
-- The key question: does resetting private_beta delete this actor row, taking
-- is_internal with it? True when the actor has no events outside private_beta.
select 810, 'ANALYTICS / INTERNAL STATUS',
       'reset_impact: ' || coalesce(p.twitch_login, p.display_name, p.id::text),
       jsonb_build_object(
         'user_id', p.id,
         'is_internal', p.is_internal,
         'private_beta_events', p.beta_events,
         'events_in_other_environments', p.other_events,
         'actor_row_would_be_deleted_by_reset', (p.other_events = 0),
         'is_internal_flag_would_be_lost', (p.other_events = 0 and p.is_internal is true)
       )
from person p
where p.is_internal is not null
union all
select 820, 'ANALYTICS / INTERNAL STATUS', 'reset_preview',
       jsonb_build_object(
         'private_beta_events_to_delete',
           (select count(*) from public.analytics_events where environment = 'private_beta'),
         'actor_rows_that_would_be_deleted',
           (select count(*) from public.analytics_actors a
             where not exists (select 1 from public.analytics_events e
                                where e.actor_id = a.user_id
                                  and e.environment <> 'private_beta')),
         'internal_flags_at_risk',
           (select count(*) from public.analytics_actors a
             where a.is_internal
               and not exists (select 1 from public.analytics_events e
                                where e.actor_id = a.user_id
                                  and e.environment <> 'private_beta'))
       )

order by seq, subject;
```

### What the grid contains

| Section | Rows |
| --- | --- |
| `SUMMARY` | `now()`, analytics schema version, row counts for all 22 tables, analytics split by environment, the registered environment names |
| `AUTH USERS` | One row per account: user id, Twitch login, display name, auth created / last sign-in, friends, pending requests, blocks made and received, groups joined, group messages, feedback sent, presence visibility, event counts split private_beta vs other, and `is_internal`. Plus any auth user with no `public.users` row |
| `RELATIONSHIPS` | One row per friendship **pair**, with a reciprocal-row check so a half-written friendship shows up as corruption rather than as a relationship. Then every friend request with its status |
| `BLOCKS` | Every block, both parties named |
| `GROUPS` | Each group with its owner, the member names inline, and member / pending-invite / message counts |
| `GROUP MEMBERS` | Every membership, with role |
| `GROUP INVITES` | Every invite, with status |
| `ANALYTICS / INTERNAL STATUS` | Who is `is_internal`; per actor whether the private_beta reset would delete their `analytics_actors` row and take the flag with it; and a `reset_preview` counting events to delete, actor rows that would go, and internal flags at risk |

## Part 2 — The cleanup, as it was run

One script, run once in the Supabase SQL editor. It is reproduced verbatim
because the verification below only means anything next to the statements that
produced it.

Two properties are worth stating before the SQL, because they are the reason it
looks the way it does.

**It is atomic.** Every mutation lives inside a single `DO` block, so a failure
at any point rolls back everything before it. A half-reset — social graph gone,
analytics still there, or the reverse — is not a reachable state. This was
tested by injecting a failure at the last statement of the block and confirming
that every earlier delete rolled back.

**It verifies against a snapshot, not against expectations.** The first thing it
does is record the counts of everything being *preserved*. The grid at the end
compares before against after, so "`twitch_metadata_cache` survived" is a
measurement rather than an assertion.

```sql
-- ============================================================================
-- KICKBACK - PRIVATE BETA DAY 0
-- Cleanup, then verification. Paste the whole thing and run it once.
-- ============================================================================

drop table if exists _kb_before;
drop table if exists _kb_reset;

-- ============================================================================
-- CLEANUP - one atomic block. Any failure anywhere rolls the whole thing back,
-- so a half-reset is not a reachable state.
-- ============================================================================
do $KB$
begin

  -- 0. Preconditions. Stop before touching anything unless each of the three
  --    preserved identities resolves to exactly one account.
  declare
    v_keep constant text[] := array['anoterostv', 'wtfchuck27', 'ohjuliego'];
    v_login text;
    v_n int;
  begin
    foreach v_login in array v_keep loop
      select count(*) into v_n
      from public.connected_accounts
      where platform = 'twitch' and platform_login = v_login;
      if v_n <> 1 then
        raise exception
          'kickback day 0: twitch login % resolved to % accounts, expected exactly 1',
          v_login, v_n using errcode = '22023';
      end if;
    end loop;
  end;

  -- 1. Day 0 stamp, plus a snapshot of everything being PRESERVED so the
  --    verification can prove it survived rather than assert it.
  --    now() is transaction start, so the whole script shares one instant.
  create temp table _kb_before as
  select
    now()                                                          as day_zero,
    (select count(*) from auth.users)                              as auth_users,
    (select count(*) from public.users)                            as public_users,
    (select count(*) from public.connected_accounts)               as connected_accounts,
    (select count(*) from public.user_preferences)                 as user_preferences,
    (select count(*) from public.twitch_metadata_cache)            as metadata_cache,
    (select count(*) from public.analytics_environments)           as environments,
    (select count(*) from public.analytics_event_names)            as event_names,
    (select count(*) from public.analytics_events
       where environment = 'private_beta')                         as beta_events,
    (select count(*) from public.analytics_events
       where environment = 'development')                          as dev_events,
    (select count(*) from public.analytics_events
       where environment not in ('private_beta', 'development'))   as other_events;

  -- 2. Social graph. Children before parents. No user row is touched.
  delete from public.group_messages;
  delete from public.group_invites;
  delete from public.group_members;
  delete from public.groups;

  delete from public.friend_requests;
  delete from public.friendships;
  delete from public.blocks;

  delete from public.room_messages;
  delete from public.together_reactions;

  delete from public.feedback;

  -- Rate-limit ledgers are pure bookkeeping; the SECURITY DEFINER functions
  -- re-create a row on the next write.
  delete from public.presence_rate;
  delete from public.rate_limits;

  -- 3. Presence is NOT deleted. sync_kickback_identity() guarantees one row per
  --    user at sign-up, so the correct clean baseline is one row per user that
  --    is offline and carries no activity - which is exactly what the
  --    presence_offline_has_no_activity constraint means by "offline".
  update public.presence
     set status       = 'offline',
         platform     = null,
         channel      = null,
         last_seen_at = now(),
         updated_at   = now()
   where status <> 'offline' or platform is not null or channel is not null;

  insert into public.presence (user_id, status)
  select u.id, 'offline' from public.users u
  on conflict (user_id) do nothing;

  -- 4. Analytics: the supported reset, private_beta ONLY. development untouched.
  --    Captured so the verification can report what it actually removed.
  create temp table _kb_reset as
  select * from public.analytics_reset_environment('private_beta', 'RESET private_beta');

  -- 5. Internal flags. Step 4 deletes actor rows left with no events at all,
  --    so this runs after it and re-creates the row where one is needed.
  insert into public.analytics_actors (user_id, is_internal)
  select ca.user_id, ca.platform_login in ('anoterostv', 'wtfchuck27')
  from public.connected_accounts ca
  where ca.platform = 'twitch'
    and ca.platform_login in ('anoterostv', 'wtfchuck27', 'ohjuliego')
  on conflict (user_id) do update set is_internal = excluded.is_internal;

end
$KB$;

-- ============================================================================
-- VERIFICATION - read-only, one grid.
-- ============================================================================
with
b as (select * from _kb_before),

must_be_empty as (
            select 'blocks'             as name, (select count(*) from public.blocks)             as n
  union all select 'feedback',                   (select count(*) from public.feedback)
  union all select 'friend_requests',            (select count(*) from public.friend_requests)
  union all select 'friendships',                (select count(*) from public.friendships)
  union all select 'group_invites',              (select count(*) from public.group_invites)
  union all select 'group_members',              (select count(*) from public.group_members)
  union all select 'group_messages',             (select count(*) from public.group_messages)
  union all select 'groups',                     (select count(*) from public.groups)
  union all select 'presence_rate',              (select count(*) from public.presence_rate)
  union all select 'rate_limits',                (select count(*) from public.rate_limits)
  union all select 'room_messages',              (select count(*) from public.room_messages)
  union all select 'together_reactions',         (select count(*) from public.together_reactions)
),

preserved as (
            select 'analytics_environments'         as name, b.environments       as before_n,
                   (select count(*) from public.analytics_environments)           as after_n from b
  union all select 'analytics_event_names',                b.event_names,
                   (select count(*) from public.analytics_event_names)                     from b
  union all select 'analytics_events (development)',       b.dev_events,
                   (select count(*) from public.analytics_events
                     where environment = 'development')                                    from b
  union all select 'analytics_events (other envs)',        b.other_events,
                   (select count(*) from public.analytics_events
                     where environment not in ('private_beta', 'development'))             from b
  union all select 'auth.users',                           b.auth_users,
                   (select count(*) from auth.users)                                       from b
  union all select 'connected_accounts',                   b.connected_accounts,
                   (select count(*) from public.connected_accounts)                        from b
  union all select 'public.users',                         b.public_users,
                   (select count(*) from public.users)                                     from b
  union all select 'twitch_metadata_cache',                b.metadata_cache,
                   (select count(*) from public.twitch_metadata_cache)                     from b
  union all select 'user_preferences',                     b.user_preferences,
                   (select count(*) from public.user_preferences)                          from b
),

flags as (
  select ca.platform_login as login,
         ca.platform_login in ('anoterostv', 'wtfchuck27') as want,
         a.is_internal as got
  from public.connected_accounts ca
  left join public.analytics_actors a on a.user_id = ca.user_id
  where ca.platform = 'twitch'
    and ca.platform_login in ('anoterostv', 'wtfchuck27', 'ohjuliego')
),

stray_internal as (
  select count(*) as n
  from public.analytics_actors a
  where a.is_internal
    and not exists (
      select 1 from public.connected_accounts ca
      where ca.user_id = a.user_id and ca.platform = 'twitch'
        and ca.platform_login in ('anoterostv', 'wtfchuck27')
    )
)

select seq, section, item, expected, actual, status from (

  select 100 as seq, 'DAY 0' as section,
         'day_zero - record this in ROADMAP.md' as item,
         'transaction start, UTC' as expected,
         (select day_zero::text from b) as actual,
         'RECORD' as status

  union all
  select 110, 'DAY 0', 'analytics_schema_version', '23',
         public.analytics_schema_version()::text,
         case when public.analytics_schema_version() = 23 then 'PASS' else '*** CHECK ***' end

  union all
  select 200, 'SOCIAL GRAPH - must be empty', name, '0', n::text,
         case when n = 0 then 'PASS' else '*** NOT EMPTY ***' end
  from must_be_empty

  union all
  select 300, 'PRESENCE - offline baseline',
         'rows (one per user, by trigger invariant)',
         (select public_users::text from b),
         (select count(*)::text from public.presence),
         case when (select count(*) from public.presence) = (select count(*) from public.users)
              then 'PASS' else '*** CHECK ***' end
  union all
  select 310, 'PRESENCE - offline baseline', 'rows not offline', '0',
         (select count(*)::text from public.presence where status <> 'offline'),
         case when (select count(*) from public.presence where status <> 'offline') = 0
              then 'PASS' else '*** NOT OFFLINE ***' end
  union all
  select 320, 'PRESENCE - offline baseline', 'rows still carrying platform or channel', '0',
         (select count(*)::text from public.presence
           where platform is not null or channel is not null),
         case when (select count(*) from public.presence
                     where platform is not null or channel is not null) = 0
              then 'PASS' else '*** ACTIVITY LEFT ***' end

  union all
  select 400, 'ANALYTICS', 'private_beta events remaining', '0',
         (select count(*)::text from public.analytics_events where environment = 'private_beta'),
         case when (select count(*) from public.analytics_events
                     where environment = 'private_beta') = 0
              then 'PASS' else '*** NOT RESET ***' end
  union all
  select 410, 'ANALYTICS', 'private_beta events deleted by reset',
         (select beta_events::text from b),
         (select deleted_events::text from _kb_reset),
         case when (select deleted_events from _kb_reset) = (select beta_events from b)
              then 'PASS' else '*** CHECK ***' end
  union all
  select 420, 'ANALYTICS', 'analytics_actors rows deleted by reset',
         'informational', (select deleted_actors::text from _kb_reset), 'INFO'
  union all
  select 430, 'ANALYTICS', 'registered environment names', 'unchanged',
         (select string_agg(name, ', ' order by name) from public.analytics_environments), 'INFO'
  union all
  select 440, 'ANALYTICS', 'actors still listing private_beta in environments[]',
         'cosmetic residue only',
         (select count(*)::text from public.analytics_actors
           where 'private_beta' = any(environments)),
         'INFO'

  union all
  select 500, 'PRESERVED', name, before_n::text, after_n::text,
         case when before_n = after_n then 'PASS' else '*** CHANGED ***' end
  from preserved

  union all
  select 600, 'INTERNAL FLAGS', login, want::text, coalesce(got::text, 'NO ACTOR ROW'),
         case when got is not distinct from want then 'PASS' else '*** CHECK ***' end
  from flags
  union all
  select 610, 'INTERNAL FLAGS', 'any OTHER actor marked internal', '0',
         (select n::text from stray_internal),
         case when (select n from stray_internal) = 0
              then 'PASS' else '*** UNEXPECTED INTERNAL ***' end

) v
order by seq, item;
```

### Why presence was updated rather than deleted

An earlier draft of this document deleted `public.presence` outright. **That was
wrong**, and the audit is what caught it.

`sync_kickback_identity()` (migration `0004_auth_bootstrap.sql`) inserts a
presence row for every user the moment their auth account is created. Zero rows
is therefore not a clean state — it is a state the schema does not otherwise
produce.

The schema also already defines what clean means. The
`presence_offline_has_no_activity` constraint says an offline row cannot carry a
platform or a channel, so that "invisible" is structurally indistinguishable
from "genuinely offline". The correct Day 0 baseline is the one a fresh sign-up
produces: **one row per user, `status = 'offline'`, platform and channel null.**
The script sets exactly that, and back-fills any missing row.

---

## Part 3 — What the run verified

Every check returned `PASS`. Recorded here so a later question about the
baseline has an answer that does not depend on anyone's memory.

| Check | Result |
| --- | --- |
| `analytics_schema_version` | **23** |
| `private_beta` events remaining | **0** |
| `private_beta` events deleted | **462** |
| `development` events preserved | **93** |
| auth users preserved | **3** |
| `public.users` preserved | **3** |
| `connected_accounts` preserved | **3** |
| `user_preferences` preserved | **3** |
| `twitch_metadata_cache` preserved | **16** |
| `feedback` | 0 |
| `friendships` | 0 |
| `friend_requests` | 0 |
| `blocks` | 0 |
| `groups` / `group_members` / `group_invites` / `group_messages` | 0 |
| `room_messages` | 0 |
| `together_reactions` | 0 |
| `presence_rate` | 0 |
| `rate_limits` | 0 |
| `presence` | **3 rows, all offline, no platform or channel** |
| `anoterostv` | `is_internal = true` |
| `wtfchuck27` | `is_internal = true` |
| `ohjuliego` | `is_internal = false` |
| any other internal actor | none |

Nothing was left in an unexplained state.

---

## Part 4 — The owner decisions behind it

The database cannot tell a disposable test identity from a real person, so these
were decided by hand and are recorded rather than inferred.

| Account | Decision |
| --- | --- |
| `anoterostv` | Preserve. Owner / development account — **internal**, excluded from beta reporting |
| `wtfchuck27` | Preserve. Owner / development account — **internal**, excluded from beta reporting |
| `ohjuliego` | Preserve. **Real beta tester** — not internal, counted in the cohort |

**No account was deleted.** All three auth identities came through untouched.

**The whole social graph was cleared** — friendships, requests including accepted
history, groups, memberships, invites, messages, blocks. The reasoning: the real
beta should begin from a graph that testers build themselves. Development
friendships between owner accounts would have shown up in every density and
gravity measurement as if they were organic, and there is no way to subtract
them later.

`feedback` was cleared even though the audit found none, so that the baseline is
explicitly zero rather than incidentally zero.

---

## Part 5 — Deliberately not done

**`twitch_metadata_cache` (16 rows) was preserved.** It holds public Twitch
channel metadata — nothing about any person — keyed by login with its own
freshness rules. Clearing it would only have forced needless refetching on Day 1.

**`user_preferences` (3 rows) was preserved.** These are per-account settings:
presence visibility and the notification toggle. They are not social state and
not test residue, and wiping them would have silently reset three people's
privacy choices.

**Two `analytics_actors` rows still list `private_beta` in `environments[]`.**
This is expected. `analytics_reset_environment` deletes actor rows left with no
events at all, but does not rewrite the lifetime "has ever sent from" array on
actors that survive because they also have `development` events. It is a
cosmetic historical marker on two rows; it affects no count, no funnel and no
report, because every analysis filters `analytics_events.environment`, not this
array. **It is recorded as residue and is not to be modified.**

---

## If a tester asks for their account to be deleted

Not Day 0 procedure — kept here because this is where the cascade behaviour is
documented, and account deletion is a manual request (see
[PRIVACY.md](PRIVACY.md)).

Every table in this schema cascades from `public.users`, which cascades from
`auth.users`, so one statement removes the profile, connected account, presence,
preferences, friendships, requests, blocks, group memberships, group messages
and analytics actor row together.

```sql
-- Deletes the account and everything attached to it. Irreversible.
delete from auth.users where id = '<ACCOUNT-UUID>';
```

Their `analytics_events` rows go with it, via `actor_id`. That is correct — the
events carry no personal content, but they are attributable, so deletion means
deletion.

---

## Re-auditing later

Part 1 is read-only and safe to run at any time. Run it whenever you want the
current shape of the cohort, and compare against Part 3 above.

From the repository, three checks prove the schema, security posture and auth
configuration are still what they were:

```bash
npm run verify:analytics   # schema present, and still revoked from clients
npm run verify:groups      # group backend present
npm run verify:config      # publishable key works, Twitch auth enabled
```

**None of them can see row counts** — that is what Part 1 is for.

---

## After Day 0

Avoid generating analytics traffic yourself. Every `private_beta` event from
this point is meant to be a real tester doing a real thing, and a single
afternoon of clicking around your own build is enough to move a percentage in a
cohort of six.

`anoterostv` and `wtfchuck27` are marked `is_internal`, which excludes them from
beta reporting — but that is a filter applied at analysis time, not a mute. The
events are still written.

If you must reproduce a bug against the hosted backend, either do it from a
`development` build — the environment is a build-time constant, so those events
land in a different bucket entirely — or note the time so the events can be
excluded later.
