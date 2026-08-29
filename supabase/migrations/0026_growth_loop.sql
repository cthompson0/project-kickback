-- ===========================================================================
-- 0026 — The growth loop: suggestions, invites, referrals, badges
--
-- Kickback's cold-start problem: "I installed it, how do I get enough friends
-- here for this to be useful?" This migration is the server half of the answer.
--
-- FOUR THINGS, AND ONE RULE THEY ALL SHARE
--
--   suggest_friends()   who you might know, through people you already know
--   invite_codes        a durable shareable link per person
--   referrals           who brought whom, and whether it actually worked
--   badges              a general identity surface, first used for referrals
--
-- The shared rule: THE CLIENT IS NEVER TRUSTED. Every one of these is a
-- SECURITY DEFINER function seeded at auth.uid(); none of them takes a user id
-- from the caller as authority; possession of an invite code confers no
-- privilege whatsoever, and awards are computed from server state rather than
-- reported by a client.
--
-- ADDITIVE ONLY. Nothing is dropped, no column removed, no policy narrowed. A
-- v0.4.1 Store client knows about none of this and is completely unaffected -
-- it never calls these functions, and nothing it does call changed shape. The
-- one existing function touched is apply_destinations, which gains a single
-- guarded UPDATE against a tiny table and returns exactly what it returned
-- before.
-- ===========================================================================

begin;

-- ===========================================================================
-- MUTUAL FRIEND SUGGESTIONS
-- ===========================================================================

/*
 * People you might know, through people you already know.
 *
 * WHY FRIENDS-OF-FRIENDS AND NOTHING ELSE
 *
 * Two hops is the only distance where "mutual friends" is a real explanation a
 * person can act on. Three hops is a stranger with a number attached, and a
 * global directory is a different product. So the walk is exactly one join
 * deep from the caller's own friendships and no further.
 *
 * WHY THE COUNT AND NOT THE NAMES
 *
 * A mutual is somebody the CALLER already knows, so naming them tells the
 * caller nothing new about their own graph - but it does tell them something
 * about the CANDIDATE's graph, and the candidate never agreed to that. "Julie
 * and Mike are friends" is Julie's information as much as Mike's, and neither
 * of them asked to have it published to Chuck.
 *
 * The count carries the social proof that makes a suggestion legible without
 * enumerating anyone's friend list. If that proves too thin in practice it can
 * be widened later with consent; it cannot be narrowed again once shipped.
 *
 * WHAT IS EXCLUDED, AND WHY EACH ONE
 *
 *   the caller             - obviously
 *   existing friends       - nothing to suggest
 *   either-direction block - a block must not be routed around by a suggestion
 *   open requests          - already actionable in Requests; showing them here
 *                            twice is noise, not discovery
 *
 * Deterministic ordering: most mutuals first, then display name, then id. No
 * clock, no randomness - the same graph always produces the same list, which
 * is what makes it testable and what stops the panel reshuffling under a
 * cursor.
 */
