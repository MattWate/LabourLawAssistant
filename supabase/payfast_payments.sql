create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  case_id uuid null references public.cases(id) on delete set null,
  provider text not null default 'payfast',
  m_payment_id text null,
  pf_payment_id text null,
  amount numeric null,
  item_name text null,
  status text not null default 'received',
  checkout_url text null,
  checkout_fields jsonb null,
  raw_itn jsonb null,
  signature_valid boolean null,
  merchant_valid boolean null,
  payfast_validation_status text null,
  payfast_validation_response text null,
  received_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.payments add column if not exists checkout_url text null;
alter table public.payments add column if not exists checkout_fields jsonb null;
alter table public.payments add column if not exists raw_itn jsonb null;
alter table public.payments add column if not exists signature_valid boolean null;
alter table public.payments add column if not exists merchant_valid boolean null;
alter table public.payments add column if not exists payfast_validation_status text null;
alter table public.payments add column if not exists payfast_validation_response text null;
alter table public.payments add column if not exists received_at timestamptz default now();
alter table public.payments add column if not exists updated_at timestamptz default now();

create unique index if not exists payments_m_payment_id_unique_idx
  on public.payments(m_payment_id)
  where m_payment_id is not null;

create index if not exists payments_case_id_idx on public.payments(case_id);
create index if not exists payments_status_idx on public.payments(status);
create index if not exists payments_pf_payment_id_idx on public.payments(pf_payment_id);

alter table public.payments enable row level security;

alter table public.cases add column if not exists payment_status text null;
alter table public.cases add column if not exists paid_at timestamptz null;
alter table public.cases add column if not exists wp_generation_unlocked boolean not null default false;