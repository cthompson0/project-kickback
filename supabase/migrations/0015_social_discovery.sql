-- Kickback — 0015: social discovery semantics
--
-- Two-account testing found a semantics bug that the numbers hid.
--
-- A was watching summit1g. B joined. Both were Watching Together. A left; B
-- kept watching alone for forty minutes and then left. B's shared watch was
-- recorded with the RIGHT duration - but stamped with the moment B finally
-- navigated away, forty minutes after co-viewing had actually stopped, and
-- labelled `left_channel` when what really ended it was running out of people.
--
-- The cause is that a remote friend leaving is not something we are told. It is
-- something we work out later, when presence stops arriving - and if no
-- presence traffic arrives at all, we may not work it out until the user
-- themselves moves. Detection time and event time are different things, and
-- treating them as one made every "when did co-viewing stop" answer wrong by
-- however slow we happened to be.
--
-- This migration is the database half of the fix:
--
--   1. `watching_together_ended` gains `detection_delay_ms`. The event is now
--      recorded at the moment co-viewing actually stopped, so the lag has to
--      be carried as its own fact rather than being readable from the
--      timestamp - otherwise it would simply be lost.
--
--   2. `post_social_retention_ended` is new: the user stayed on a socially
--      attributed destination after the last person they were watching with
--      had gone, and has now left it too. There is deliberately no matching
--      start event - the interval begins exactly where the shared watch's
--      effective end is, and a second event saying so would be a second
--      chance to disagree with it.
--
--   3. `opportunity_key` is registered on `join_clicked` and
--      `gravity_cluster_impression`, and is not set by anything yet. A friend
--      row is one person and needs no key; a Social Gravity cluster is a thing
--      several people act on separately, and "how many viewers did ONE
--      gathering produce" needs them to agree on what one gathering was.
--
--   4. The accepted client clock is tightened on the FUTURE side only.
--
-- Additive and idempotent: contract rows are upserted, one function is
-- replaced in place. No table, column, policy or grant changes at all.

begin;

-- ------------------------------------------------------- the event contract
--
-- Upserted, exactly as 0013 seeds it. 0013 still lists the old shape for
-- watching_together_ended and will keep resetting it on every bundle run; this
-- runs afterwards and puts it right, which is why the ordering of the two is
-- part of the contract rather than an accident. The bundle tests apply the
-- whole thing three times over to prove it.

insert into public.analytics_event_names (name, description, allowed_properties) values
  ('watching_together_ended',
   'Co-viewing stopped. Recorded at the moment it actually stopped, which can be well before it was detected.',
   array['other_count_peak', 'duration_ms', 'end_reason', 'detection_delay_ms']),

  ('post_social_retention_ended',
   'The user stayed on the destination after the last co-viewer left, and has now left it too. The interval starts at watching_together_ended''s effective time.',
   array['duration_ms', 'from_join', 'end_reason']),

  ('join_clicked',
   'A JOIN control was clicked. Carries the attribution that arrival is matched against.',
   array['social_count', 'already_on_twitch', 'already_on_destination', 'navigated',
         'opportunity_key']),

  ('gravity_cluster_impression',
   'Reserved for Social Gravity. Registered now so the next checkpoint adds no plumbing.',
   array['friend_count', 'rank', 'visible_clusters', 'opportunity_key'])
on conflict (name) do update
  set description        = excluded.description,
      allowed_properties = excluded.allowed_properties;

-- --------------------------------------------------------- the client clock
--
-- Identical to 0013 in every other respect. The only change is the window.
--
-- WHY THE TWO SIDES ARE NOT SYMMETRIC
--
-- The past side stays generous, because legitimate events now genuinely arrive
-- late: a shared watch that ended when the friends left is emitted when the
-- user finally moves, which can be hours. Refusing those would throw away the
-- very measurement this checkpoint exists to get right.
--
-- The future side does not need to be generous at all. Nothing that has
-- already happened happens later than now, so the only thing a future
-- timestamp can be is a wrong clock or a hostile one. Five minutes covers a
-- machine whose clock is a little fast; beyond that the server's clock is
-- used instead. `received_at` is untouched either way, so the substitution is
-- always visible rather than silent.
--
-- This does not weaken the trust boundary: the client was already able to
-- choose its own occurred_at within the window, and that is what makes an
-- effective-time event possible at all. What it cannot do is park events in
-- 2077 and poison every time series.

