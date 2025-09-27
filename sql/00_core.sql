create extension if not exists "uuid-ossp";

create table if not exists lifts (
  id uuid primary key default uuid_generate_v4(),
  msisdn text not null unique,
  site_name text,
  building text,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists contacts (
  id uuid primary key default uuid_generate_v4(),
  display_name text,
  primary_msisdn text unique,
  email text,
  role text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- (unique index is created implicitly by the UNIQUE constraint above)

create table if not exists lift_contacts (
  lift_id uuid not null references lifts(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  relation text default 'tenant',
  created_at timestamptz not null default now(),
  primary key (lift_id, contact_id)
);

do $$
begin
  if not exists (select 1 from pg_type where typname = 'channel_t') then
    create type channel_t as enum ('sms','wa');
  end if;
  if not exists (select 1 from pg_type where typname = 'consent_t') then
    create type consent_t as enum ('opt_in','opt_out');
  end if;
end $$;

create table if not exists consents (
  contact_id uuid not null references contacts(id) on delete cascade,
  channel channel_t not null,
  status consent_t not null,
  source text,
  ts timestamptz not null default now(),
  primary key (contact_id, channel)
);

create table if not exists messages (
  id uuid primary key default uuid_generate_v4(),
  channel channel_t not null,
  provider_id text,
  direction text check (direction in ('in','out')) not null,
  from_msisdn text,
  to_msisdn text,
  body text,
  meta jsonb,
  ts timestamptz not null default now()
);
create index if not exists idx_messages_from_ts on messages(from_msisdn, ts desc);

create table if not exists events (
  id uuid primary key default uuid_generate_v4(),
  contact_id uuid null references contacts(id) on delete set null,
  lift_id uuid null references lifts(id) on delete set null,
  type text not null,
  payload jsonb,
  ts timestamptz not null default now()
);
create index if not exists idx_events_type_ts on events(type, ts desc);

create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);
