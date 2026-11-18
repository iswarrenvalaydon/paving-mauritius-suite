-- WhatsApp bot tables for Paving Mauritius
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to run again: it only creates what is missing.
-- Row Level Security is ON with no public policies, so the Suite's browser key
-- cannot read these tables. Only the server (secret key) can.

create table if not exists wa_contacts (
  wa_id            text primary key,            -- client's number, e.g. 23057629412
  name             text,                        -- name saved on the business phone
  profile_name     text,                        -- name the client shows on WhatsApp
  is_staff         boolean not null default false,
  bot_paused       boolean not null default false,
  unread           integer not null default 0,
  last_message_at  timestamptz,
  last_inbound_at  timestamptz,
  notes            text,
  created_at       timestamptz not null default now()
);

create table if not exists wa_messages (
  id          text primary key,                 -- WhatsApp message id
  wa_id       text not null references wa_contacts(wa_id) on delete cascade,
  direction   text not null check (direction in ('in','out')),
  source      text not null,                    -- client | phone | suite | history
  type        text,
  body        text,
  media_id    text,
  status      text,
  sent_at     timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists wa_messages_chat_idx on wa_messages (wa_id, sent_at desc);

create table if not exists wa_drafts (
  id           bigserial primary key,
  wa_id        text not null references wa_contacts(wa_id) on delete cascade,
  reply_to     text,                            -- message id the draft answers
  body         text not null default '',
  team_note    text,
  needs_team   boolean not null default false,
  status       text not null default 'pending'
               check (status in ('pending','sent','discarded','superseded','failed')),
  error        text,
  created_at   timestamptz not null default now(),
  decided_at   timestamptz
);
create index if not exists wa_drafts_pending_idx on wa_drafts (status, created_at desc);

create table if not exists wa_settings (
  key    text primary key,
  value  jsonb
);
insert into wa_settings (key, value) values
  ('bot_enabled',   'true'::jsonb),
  ('staff_numbers', '["23057396517"]'::jsonb)
on conflict (key) do nothing;

create table if not exists wa_events (
  id           bigserial primary key,
  received_at  timestamptz not null default now(),
  kind         text,
  payload      jsonb
);

alter table wa_contacts enable row level security;
alter table wa_messages enable row level security;
alter table wa_drafts   enable row level security;
alter table wa_settings enable row level security;
alter table wa_events   enable row level security;
