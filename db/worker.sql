-- Enable pg_cron, pg_net and Vault in Supabase first.
-- Set Vault secrets svoi_worker_url (https://PROJECT.supabase.co/functions/v1/game/tick)
-- svoi_worker_jwt (the legacy anon JWT used only for gateway verification),
-- and svoi_worker_secret (same random value as Edge Function WORKER_SECRET).
-- No HTTP calls when no deadlines are due. Lease bounds duplicate requests during outages.
create table if not exists private.worker_lease(id boolean primary key default true check(id), until_at timestamptz not null);
insert into private.worker_lease values(true,'epoch') on conflict do nothing;
alter table private.worker_lease enable row level security;
create or replace function private.dispatch_due() returns void language plpgsql security invoker set search_path='' as $$
declare target text; secret text; worker_jwt text;
begin
 if not exists(select 1 from private.rooms where due_at <= extract(epoch from clock_timestamp())*1000) then return; end if;
 update private.worker_lease set until_at=clock_timestamp()+interval '5 seconds' where id and until_at<=clock_timestamp();
 if not found then return; end if;
 select decrypted_secret into target from vault.decrypted_secrets where name='svoi_worker_url';
 select decrypted_secret into secret from vault.decrypted_secrets where name='svoi_worker_secret';
 select decrypted_secret into worker_jwt from vault.decrypted_secrets where name='svoi_worker_jwt';
 if target is null or secret is null or worker_jwt is null then raise exception 'Worker Vault secrets missing'; end if;
 perform net.http_post(url:=target,headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||worker_jwt,'x-worker-secret',secret),body:='{}'::jsonb,timeout_milliseconds:=4000);
end $$;
revoke all on function private.dispatch_due() from public,anon,authenticated;
select cron.schedule('svoi-deadlines','1 second','select private.dispatch_due()');