create or replace function public.suggest_friends(p_limit int default 12)
returns table (
  user_id      uuid,
  display_name text,
  avatar_url   text,
  twitch_login text,
  mutual_count int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with actor as (select public.require_actor() as id),
  mine as (
    select f.friend_id
      from public.friendships f, actor a
     where f.user_id = a.id
  ),
  candidates as (
    select f2.friend_id as candidate, count(*)::int as mutuals
      from mine m
      join public.friendships f2 on f2.user_id = m.friend_id
      cross join actor a
     where f2.friend_id <> a.id
       -- Not already a friend.
       and not exists (
         select 1 from public.friendships f3
          where f3.user_id = a.id and f3.friend_id = f2.friend_id
       )
       -- A block is not routed around by a suggestion, in either direction.
       and not public.blocked_pair(a.id, f2.friend_id)
       -- Already actionable in Requests; suggesting it again is noise.
       and not exists (
         select 1 from public.friend_requests r
          where r.status = 'pending'
            and ((r.from_user = a.id and r.to_user = f2.friend_id)
              or (r.from_user = f2.friend_id and r.to_user = a.id))
       )
     group by f2.friend_id
  )
  select u.id,
         u.display_name,
         u.avatar_url,
         ca.platform_login,
         c.mutuals
    from candidates c
    join public.users u on u.id = c.candidate
    left join public.connected_accounts ca
           on ca.user_id = u.id and ca.platform = 'twitch'
   order by c.mutuals desc, u.display_name asc, u.id asc
   limit greatest(1, least(coalesce(p_limit, 12), 50));
$$;

revoke all on function public.suggest_friends(int) from public, anon;
grant execute on function public.suggest_friends(int) to authenticated;

-- ===========================================================================
-- INVITES
-- ===========================================================================

/*
 * One durable code per person, rather than a token per invitation.
 *
 * A person shares one link, in a DM, a group chat, wherever - and it keeps
 * working. Per-invitation tokens would mean a new link for every friend and a
 * table that grows with every share, and they buy nothing here: the thing that
 * must be unique is not the LINK, it is the CREDIT, and credit is keyed on the
 * recipient (see referrals).
 *
 * THE CODE IS NOT AN IDENTIFIER AND CARRIES NO PRIVILEGE
 *
 * It is random, not derived from the user id, so it leaks nothing about who
 * issued it and cannot be enumerated from a known account. Holding one lets a
 * signed-in account say "this person invited me" and nothing else: it does not
 * create a friendship, does not grant visibility, does not bypass a block, and
 * does not make anybody visible who was not already. Every authorization in
 * Kickback still runs exactly as it did.
 *
 * 22 characters from a 32-symbol alphabet is ~110 bits. Guessing one is not a
 * threat model; the reason it is random at all is that a predictable code
 * would let somebody attribute themselves to an arbitrary stranger.
 */
create table if not exists public.invite_codes (
  user_id    uuid primary key references public.users (id) on delete cascade,
  code       text not null unique check (code ~ '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{22}$'),
  created_at timestamptz not null default now()
);

alter table public.invite_codes enable row level security;
revoke all on public.invite_codes from anon, authenticated;
-- A person may read their own code and nobody else's. Resolution happens
-- through a SECURITY DEFINER function, never by reading this table.
grant select on public.invite_codes to authenticated;

drop policy if exists invite_codes_own on public.invite_codes;
create policy invite_codes_own on public.invite_codes
  for select to authenticated
  using (user_id = (select auth.uid()));

/*
 * The same alphabet friend codes use: no I, L, O, U, so a code read aloud or
 * copied by hand cannot become a different valid code.
 */
create or replace function public.new_invite_code()
returns text
language sql
volatile
set search_path = public, pg_temp
as $$
  select string_agg(
           substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',
                  1 + floor(random() * 32)::int, 1),
           '')
    from generate_series(1, 22);
$$;

revoke all on function public.new_invite_code() from public, anon, authenticated;

/**
 * The caller's invite code, created on first use.
 *
 * Idempotent: asking twice returns the same code, so a link shared last week
 * keeps working and a person cannot accumulate codes.
 */
create or replace function public.my_invite_code()
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
  v_code  text;
begin
  select code into v_code from public.invite_codes where user_id = v_actor;
  if v_code is not null then
    return v_code;
  end if;

  -- The unique index is the authority; the loop is for the astronomically
  -- unlikely collision rather than for correctness.
  for _ in 1..5 loop
    begin
      insert into public.invite_codes (user_id, code)
      values (v_actor, public.new_invite_code())
      returning code into v_code;
      return v_code;
    exception when unique_violation then
      -- Someone else took the code, or we raced ourselves. Try again.
      select code into v_code from public.invite_codes where user_id = v_actor;
      if v_code is not null then return v_code; end if;
    end;
  end loop;

  raise exception 'kickback: could not allocate an invite code' using errcode = '55000';
end;
$$;

revoke all on function public.my_invite_code() from public, anon;
grant execute on function public.my_invite_code() to authenticated;

-- ===========================================================================
-- REFERRALS
-- ===========================================================================

/*
 * Who brought whom, and whether it actually worked.
 *
 * THE PRIMARY KEY IS THE IDEMPOTENCY.
 *
 * One row per INVITEE, ever. An account can be referred exactly once, by
 * exactly one person, and no amount of reinstalling, re-claiming, signing out
 * and back in, or opening a different friend's link can produce a second row
 * or a second credit. That single constraint removes the whole class of
 * duplicate-credit bugs without any fraud infrastructure.
 *
 * The three timestamps are the state machine. Each is stamped once and never
 * cleared, so the row only ever moves forward.
 */
