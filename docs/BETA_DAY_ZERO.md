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

## Part 1 — Audit first (read-only, changes nothing)

Run all of this and read it before running Part 2. Nothing below writes.

```sql
-- 1. How much of everything there is.
select 'analytics_events'      as t, count(*) from public.analytics_events
union all select 'analytics_actors',       count(*) from public.analytics_actors
union all select 'feedback',               count(*) from public.feedback
union all select 'presence',               count(*) from public.presence
union all select 'presence_rate',          count(*) from public.presence_rate
union all select 'rate_limits',            count(*) from public.rate_limits
union all select 'room_messages',          count(*) from public.room_messages
union all select 'together_reactions',     count(*) from public.together_reactions
union all select 'users',                  count(*) from public.users
union all select 'connected_accounts',     count(*) from public.connected_accounts
union all select 'friendships',            count(*) from public.friendships
union all select 'friend_requests',        count(*) from public.friend_requests
union all select 'blocks',                 count(*) from public.blocks
union all select 'groups',                 count(*) from public.groups
union all select 'group_members',          count(*) from public.group_members
union all select 'group_invites',          count(*) from public.group_invites
union all select 'group_messages',         count(*) from public.group_messages
union all select 'user_preferences',       count(*) from public.user_preferences
union all select 'twitch_metadata_cache',  count(*) from public.twitch_metadata_cache
union all select 'auth.users',             count(*) from auth.users
order by 1;
```

```sql
-- 2. Analytics, split by environment. This is what Part 2 clears.
select environment,
       count(*)                 as events,
       count(distinct actor_id) as actors,
       min(occurred_at)         as first_seen,
       max(occurred_at)         as last_seen
from public.analytics_events
group by environment
order by environment;
```

```sql
-- 3. Which actors are marked internal.
--
-- IMPORTANT: analytics_reset_environment deletes actor rows that end up with no
-- events in ANY environment - and the is_internal flag lives on that row. If an
-- account only ever sent private_beta events, the reset removes the flag too.
-- Copy this output; Part 3 puts it back.
select a.user_id, u.display_name, a.is_internal, a.environments,
       a.first_seen_at, a.last_seen_at
from public.analytics_actors a
join public.users u on u.id = a.user_id
order by a.is_internal desc, a.first_seen_at;
```

```sql
-- 4. Every account, with its Twitch identity and how much it has done.
--    This is the table you use to decide what is test residue.
select u.id,
       u.display_name,
       ca.platform_login                as twitch_login,
       au.created_at                    as account_created,
       au.last_sign_in_at,
       (select count(*) from public.friendships f    where f.user_id = u.id) as friends,
       (select count(*) from public.group_members gm where gm.user_id = u.id) as groups,
       (select count(*) from public.analytics_events e where e.actor_id = u.id) as events
from public.users u
left join public.connected_accounts ca on ca.user_id = u.id and ca.platform = 'twitch'
left join auth.users au on au.id = u.id
order by au.created_at;
```

```sql
-- 5. The social graph, in full. Small enough to read row by row.
select 'friendship' as kind, a.display_name as one, b.display_name as two, null as detail
from public.friendships f
join public.users a on a.id = f.user_id
join public.users b on b.id = f.friend_id
union all
select 'request', a.display_name, b.display_name, r.status
from public.friend_requests r
join public.users a on a.id = r.from_user
join public.users b on b.id = r.to_user
union all
select 'block', a.display_name, b.display_name, null
from public.blocks bl
join public.users a on a.id = bl.blocker_id
join public.users b on b.id = bl.blocked_id
union all
select 'group', g.name, u.display_name, m.role
from public.group_members m
join public.groups g on g.id = m.group_id
join public.users u on u.id = m.user_id
order by kind, one, two;
```

**Read the result of query 5 carefully.** A leftover development friendship or
a shared development group is the single most damaging kind of residue here: it
inflates social density, and Social Gravity's whole measurement is density.
A shared group is worse than it looks — `shares_group_with` grants presence
visibility, so two accounts in a stale test group can see each other even with no
friendship at all.

---

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

```sql
-- Schema and migrations untouched.
select public.analytics_schema_version() as should_be_23;

-- Registries intact - the reset must not have touched these.
select count(*) as event_names from public.analytics_event_names;   -- expect > 30
select name from public.analytics_environments order by name;       -- development, private_beta, production

-- Baselines are clean.
select count(*) as private_beta_events from public.analytics_events where environment = 'private_beta';  -- expect 0
select count(*) as feedback_rows       from public.feedback;         -- expect 0
select count(*) as presence_rows       from public.presence;         -- expect 0
select count(*) as room_messages       from public.room_messages;    -- expect 0
select count(*) as reactions           from public.together_reactions; -- expect 0
select count(*) as rate_limit_rows     from public.rate_limits;      -- expect 0
select count(*) as presence_rate_rows  from public.presence_rate;    -- expect 0

-- What survived, so it is on the record.
select count(*) as users from public.users;
select count(*) as friendships from public.friendships;
select count(*) as groups from public.groups;
```

Then, from the repository:

```bash
npm run verify:analytics   # schema present, and still revoked from clients
npm run verify:groups      # group backend present
npm run verify:config      # publishable key works, Twitch auth enabled
```

Those three prove the schema, the security posture and the auth configuration
came through the clean untouched. **None of them can see row counts** — that is
what Part 5's SQL is for.

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
