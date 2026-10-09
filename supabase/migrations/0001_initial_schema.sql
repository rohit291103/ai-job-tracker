-- AI Job Tracker: initial schema
-- Design reference: ARCHITECTURE.md sections 4 (entity resolution) and 5 (data model).
-- Two invariants: events are append-only and source-tagged; raw payloads are kept forever
-- so a parser fix can be replayed over history instead of losing it.

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";   -- fuzzy company/title matching (section 4)

-- ---------------------------------------------------------------- enums

create type application_status as enum (
  'applied', 'acknowledged', 'screening', 'assessment',
  'interview', 'offer', 'rejected', 'withdrawn', 'ghosted'
);

create type event_type as enum (
  'applied', 'confirmation_received', 'recruiter_outreach', 'assessment_sent',
  'interview_invite', 'interview_scheduled', 'rejected', 'offer',
  'withdrawn', 'note'
);

create type capture_source as enum ('email', 'extension', 'manual');

-- Ingestion adapters (ADR-003). apps_script is phase 1; email_forward is the
-- multi-user adapter from ADR-001. Both produce rows in raw_events.
create type ingest_channel as enum ('apps_script', 'email_forward', 'extension', 'manual');

-- ---------------------------------------------------------------- core tables

create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  -- Token embedded in the per-user inbound address for the ADR-001 forwarding
  -- adapter. Unused in phase 1 but present so the switch stays additive.
  inbound_token text not null unique default encode(gen_random_bytes(8), 'hex'),
  created_at    timestamptz not null default now()
);

-- Companies are resolved to a root domain, never a display string: "Acme Inc.",
-- "Acme Corp" and acme.com must collapse to one entity (section 4).
create table companies (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  normalized_name text not null,
  root_domain     text,
  created_at      timestamptz not null default now()
);

create unique index companies_root_domain_key
  on companies (root_domain) where root_domain is not null;
create index companies_normalized_name_trgm
  on companies using gin (normalized_name gin_trgm_ops);

create table applications (
  id               uuid not null primary key default gen_random_uuid(),
  user_id          uuid not null references users (id) on delete cascade,
  company_id       uuid references companies (id) on delete set null,
  title            text not null,
  normalized_title text not null,
  source           capture_source not null,
  external_url     text,
  ats              text,
  applied_at       timestamptz not null,
  -- Cached projection of the event log, maintained by trigger below. The events
  -- table remains the source of truth; this exists so the dashboard can filter
  -- and sort without folding the log on every query.
  current_status   application_status not null default 'applied',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Supports the section 4 matching key: company + normalized title + date window.
create index applications_match_key
  on applications (user_id, company_id, normalized_title, applied_at desc);
create index applications_status on applications (user_id, current_status);
create index applications_title_trgm
  on applications using gin (normalized_title gin_trgm_ops);

-- Append-only. Never updated or deleted; status is derived from these.
create table events (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users (id) on delete cascade,
  application_id uuid not null references applications (id) on delete cascade,
  type           event_type not null,
  occurred_at    timestamptz not null,
  source         capture_source not null,
  raw_event_id   uuid,
  summary        text,
  created_at     timestamptz not null default now()
);

create index events_application on events (application_id, occurred_at desc);
create index events_user_occurred on events (user_id, occurred_at desc);

-- The permanent archive (section 5). Also the eval set for the classifier.
create table raw_events (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users (id) on delete cascade,
  channel        ingest_channel not null,
  external_id    text,               -- provider message id, for idempotency
  received_at    timestamptz not null default now(),
  payload        jsonb not null,
  parsed_at      timestamptz,
  parser_version text,
  parse_error    text,
  application_id uuid references applications (id) on delete set null
);

-- Makes re-ingestion idempotent: the Apps Script poller can safely re-send a
-- message it has already delivered.
create unique index raw_events_dedupe
  on raw_events (user_id, channel, external_id) where external_id is not null;
create index raw_events_unparsed on raw_events (received_at) where parsed_at is null;

alter table events
  add constraint events_raw_event_fk
  foreign key (raw_event_id) references raw_events (id) on delete set null;

-- ---------------------------------------------------------------- supporting tables

create table resume_versions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users (id) on delete cascade,
  label           text not null,
  file_ref        text,
  -- Set when produced by the tailoring pipeline (section 12), so the exact
  -- document a recruiter received is known when they reply.
  tailored_for    uuid references applications (id) on delete set null,
  created_at      timestamptz not null default now()
);