create table if not exists public.referrals (
  -- One row per invitee. This is the anti-duplicate-credit rule.
  invitee_id    uuid primary key references public.users (id) on delete cascade,
  inviter_id    uuid not null references public.users (id) on delete cascade,
  /** They claimed a valid code. Attribution, not yet credit. */
  attributed_at timestamptz not null default now(),
  /** The intended social connection actually formed. */
  friended_at   timestamptz,
  /** They used the product for its purpose at least once. */
  activated_at  timestamptz,
  /** All three above are true. THIS is a successful referral. */
  succeeded_at  timestamptz,
  constraint referrals_not_self check (invitee_id <> inviter_id)
);

create index if not exists referrals_inviter_idx
  on public.referrals (inviter_id, succeeded_at);

alter table public.referrals enable row level security;
revoke all on public.referrals from anon, authenticated;
grant select on public.referrals to authenticated;

/*
 * A person may see referrals they are part of, and no others. The inviter
 * needs to see their own count; the invitee is entitled to know who is
 * credited with bringing them.
 */
drop policy if exists referrals_own on public.referrals;
create policy referrals_own on public.referrals
  for select to authenticated
  using (inviter_id = (select auth.uid()) or invitee_id = (select auth.uid()));

-- ===========================================================================
-- BADGES
-- ===========================================================================

/*
 * A general identity surface that happens to be used for referrals first.
 *
 * KICKBACK-ISSUED VERSUS TWITCH-ISSUED is in the schema from the start, in
 * `issuer`, because the one thing this must never do is imply that Kickback
 * granted somebody a Twitch badge. Nothing here reads Twitch subscriber or
 * badge identity: that needs OAuth scopes this project does not have, and
 * widening scope is a decision for a human, not a migration. The column exists
 * so that if such data is ever legitimately available it has an honest home.
 */
create table if not exists public.badge_definitions (
  key         text primary key check (key ~ '^[a-z0-9_]{1,40}$'),
  name        text not null check (char_length(name) between 1 and 40),
  description text not null check (char_length(description) between 1 and 160),
  /** A short symbol the client renders. Not a URL, so nothing is fetched. */
  icon        text not null check (char_length(icon) between 1 and 8),
  issuer      text not null default 'kickback' check (issuer in ('kickback', 'twitch')),
  sort_order  int  not null default 0
);

alter table public.badge_definitions enable row level security;
revoke all on public.badge_definitions from anon, authenticated;
grant select on public.badge_definitions to authenticated;

-- Definitions are public knowledge: knowing a badge exists reveals nothing
-- about who holds it.
drop policy if exists badge_definitions_read on public.badge_definitions;
create policy badge_definitions_read on public.badge_definitions
  for select to authenticated using (true);

/*
 * Ownership. The primary key makes awarding idempotent by construction -
 * crossing a threshold twice cannot produce two rows.
 */
create table if not exists public.user_badges (
  user_id    uuid not null references public.users (id) on delete cascade,
  badge_key  text not null references public.badge_definitions (key) on delete cascade,
  awarded_at timestamptz not null default now(),
  /** Why, in a fixed vocabulary. Never free text from a client. */
  reason     text check (reason is null or reason ~ '^[a-z0-9_]{1,40}$'),
  primary key (user_id, badge_key)
);

alter table public.user_badges enable row level security;
revoke all on public.user_badges from anon, authenticated;
grant select on public.user_badges to authenticated;

/*
 * Who may see somebody's badges is exactly who may see their presence: a
 * friend, or somebody they share a group with. Badges are social identity, so
 * they follow the social boundary rather than being world-readable.
 */
drop policy if exists user_badges_read on public.user_badges;
create policy user_badges_read on public.user_badges
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_friend(user_id)
    or public.shares_group_with(user_id)
  );

/*
 * Which earned badge a person chooses to show.
 *
 * On user_preferences rather than a table of its own: it is a preference, it
 * is one value, and the row already exists for every user. Null means "show
 * nothing", which is the default and an ordinary choice rather than an opt-out.
 */
alter table public.user_preferences
  add column if not exists displayed_badge_key text;

/*
 * The only way a badge is ever awarded.
 *
 * SECURITY DEFINER, granted to nobody. A client cannot call this, cannot
 * forge an award, and cannot award to another account - every caller is a
 * server-side function that has already established the fact being rewarded.
 */
