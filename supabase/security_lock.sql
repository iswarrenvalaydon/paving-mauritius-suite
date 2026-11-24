-- Security lock: only the team's logins (emails listed in Suite → WhatsApp → Setup → Team logins)
-- can read or change the Suite's and the factory app's data. Run once in Supabase → SQL Editor,
-- AFTER creating your login in the Suite. It is one single statement, so it also runs from a phone.
do $lock$
declare
  t record;
  p record;
  f record;
begin
  -- Shared data of the factory app (it used to be lost when the app was closed).
  execute $q$create table if not exists public.factory_data (
    key text primary key,
    value jsonb,
    updated_at timestamptz not null default now(),
    updated_by text
  )$q$;

  -- Is the logged-in person on the team list?
  execute $q$create or replace function public.is_team() returns boolean
    language sql stable security definer set search_path = public as
    $b$ select exists (
      select 1 from public.wa_settings
      where key = 'team_emails' and value ? lower(coalesce(auth.jwt() ->> 'email', ''))
    ) $b$$q$;
  execute 'revoke all on function public.is_team() from public, anon';
  execute 'grant execute on function public.is_team() to authenticated';

  -- Every table: row security on, old open rules removed, team-only rule added.
  -- (wa_* tables stay locked to everyone except the server, as before.)
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t.tablename loop
      execute format('drop policy %I on public.%I', p.policyname, t.tablename);
    end loop;
    if t.tablename not like 'wa\_%' then
      execute format('create policy team_only on public.%I for all to authenticated using (public.is_team()) with check (public.is_team())', t.tablename);
    end if;
    execute format('revoke all on public.%I from anon', t.tablename);
  end loop;

  -- Document numbering functions: logged-in team only.
  for f in select p2.oid::regprocedure as sig from pg_proc p2
           where p2.pronamespace = 'public'::regnamespace and p2.proname in ('get_next_ref', 'peek_next_ref') loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end
$lock$;
