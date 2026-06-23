create table if not exists public.whatsapp_webhook_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  event_type text,
  from_number text,
  phone_number_id text,
  payload jsonb not null,
  extracted_messages jsonb default '[]'::jsonb,
  processed boolean not null default false,
  processed_at timestamptz,
  processing_error text
);

create index if not exists whatsapp_webhook_events_created_at_idx
  on public.whatsapp_webhook_events (created_at desc);

create index if not exists whatsapp_webhook_events_from_number_idx
  on public.whatsapp_webhook_events (from_number);

create index if not exists whatsapp_webhook_events_processed_idx
  on public.whatsapp_webhook_events (processed);

alter table public.whatsapp_webhook_events enable row level security;

-- No public read or write policies are created intentionally.
-- Netlify Functions use the Supabase service role key and can insert events server-side.
