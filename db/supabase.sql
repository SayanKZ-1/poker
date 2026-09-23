-- Run AFTER schema.sql. Only the current user's sanitized projection is exposed.
revoke all on all tables in schema private from anon,authenticated;
revoke all on schema private from anon,authenticated;
revoke all on public.svoi_views from anon,authenticated;
grant select on public.svoi_views to authenticated;
drop policy if exists svoi_own_view on public.svoi_views;
create policy svoi_own_view on public.svoi_views for select to authenticated
 using (user_id = (select auth.uid())::text);
do $$ begin
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='svoi_views' and schemaname='public') then
  alter publication supabase_realtime add table public.svoi_views;
 end if;
end $$;
