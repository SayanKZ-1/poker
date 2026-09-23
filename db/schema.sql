create schema if not exists private;
revoke all on schema private from public;
create table if not exists private.rooms (
 id text primary key, owner_id text not null, state jsonb not null,
 invite_token text not null, short_code text not null unique,
 due_at bigint, revision bigint not null default 0, updated_at timestamptz not null default now()
);
create index if not exists rooms_due on private.rooms(due_at) where due_at is not null;
create index if not exists rooms_owner on private.rooms(owner_id);
create table if not exists private.commands (
 room_id text not null references private.rooms(id) on delete cascade,
 actor_id text not null, request_id text not null, fingerprint text not null,
 result jsonb not null, created_at timestamptz not null default now(),
 primary key(room_id,actor_id,request_id)
);
create table if not exists private.events (
 room_id text not null references private.rooms(id) on delete cascade,
 event_id bigint not null, hand_id integer not null, event jsonb not null,
 primary key(room_id,event_id)
);
create table if not exists private.sessions (
 token_hash text primary key, user_data jsonb not null, expires bigint not null
);
create table if not exists private.rate_limits (
 key text primary key, count integer not null, until_at bigint not null
);
create table if not exists public.svoi_views (
 room_id text not null references private.rooms(id) on delete cascade,
 user_id text not null, revision bigint not null, payload jsonb not null,
 primary key(room_id,user_id)
);
alter table private.rooms enable row level security;
alter table private.commands enable row level security;
alter table private.events enable row level security;
alter table private.sessions enable row level security;
alter table private.rate_limits enable row level security;
alter table public.svoi_views enable row level security;
revoke all on public.svoi_views from public;