create or replace function public.award_badge(p_user uuid, p_key text, p_reason text)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  insert into public.user_badges (user_id, badge_key, reason)
  values (p_user, p_key, p_reason)
  on conflict (user_id, badge_key) do nothing;
$$;

revoke all on function public.award_badge(uuid, text, text) from public, anon, authenticated;

/** The badges this account has earned, newest first. */
create or replace function public.my_badges()
returns table (
  badge_key   text,
  name        text,
  description text,
  icon        text,
  issuer      text,
  awarded_at  timestamptz,
  displayed   boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select b.key, b.name, b.description, b.icon, b.issuer, ub.awarded_at,
         coalesce(up.displayed_badge_key = b.key, false)
    from public.user_badges ub
    join public.badge_definitions b on b.key = ub.badge_key
    left join public.user_preferences up on up.user_id = ub.user_id
   where ub.user_id = public.require_actor()
   order by b.sort_order desc, ub.awarded_at desc;
$$;

revoke all on function public.my_badges() from public, anon;
grant execute on function public.my_badges() to authenticated;

/**
 * Choose which earned badge to display, or null to display none.
 *
 * Authorized by ownership: a badge that was not earned cannot be selected, so
 * a modified client cannot display one it does not hold.
 */
create or replace function public.set_displayed_badge(p_key text)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_actor();
begin
  if p_key is not null and not exists (
    select 1 from public.user_badges
     where user_id = v_actor and badge_key = p_key
  ) then
    raise exception 'kickback: badge not earned' using errcode = '42501';
  end if;

  insert into public.user_preferences (user_id, displayed_badge_key)
  values (v_actor, p_key)
  on conflict (user_id) do update set displayed_badge_key = excluded.displayed_badge_key;

  return p_key;
end;
$$;

revoke all on function public.set_displayed_badge(text) from public, anon;
grant execute on function public.set_displayed_badge(text) to authenticated;

-- ------------------------------------------------------- referral milestones

insert into public.badge_definitions (key, name, description, icon, issuer, sort_order) values
  ('referrer_1',  'Connector',   'Brought a friend to Kickback.',            '🔗', 'kickback', 10),
  ('referrer_5',  'Recruiter',   'Brought five friends to Kickback.',        '🌱', 'kickback', 20),
  ('referrer_10', 'Cultivator',  'Brought ten friends to Kickback.',         '🌿', 'kickback', 30),
  ('referrer_15', 'Ringleader',  'Brought fifteen friends to Kickback.',     '🔥', 'kickback', 40),
  ('referrer_25', 'Kingmaker',   'Brought twenty-five friends to Kickback.', '👑', 'kickback', 50)
on conflict (key) do update
  set name = excluded.name,
      description = excluded.description,
      icon = excluded.icon,
      sort_order = excluded.sort_order;

/*
 * Award every referral milestone the count has reached.
 *
 * Awards ALL crossed thresholds rather than only the newest, so a count that
 * jumps from 0 to 6 - a backfill, a burst, a bug - still leaves the right set
 * of badges. Idempotent through the primary key, so calling it on every
 * settle costs an insert that does nothing.
 */
create or replace function public.award_referral_badges(p_user uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
  v_step  int;
begin
  select count(*) into v_count
    from public.referrals
   where inviter_id = p_user and succeeded_at is not null;

  foreach v_step in array array[1, 5, 10, 15, 25] loop
    if v_count >= v_step then
      perform public.award_badge(p_user, 'referrer_' || v_step, 'referral_milestone');
    end if;
  end loop;
end;
$$;

revoke all on function public.award_referral_badges(uuid) from public, anon, authenticated;

-- ===========================================================================
-- THE SUCCESSFUL-REFERRAL RULE
-- ===========================================================================

/*
 * A referral has succeeded when ALL of these are true:
 *
 *   1. the invitee is a distinct authenticated Kickback account
 *      - enforced by referrals_not_self and by the foreign keys;
 *   2. attribution is valid
 *      - a row exists, created by claim_invite from a real code;
 *   3. the intended social connection exists
 *      - a friendship between inviter and invitee, in the friendships table;
 *   4. the invitee genuinely activated
 *      - they have published a Twitch destination at least once, which means
 *        they installed the extension, signed in, and opened a stream with
 *        Kickback running. That is the smallest act that proves the product
 *        was actually used rather than merely installed.
 *
 * WHY THAT ACTIVATION CRITERION
 *
 * It is a single server-side fact, stamped once, on a path that already
 * exists and already requires authentication. It cannot be triggered by
 * opening a link, by installing, or by signing in and stopping. It cannot be
 * double-counted because it is a timestamp that is only ever set from null.
 *
 * `succeeded_at` is stamped exactly once and never cleared. Un-friending
 * afterwards does not revoke it, and that is deliberate: the referral did
 * happen, and a badge that could be taken away by somebody else's later
 * action would be worse than one that is simply permanent.
 */
create or replace function public.settle_referral(p_invitee uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.referrals%rowtype;
begin
  select * into v_row from public.referrals where invitee_id = p_invitee;
  if not found or v_row.succeeded_at is not null then
    return;
  end if;

  -- Condition 3: the intended connection.
  if v_row.friended_at is null and exists (
    select 1 from public.friendships f
     where f.user_id = v_row.inviter_id and f.friend_id = p_invitee
  ) then
    update public.referrals set friended_at = now() where invitee_id = p_invitee;
    v_row.friended_at := now();
  end if;

  if v_row.friended_at is null or v_row.activated_at is null then
    return;
  end if;

  update public.referrals
     set succeeded_at = now()
   where invitee_id = p_invitee and succeeded_at is null;

  if found then
    perform public.award_referral_badges(v_row.inviter_id);
  end if;
end;
$$;

revoke all on function public.settle_referral(uuid) from public, anon, authenticated;

/**
 * Claim an invite code. Called once, by the NEW account, after it signs in.
 *
 * Returns the outcome rather than raising, because every one of these is an
 * ordinary thing that can happen and none of them is an error the user can
 * act on:
 *
 *   attributed   - recorded
 *   already      - this account was already referred, by anyone. One per
 *                  account, ever - the anti-duplicate-credit rule
 *   self         - it was their own link
 *   blocked      - a block is not routed around by an invite
 *   unknown      - no such code
 *
 * NOTHING IS GRANTED HERE. No friendship is created, no visibility is opened,
 * no authorization changes. The only effect is a row saying who is credited
 * if this account later becomes a real user and a real friend.
 */
create or replace function public.claim_invite(p_code text)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := public.require_actor();
  v_code    text := upper(btrim(coalesce(p_code, '')));
  v_inviter uuid;
begin
  if v_code !~ '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{22}$' then
    return 'unknown';
  end if;

  -- One row per invitee, ever. Checked before anything else so a second claim
  -- is cheap and can never move credit to a different inviter.
  if exists (select 1 from public.referrals where invitee_id = v_actor) then
    return 'already';
  end if;

  select user_id into v_inviter from public.invite_codes where code = v_code;
  if v_inviter is null then
    return 'unknown';
  end if;
  if v_inviter = v_actor then
    return 'self';
  end if;
  if public.blocked_pair(v_inviter, v_actor) then
    return 'blocked';
  end if;

  insert into public.referrals (invitee_id, inviter_id)
  values (v_actor, v_inviter)
  on conflict (invitee_id) do nothing;

  /*
   * They may already have been using Kickback before they claimed.
   *
   * Activation is normally stamped by apply_destinations, but that only fires
   * on a publish AFTER the referral row exists. Somebody who installed, used
   * the product, and only then opened a friend's link would otherwise be
   * permanently un-activated. Their live presence is the same evidence, so it
   * counts here too.
   */
  update public.referrals
     set activated_at = now()
   where invitee_id = v_actor
     and activated_at is null
     and (
       exists (select 1 from public.presence_destinations d where d.user_id = v_actor)
       or exists (select 1 from public.presence p
                   where p.user_id = v_actor and p.channel is not null)
     );

  -- They may already be friends, and may already have used the product.
  perform public.settle_referral(v_actor);
  return 'attributed';
end;
$$;

revoke all on function public.claim_invite(text) from public, anon;
grant execute on function public.claim_invite(text) to authenticated;

/** How the inviter's own progress is read. Their row, their count. */
create or replace function public.my_referral_summary()
returns table (successful int, pending int)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    count(*) filter (where succeeded_at is not null)::int,
    count(*) filter (where succeeded_at is null)::int
  from public.referrals
  where inviter_id = public.require_actor();
$$;

revoke all on function public.my_referral_summary() from public, anon;
grant execute on function public.my_referral_summary() to authenticated;

-- ------------------------------------------- hooking the two remaining edges

/*
 * Condition 4, stamped on the path that already proves it.
 *
 * apply_destinations is where a published set of Twitch channels becomes real,
 * and both report_destinations and the legacy report_presence shim go through
 * it. Guarded on a row existing and the stamp being null, so the hot presence
 * path costs one primary-key lookup against a tiny table and nothing else.
 *
 * Everything else about this function - validation, de-duplication, the cap of
 * three, the ordered return value - is byte-for-byte what 0025 shipped.
 */
create or replace function public.apply_destinations(p_actor uuid, p_channels text[])
returns text[]
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_clean text[] := '{}';
  v_channel text;
begin
  foreach v_channel in array coalesce(p_channels, '{}'::text[]) loop
    v_channel := lower(btrim(coalesce(v_channel, '')));
    continue when v_channel !~ '^[a-z0-9_]{1,25}$';
    continue when v_channel = any(v_clean);
    v_clean := v_clean || v_channel;
    exit when array_length(v_clean, 1) >= 3;
  end loop;

  if array_length(v_clean, 1) > 0 then
    insert into public.presence_destinations (user_id, channel, platform, opened_at, last_active_at)
    select p_actor, c, 'twitch', now(), now()
      from unnest(v_clean) as c
    on conflict (user_id, channel) do update
      set last_active_at = now();

    /*
     * ACTIVATION. They opened a stream with Kickback running, which is the
     * smallest act that proves the product was used rather than installed.
     * Stamped once, from null, and never cleared.
     */
    update public.referrals
       set activated_at = now()
     where invitee_id = p_actor and activated_at is null;

    if found then
      perform public.settle_referral(p_actor);
    end if;
  end if;

  delete from public.presence_destinations d
   where d.user_id = p_actor
     and not (d.channel = any(v_clean));

  return v_clean;
end;
$$;

revoke all on function public.apply_destinations(uuid, text[]) from public, anon, authenticated;

/*
 * Condition 3, stamped where friendships are actually made.
 *
 * create_friendship is the one place a friendship comes into existence - both
 * the request-acceptance path and the mutual-intent shortcut go through it -
 * so settling here catches every route without hunting call sites. Settling is
 * a no-op unless a referral row exists, so ordinary friendships pay one
 * primary-key lookup.
 */
create or replace function public.create_friendship(p_a uuid, p_b uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.friendships (user_id, friend_id)
  values (p_a, p_b), (p_b, p_a)
  on conflict (user_id, friend_id) do nothing;

  -- Either of them may be somebody's invitee.
  perform public.settle_referral(p_a);
  perform public.settle_referral(p_b);
end;
$$;

revoke all on function public.create_friendship(uuid, uuid) from public, anon, authenticated;

-- ===========================================================================
-- ANALYTICS
-- ===========================================================================

insert into public.analytics_event_names (name, description, allowed_properties) values
  ('friend_suggestion_impression',
   'Mutual-friend suggestions were shown. One event per batch, not per row.',
   array['suggestion_count', 'top_mutual_bucket']),
  ('friend_suggestion_add_clicked',
   'Add was pressed on a mutual-friend suggestion.',
   array['mutual_bucket', 'position']),
  ('friend_suggestion_request_created',
   'A friend request was actually created from a suggestion.',
   array['mutual_bucket', 'outcome']),
  ('invite_link_created',
   'The inviter obtained their invite link for the first time this session.',
   array[]::text[]),
  ('invite_link_shared',
   'The inviter copied or shared their invite link.',
   array['method']),
  ('invite_claimed',
   'A newly authenticated account claimed an invite code.',
   array['outcome']),
  ('referral_succeeded',
   'A referral met every condition and was credited to the inviter.',
   array[]::text[]),
  ('badge_awarded',
   'A Kickback-issued badge was earned.',
   array['badge_key']),
  ('badge_displayed',
   'The user chose which earned badge to show.',
   array['badge_key'])
on conflict (name) do update
  set description = excluded.description,
      allowed_properties = excluded.allowed_properties;

/*
 * The applied marker.
 *
 * Newest analytics-touching migration owns it, as always. Nothing reads it but
 * the verifier and the release checklist, and that is exactly what it is for:
 * telling a local expectation apart from a hosted reality.
 */
create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 26; $$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

commit;