create or replace function public.analytics_track(p_events jsonb)
returns int
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := public.require_actor();
  v_event    jsonb;
  v_name     text;
  v_env      text;
  v_allowed  text[];
  v_occurred timestamptz;
  v_channel  text;
  v_source   text;
  v_version  text;
  v_kept     int := 0;
  v_seen     int := 0;
  v_envs     text[] := '{}';
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    return 0;
  end if;

  if not public.consume_rate_budget_n(
       'analytics',
       least(jsonb_array_length(p_events), 50),
       600,
       interval '5 minutes'
     ) then
    return 0;
  end if;

  for v_event in select * from jsonb_array_elements(p_events) loop
    v_seen := v_seen + 1;
    exit when v_seen > 50;

    continue when jsonb_typeof(v_event) <> 'object';

    v_name := v_event ->> 'event_name';
    v_env  := v_event ->> 'environment';

    select aen.allowed_properties into v_allowed
    from public.analytics_event_names aen
    where aen.name = v_name;
    continue when v_allowed is null;

    continue when not exists (
      select 1 from public.analytics_environments ae where ae.name = v_env
    );

    begin
      v_occurred := (v_event ->> 'occurred_at')::timestamptz;
    exception when others then
      v_occurred := null;
    end;
    if v_occurred is null
       -- Nothing that has happened happens in the future. Clock skew only.
       or v_occurred > now() + interval '5 minutes'
       -- Late arrivals are real and expected; see the note above.
       or v_occurred < now() - interval '1 day' then
      v_occurred := now();
    end if;

    v_channel := nullif(lower(btrim(coalesce(v_event ->> 'destination_channel', ''))), '');
    if v_channel is not null and v_channel !~ '^[a-z0-9_]{1,25}$' then
      v_channel := null;
    end if;

    v_source  := left(nullif(btrim(coalesce(v_event ->> 'source', '')), ''), 40);
    v_version := left(nullif(btrim(coalesce(v_event ->> 'app_version', '')), ''), 20);

    insert into public.analytics_events (
      actor_id, environment, event_name, session_id,
      occurred_at, app_version, source, destination_channel, attribution_id, properties
    )
    values (
      v_actor,
      v_env,
      v_name,
      case when (v_event ->> 'session_id') ~ '^[0-9a-fA-F-]{36}$'
           then (v_event ->> 'session_id')::uuid end,
      v_occurred,
      v_version,
      v_source,
      v_channel,
      case when (v_event ->> 'attribution_id') ~ '^[0-9a-fA-F-]{36}$'
           then (v_event ->> 'attribution_id')::uuid end,
      public.analytics_clean_properties(v_event -> 'properties', v_allowed)
    );

    v_kept := v_kept + 1;
    if not (v_env = any (v_envs)) then
      v_envs := v_envs || v_env;
    end if;
  end loop;

  if v_kept > 0 then
    insert into public.analytics_actors (user_id, first_seen_at, last_seen_at, environments)
    values (v_actor, now(), now(), v_envs)
    on conflict (user_id) do update
      set last_seen_at  = now(),
          environments  = (
            select coalesce(array_agg(distinct e), '{}')
            from unnest(public.analytics_actors.environments || v_envs) as e
          );
  end if;

  return v_kept;
end;
$$;

revoke all on function public.analytics_track(jsonb) from public, anon, authenticated;
grant execute on function public.analytics_track(jsonb) to authenticated;

commit;
