# Private Beta — Day 0 sanitization

Getting the hosted database to a clean measurement baseline before the first
real tester installs Kickback.

**This is not a database reset.** No table is dropped, no migration is re-run,
no schema, RLS, function, view or auth configuration is touched. What is removed
is development residue that would otherwise be counted as beta behaviour.

> **Everything in this document must be run by the owner** in the Supabase SQL
> editor. Nothing here can be performed from the repository: `.env.local` holds
> only the publishable (anon) key, and every table involved is either revoked
> from client roles outright or gated by RLS that requires a real user session.
> The SQL editor runs as the project owner, which is the only role that can see
> or change any of this.

---

## Record the baseline

Run this **in the same session as Part 2**, and write the result into
[ROADMAP.md](ROADMAP.md) and the beta notes. Every later analysis is "since
Day 0", and a guess at the date is a guess at the denominator.

```sql
select now() as private_beta_day_zero;
```

---

## Part 1 — Audit first (read-only, one query)

Paste this whole block into the Supabase SQL editor and run it once. It returns
a single grid — `seq | section | subject | details` — containing everything the
cleanup plan needs. Copy the whole grid back.

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

## Part 2 — The safe clean

Everything here is either a measurement table or state the product regenerates
on its own. **None of it involves a judgement call**, which is why it is
separated from Part 4.

```sql
-- 2a. Analytics: private_beta only, through the supported mechanism.
--
-- Deletes analytics_events for that environment, plus any analytics_actors row
-- left with no events in any environment. Touches nothing else - not the event
-- registry, not the environment registry, not a view, not a function.
-- 'production' would require a second, longer confirmation phrase; we are not
-- touching it.
select * from public.analytics_reset_environment('private_beta', 'RESET private_beta');
```

```sql
-- 2b. Feedback: every submission so far is ours, from development.
--
-- The table, the submit_feedback RPC, feedback_v, the RLS posture and the rate
-- limit are all untouched - this is rows only.
delete from public.feedback;
```

```sql
-- 2c. Ephemeral state.
--
-- presence            one row per user, overwritten by every heartbeat. Clearing
--                     it means nobody appears online until their client next
--                     reports, which is at most one heartbeat away.
-- room_messages       the stream-session chat. Designed to live 30 minutes.
-- together_reactions  designed to live about a minute.
-- presence_rate       ephemeral write counter.
-- rate_limits         ephemeral write counters for every other bucket.
--
-- Combos and unread are NOT here because they are not stored: both are derived
-- client-side from room_messages and together_reactions, so clearing those two
-- clears them.
delete from public.presence;
delete from public.room_messages;
delete from public.together_reactions;
delete from public.presence_rate;
delete from public.rate_limits;
```

**Deliberately not cleared:** `twitch_metadata_cache`. It holds public Twitch
channel metadata, nothing about any person, and it is keyed by login with its
own freshness rules. Clearing it only forces needless refetching on Day 1.

---

## Part 3 — Put the internal marks back

Run **after** 2a, using the `user_id` values from audit query 3. Skip if nothing
was marked internal.

```sql
-- The reset may have removed the actor row that carried is_internal. This
-- re-creates the mark so beta reporting still excludes the developer.
insert into public.analytics_actors (user_id, is_internal)
values ('<YOUR-USER-UUID>', true)
on conflict (user_id) do update set is_internal = true;
```

Verify:

```sql
select user_id, is_internal from public.analytics_actors where is_internal;
```

---

## Part 4 — The social graph (owner decision, no SQL run for you)

**Nothing here is safe to automate.** Whether a friendship is test residue or a
real relationship that should carry into the beta is a question about people,
and the database cannot answer it.

From audit queries 4 and 5, sort every account and relationship into:

| Class | What to do |
| --- | --- |
| Obvious disposable test identity (an account created only to test with, never to be used again) | Candidate for removal — see below |
| A real account that will take part in the beta (yours, a friend's) | **Preserve** |
| A relationship between two real beta accounts | **Preserve** — it is real social density |
| A relationship where either side is a test identity | Remove, or it becomes fake density |
| Anything you cannot classify with confidence | **Preserve, and note it** |

**Removing an account** — only for identities you are certain are disposable.
One statement is enough: every table in this schema cascades from
`public.users`, which cascades from `auth.users`, so this removes their profile,
connected account, presence, preferences, friendships, requests, blocks, group
memberships, group messages and analytics actor row together.

```sql
-- Deletes the account and everything attached to it. Irreversible.
delete from auth.users where id = '<TEST-ACCOUNT-UUID>';
```

**Removing a relationship but keeping both accounts** — friendships are stored
as two rows, so both directions have to go:

```sql
delete from public.friendships
where (user_id = '<A>' and friend_id = '<B>')
   or (user_id = '<B>' and friend_id = '<A>');

-- And any pending request between them, so it cannot resurrect the friendship.
delete from public.friend_requests
where (from_user = '<A>' and to_user = '<B>')
   or (from_user = '<B>' and to_user = '<A>');
```

**Removing a test group** — membership, invites and messages all cascade from
the group:

```sql
delete from public.groups where id = '<GROUP-UUID>';
```

**Test blocks** are worth clearing even between accounts you keep: a forgotten
block silently prevents two real testers from ever seeing each other, and by
design neither of them is told why.

```sql
delete from public.blocks where blocker_id = '<A>' and blocked_id = '<B>';
```

---

## Part 5 — Verify

**Re-run the Part 1 query.** It is the same audit, so the same grid comes back
and you compare it against what you saw before. Expect:

| Where | Expect |
| --- | --- |
| `SUMMARY.context` | `analytics_schema_version` still **23** |
| `SUMMARY.row_counts` | `feedback`, `presence`, `room_messages`, `together_reactions`, `rate_limits`, `presence_rate` all **0** |
| `SUMMARY.row_counts` | `analytics_event_names` **unchanged** (> 30) — the reset must not have touched the registry |
| `SUMMARY.analytics_by_environment` | no `private_beta` row at all |
| `SUMMARY.registered_environments` | still `development, private_beta, production` |
| `AUTH USERS` | exactly the accounts you decided to keep |
| `RELATIONSHIPS` / `BLOCKS` / `GROUPS` | exactly what you decided to keep, and nothing you meant to remove |
| `ANALYTICS / INTERNAL STATUS` | your account still listed as `is_internal` (Part 3 restores it if the reset took it) |

Then, from the repository:

```bash
npm run verify:analytics   # schema present, and still revoked from clients
npm run verify:groups      # group backend present
npm run verify:config      # publishable key works, Twitch auth enabled
```

Those three prove the schema, the security posture and the auth configuration
came through untouched. **None of them can see row counts** — that is what
re-running Part 1 is for.

---
## After Day 0

Avoid generating analytics traffic yourself. Every `private_beta` event from
this point is meant to be a real tester doing a real thing, and a single
afternoon of clicking around your own build is enough to move a percentage in a
cohort of six.

If you must reproduce a bug against the hosted backend, either do it from a
`development` build — the environment is a build-time constant, so those events
land in a different bucket entirely — or note the time so the events can be
excluded later.
