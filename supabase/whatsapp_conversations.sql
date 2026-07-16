create table if not exists public.whatsapp_conversations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  from_number text not null unique,
  contact_name text,
  phone_number_id text,
  current_step text not null default 'JUR_EMPLOYEE',
  status text not null default 'active',
  collected_facts jsonb not null default '{}'::jsonb,
  classification jsonb,
  case_id uuid,
  processed_message_ids jsonb not null default '[]'::jsonb,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  handoff_reason text,
  error_message text
);

alter table public.whatsapp_conversations add column if not exists classification jsonb;
alter table public.whatsapp_conversations add column if not exists case_id uuid;
alter table public.whatsapp_conversations add column if not exists processed_message_ids jsonb not null default '[]'::jsonb;
alter table public.whatsapp_conversations add column if not exists last_inbound_at timestamptz;
alter table public.whatsapp_conversations add column if not exists last_outbound_at timestamptz;
alter table public.whatsapp_conversations add column if not exists handoff_reason text;
alter table public.whatsapp_conversations add column if not exists error_message text;

create index if not exists whatsapp_conversations_status_idx
  on public.whatsapp_conversations (status);

create index if not exists whatsapp_conversations_updated_at_idx
  on public.whatsapp_conversations (updated_at desc);

alter table public.whatsapp_conversations enable row level security;

-- No public policies are created intentionally. Netlify Functions use the
-- Supabase service role key to manage conversation state server-side.
