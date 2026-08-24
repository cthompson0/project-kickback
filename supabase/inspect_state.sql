-- What is actually applied to this database?
--
-- Read-only. Paste into Supabase -> SQL Editor and run. Changes nothing.
--
-- Useful when a migration run stopped part-way and you want to know where it
-- got to before running the bundle again. (Running the bundle again is safe
-- either way - see supabase/.generated/apply_all.sql - but it is nice to know.)

select
  'groups.icon column'                  as thing,
  to_char(count(*), 'FM9')              as found
from information_schema.columns
where table_schema = 'public' and table_name = 'groups' and column_name = 'icon'

union all
select
  'list_groups columns: ' || coalesce(array_to_string(p.proargnames, ', '), '(none)'),
  '1'
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'list_groups'

union all
select
  'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
  '1'
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_group', 'set_group_icon', 'list_group_sent_invites')

order by thing;