create index resume_versions_user on resume_versions (user_id, created_at desc);

-- Postings get taken down right when you need them to prep (section 1).
create table job_descriptions (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications (id) on delete cascade,
  text           text not null,
  captured_at    timestamptz not null default now()
);

create index job_descriptions_application on job_descriptions (application_id);

-- The compounding piece (section 6): every question ever asked, so the model is
-- only invoked for genuinely new ones.
create table question_bank (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users (id) on delete cascade,
  normalized_question text not null,
  answer              text not null,
  times_used          integer not null default 0,
  updated_at          timestamptz not null default now(),
  unique (user_id, normalized_question)
);

create index question_bank_trgm
  on question_bank using gin (normalized_question gin_trgm_ops);

-- ---------------------------------------------------------------- derivation

-- Maps a status-bearing event to the status it implies. Non-status events
-- (note, confirmation_received) return null and leave the status alone.
create function status_for_event(t event_type)
returns application_status language sql immutable as $$
  select case t
    when 'applied'             then 'applied'
    when 'recruiter_outreach'  then 'screening'
    when 'assessment_sent'     then 'assessment'
    when 'interview_invite'    then 'interview'
    when 'interview_scheduled' then 'interview'
    when 'offer'               then 'offer'
    when 'rejected'            then 'rejected'
    when 'withdrawn'           then 'withdrawn'
    else null
  end::application_status;
$$;

-- Recomputes the cached status from the most recent status-bearing event.
-- Order-independent: events arriving out of order still produce the right answer,
-- which matters because email and extension capture race each other.
create function refresh_application_status()
returns trigger language plpgsql as $$
begin
  update applications a
     set current_status = coalesce((
           select status_for_event(e.type)
             from events e
            where e.application_id = new.application_id
              and status_for_event(e.type) is not null
            order by e.occurred_at desc, e.created_at desc
            limit 1
         ), a.current_status),
         updated_at = now()
   where a.id = new.application_id;
  return null;
end;
$$;

create trigger events_refresh_status
  after insert on events
  for each row execute function refresh_application_status();

-- Enforce append-only on events at the database level, not just by convention.
create function reject_event_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'events is append-only (see ARCHITECTURE.md section 5)';
end;
$$;

create trigger events_no_update before update on events
  for each row execute function reject_event_mutation();
create trigger events_no_delete before delete on events
  for each row execute function reject_event_mutation();

-- ---------------------------------------------------------------- RLS

-- Enabled now even though phase 1 has one user: retrofitting tenancy across a
-- schema with months of code written against it is the worst version of this
-- (section 8). Server-side work uses the service role and bypasses these.
alter table users             enable row level security;
alter table companies         enable row level security;
alter table applications      enable row level security;
alter table events            enable row level security;
alter table raw_events        enable row level security;
alter table resume_versions   enable row level security;
alter table job_descriptions  enable row level security;
alter table question_bank     enable row level security;

create policy own_row on users
  for all using (id = auth.uid());

create policy own_rows on applications
  for all using (user_id = auth.uid());
create policy own_rows on events
  for all using (user_id = auth.uid());
create policy own_rows on raw_events
  for all using (user_id = auth.uid());
create policy own_rows on resume_versions
  for all using (user_id = auth.uid());
create policy own_rows on question_bank
  for all using (user_id = auth.uid());

create policy own_rows on job_descriptions
  for all using (exists (
    select 1 from applications a
     where a.id = job_descriptions.application_id
       and a.user_id = auth.uid()
  ));

-- Companies are shared reference data, not user-owned.
create policy read_all on companies for select using (true);
