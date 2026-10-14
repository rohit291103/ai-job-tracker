-- Ghosting threshold.
--
-- Ghosting is a read-time predicate, not a stored status: it changes with the
-- passage of time rather than with an event, so a stored column would need a
-- scheduled job to stay true and would be wrong between runs. The same reason
-- `applications.current_status` is derived by trigger and never written by hand
-- (see ARCHITECTURE.md section 13).
--
-- So all this migration adds is where the threshold lives. The predicate itself
-- is evaluated in the query layer (src/lib/insights.ts), which keeps it in one
-- place and unit-testable without a database.

alter table users
  add column ghost_after_days integer not null default 14;

alter table users
  add constraint users_ghost_after_days_positive check (ghost_after_days > 0);

comment on column users.ghost_after_days is
  'Days of silence after which an application still in an early stage reads as ghosted. Applied at read time, never stored on the application.';
