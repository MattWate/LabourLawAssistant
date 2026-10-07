-- Sequential human-readable client references for launch.
-- Existing rows are intentionally left NULL so test/pre-launch data does not consume
-- the CNTB sequence. New cases receive CNTB000001, CNTB000002, etc.

alter table public.cases
  add column if not exists client_reference text;

create sequence if not exists public.vrs_client_reference_seq
  as bigint
  start with 1
  increment by 1
  minvalue 1;

create unique index if not exists cases_client_reference_key
  on public.cases (client_reference)
  where client_reference is not null;

create or replace function public.assign_vrs_client_reference()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.client_reference is null or btrim(new.client_reference) = '' then
    new.client_reference := 'CNTB' || lpad(nextval('public.vrs_client_reference_seq')::text, 6, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_assign_vrs_client_reference on public.cases;
create trigger trg_assign_vrs_client_reference
before insert on public.cases
for each row
execute function public.assign_vrs_client_reference();

comment on column public.cases.client_reference is
  'Sequential human-readable client reference, e.g. CNTB000001. Assigned once at insert and never regenerated.';
