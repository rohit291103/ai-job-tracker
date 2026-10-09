-- Addresses two Supabase security-linter warnings from the initial schema.

-- 1. Pin search_path on all functions and fully qualify their references.
--    A role-mutable search_path lets a caller shadow an unqualified name with
--    their own object; pinning it to empty and qualifying everything removes
--    the ambush. Required for the trigger functions in particular, which run
--    on every event insert.

create or replace function public.status_for_event(t public.event_type)
returns public.application_status
language sql immutable
set search_path = ''
as $$
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
  end::public.application_status;
$$;

create or replace function public.refresh_application_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.applications a
     set current_status = coalesce((
           select public.status_for_event(e.type)
             from public.events e
            where e.application_id = new.application_id
              and public.status_for_event(e.type) is not null
            order by e.occurred_at desc, e.created_at desc
            limit 1
         ), a.current_status),
         updated_at = now()
   where a.id = new.application_id;
  return null;
end;
$$;

create or replace function public.reject_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'events is append-only (see ARCHITECTURE.md section 5)';
end;
$$;

-- 2. Move pg_trgm out of the public schema. Supabase provisions an `extensions`
--    schema for this and keeps it on the default search_path, so the existing
--    gin_trgm_ops indexes keep working.
create schema if not exists extensions;
alter extension pg_trgm set schema extensions;
