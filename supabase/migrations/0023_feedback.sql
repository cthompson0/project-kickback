-- ===========================================================================
-- 0023 — In-product feedback
--
-- Analytics say what people did. This is the only place they can say why.
--
-- WHY IT IS NOT AN ANALYTICS EVENT
--
-- Everything in analytics_events is a small fact: a count, a bucket, a flag, a
-- short enum, capped at 64 characters, with unknown keys stripped on both sides
-- of the wire. That cap is not a limitation to be worked around - it is the
-- privacy model, and it is what makes analytics safe to keep forever.
--
-- Feedback is the opposite: prose somebody typed, about themselves, deliberately.
-- Putting it in analytics_events would put free text through a pipeline built on
-- the promise that it can never contain free text. So it lives in its own table,
-- with its own retention question and its own access rules, and analytics
-- records only that a submission happened.
--
-- WHAT THE CLIENT MAY SAY
--
-- A category, a body, and two facts about the panel that only the panel knows.
-- Everything else in the context - version, environment, friend count, whether
-- realtime is healthy, which channel they were on - is assembled by the service
-- worker, which is the only party that actually knows them. A modified extension
-- can therefore lie about its own text, which is the point of feedback, and
-- cannot fabricate diagnostics.
--
-- WHAT IS DELIBERATELY NOT HERE
--
-- No UPDATE and no DELETE for anybody. Feedback is a thing somebody said at a
-- moment; editing it after the fact would make it evidence of nothing. And no
-- read path for clients at all - not even your own, because a submission is a
-- message to us rather than a document you own.
-- ===========================================================================

begin;

-- ------------------------------------------------------------------ table

create table if not exists public.feedback (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users (id) on delete cascade,
  -- One of four, checked here rather than only in TypeScript: the extension is
  -- not a trusted validator of its own input.
  category   text not null check (category in ('bug', 'confusing', 'idea', 'other')),
  body       text not null check (char_length(body) between 1 and 2000),
  /*
   * Safe diagnostics, assembled by the service worker.
   *
   * jsonb rather than columns because the useful fields will change as the
   * product does, and a migration per diagnostic would mean the diagnostic
   * never gets added. The writer whitelists the keys, so this cannot grow a
   * field by accident - see submit_feedback.
   */
  context    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists feedback_created_idx on public.feedback (created_at desc);

alter table public.feedback enable row level security;

/*
 * No policy, and that is the whole design.
 *
 * RLS with no permissive policy denies everything, so no client can read any
 * feedback - including its own. The only writer is the SECURITY DEFINER RPC
 * below, which bypasses RLS as its owner. Reading is done by the developer in
 * the SQL editor, as the service role.
 */
revoke all on public.feedback from anon, authenticated;

-- ------------------------------------------------------------------- write

drop function if exists public.submit_feedback(text, text, jsonb);

/*
 * The only way a row gets in.
 *
 * The actor is auth.uid(), never a parameter - the same rule every other write
 * in this schema follows, and what makes submitting on somebody else's behalf
 * impossible rather than merely discouraged.
 */
create function public.submit_feedback(
  p_category text,
  p_body     text,
  p_context  jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := public.require_actor();
  -- Whitespace means every kind of it: plain btrim() only removes spaces,
  -- so a body of two newlines would otherwise count as two characters of
  -- feedback.
  v_body    text := btrim(coalesce(p_body, ''), E' \t\r\n');
  v_context jsonb;
  v_id      uuid;
begin
  if p_category is null or p_category not in ('bug', 'confusing', 'idea', 'other') then
    raise exception 'kickback: unknown feedback category' using errcode = '22023';
  end if;
  if char_length(v_body) < 1 then
    raise exception 'kickback: feedback is empty' using errcode = '22023';
  end if;
  if char_length(v_body) > 2000 then
    raise exception 'kickback: feedback is too long' using errcode = '22023';
  end if;

  /*
   * Generous enough that nobody hits it while actually reporting things, tight
   * enough that a stuck retry loop cannot fill the table. A person writing
   * feedback by hand will not send six paragraphs in a minute.
   */
  if not public.consume_rate_budget('feedback', 5, interval '5 minutes') then
    raise exception 'kickback: you are sending feedback too quickly' using errcode = '53400';
  end if;

  /*
   * The context is rebuilt key by key rather than stored as given.
   *
   * A whitelist, so a future client that starts attaching something it should
   * not - a token, a message body, a roster - writes nothing rather than
   * writing it. The server decides what a diagnostic is; the client only fills
   * the fields in.
   *
   * Every value is coerced and bounded here too: `to_jsonb(left(x, n))` means a
   * client cannot smuggle prose through a field that is supposed to hold a
   * channel login.
   */
  v_context := jsonb_strip_nulls(jsonb_build_object(
    'app_version',  to_jsonb(left(p_context ->> 'app_version', 32)),
    'environment',  to_jsonb(left(p_context ->> 'environment', 32)),
    'browser',      to_jsonb(left(p_context ->> 'browser', 64)),
    'surface',      to_jsonb(left(p_context ->> 'surface', 32)),
    'collapsed',    p_context -> 'collapsed',
    'channel',      to_jsonb(left(p_context ->> 'channel', 64)),
    'on_channel',   p_context -> 'on_channel',
    'friend_count', p_context -> 'friend_count',
    'session_available', p_context -> 'session_available',
    'social_sync',  to_jsonb(left(p_context ->> 'social_sync', 16)),
    'presence_sync', to_jsonb(left(p_context ->> 'presence_sync', 16))
  ));

  insert into public.feedback (user_id, category, body, context)
  values (v_actor, p_category, v_body, v_context)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.submit_feedback(text, text, jsonb) from public, anon;
grant execute on function public.submit_feedback(text, text, jsonb) to authenticated;

-- ------------------------------------------------------ the developer's view
--
-- Revoked like every other analytics view: this is read in the SQL editor as
-- the service role, never by a client. It exists so the documented query is one
-- line instead of a jsonb-unpacking exercise every time.

drop view if exists public.feedback_v;

create view public.feedback_v as
select
  f.created_at,
  f.category,
  f.body,
  u.display_name,
  f.context ->> 'app_version'                       as app_version,
  f.context ->> 'environment'                       as environment,
  f.context ->> 'browser'                           as browser,
  f.context ->> 'surface'                           as surface,
  f.context ->> 'channel'                           as channel,
  (f.context ->> 'friend_count')::int               as friend_count,
  (f.context ->> 'session_available')::boolean      as session_available,
  f.context ->> 'social_sync'                       as social_sync,
  f.context ->> 'presence_sync'                     as presence_sync,
  f.context                                         as full_context,
  f.id
from public.feedback f
join public.users u on u.id = f.user_id;

revoke all on public.feedback_v from anon, authenticated;

-- --------------------------------------------------- the analytics contract
--
-- One event, one property.
--
-- The body is never recorded here, and there is no second taxonomy: how many
-- people reported a bug is a product question, what they said is not an
-- analytics one. The category alone answers "is anybody using this, and what
-- kind of thing do they reach for it about".

insert into public.analytics_event_names (name, description, allowed_properties) values
  ('feedback_submitted',
   'Somebody sent in-product feedback. The body is never recorded here; see public.feedback.',
   array['category'])
on conflict (name) do update
  set description        = excluded.description,
      allowed_properties = excluded.allowed_properties;

/*
 * The applied marker, as 0016 asks: the newest analytics-touching migration
 * owns it, because everything else these files change is revoked from clients
 * and so is invisible to verify:analytics.
 */
create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $fn$ select 23 $fn$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

commit;
