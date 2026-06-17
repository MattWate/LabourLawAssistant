-- Protected VRS skill asset registry
-- Run this in Supabase SQL Editor.
-- Do not store proprietary skill content in the public frontend.
-- The Netlify backend reads this table with the service key.

create table if not exists public.protected_skill_assets (
  id uuid primary key default gen_random_uuid(),
  asset_name text not null,
  asset_type text not null default 'markdown',
  version text not null default 'v1.0',
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  content text,
  storage_bucket text,
  storage_path text,
  sha256 text,
  notes text,
  created_by text,
  approved_by text,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  constraint protected_skill_assets_content_or_storage check (
    content is not null or (storage_bucket is not null and storage_path is not null)
  )
);

create unique index if not exists protected_skill_assets_unique_version
  on public.protected_skill_assets(asset_name, version);

create index if not exists protected_skill_assets_active_lookup
  on public.protected_skill_assets(asset_name, status, version, activated_at desc);

alter table public.protected_skill_assets enable row level security;

-- No anonymous or authenticated frontend access by default.
-- The Netlify serverless functions should use the Supabase service role key.

drop policy if exists "No public read protected skill assets" on public.protected_skill_assets;
create policy "No public read protected skill assets"
  on public.protected_skill_assets
  for select
  using (false);

-- Optional private storage bucket for large DOCX/template assets.
-- Create through Supabase UI if this SQL is not permitted in your project:
-- Bucket name: protected-vrs-skills
-- Public bucket: false

insert into public.protected_skill_assets (asset_name, asset_type, version, status, content, notes, activated_at)
values
  ('VRS_HOUSE_STYLE', 'markdown', 'v1.0', 'draft', 'UPLOAD_CONTENT_HERE', 'VRS_HouseStyle.md', null),
  ('SKILL_MATTER_ASSESSMENT', 'markdown', 'v1.0', 'draft', 'UPLOAD_CONTENT_HERE', 'SKILL_MatterAssessment.md', null),
  ('SKILL_WORKFLOW', 'markdown', 'v1.0', 'draft', 'UPLOAD_CONTENT_HERE', 'SKILL_Workflow.md', null),
  ('SKILL_ADVISORY', 'markdown', 'v1.0', 'draft', 'UPLOAD_CONTENT_HERE', 'SKILL_Advisory.md', null),
  ('SKILL_WPLETTER_EMPLOYEE', 'markdown', 'v1.0', 'draft', 'UPLOAD_CONTENT_HERE', 'SKILL_WPLetter_Employee.md', null),
  ('SKILL_WPLETTER_EMPLOYER', 'markdown', 'v1.0', 'draft', 'UPLOAD_CONTENT_HERE', 'SKILL_WPLetter_Employer.md', null),
  ('WP_EMPLOYEE_PROMPT', 'text', 'v1.0', 'draft', 'UPLOAD_EXTRACTED_DOCX_TEXT_HERE', 'Extracted text from WP_Employee_Prompt.docx', null),
  ('WP_EMPLOYER_PROMPT', 'text', 'v1.0', 'draft', 'UPLOAD_EXTRACTED_DOCX_TEXT_HERE', 'Extracted text from WP_Employer_Prompt.docx', null)
on conflict (asset_name, version) do nothing;

-- After replacing placeholder content, activate the version with:
-- update public.protected_skill_assets
-- set status = 'active', activated_at = now()
-- where version = 'v1.0'
--   and content is not null
--   and content <> 'UPLOAD_CONTENT_HERE'
--   and content <> 'UPLOAD_EXTRACTED_DOCX_TEXT_HERE';