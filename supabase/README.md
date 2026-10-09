# Database

Migrations are applied to the Supabase project in order. The repo is the source of
truth — the database is a replica of what's in `migrations/`, not the other way
round.

| File | What it does |
|---|---|
| `0001_initial_schema.sql` | Full schema per [ARCHITECTURE.md §5](../ARCHITECTURE.md#5-data-model) — 8 tables, 4 enums, append-only `events` with trigger-maintained derived status, RLS on every table |
| `0002_harden_functions_and_extension_schema.sql` | Pins `search_path` on all functions and moves `pg_trgm` out of `public`, clearing both Supabase security-linter warnings |

## Two behaviors worth knowing

**Status is derived, never set.** `applications.current_status` is a cached
projection maintained by the `events_refresh_status` trigger. It recomputes from
the most recent status-bearing event by `occurred_at`, so events arriving out of
order still produce the right answer — which matters because email and extension
capture race each other. Write events; never write status.

**`events` rejects UPDATE and DELETE** at the database level, not by convention.
This is deliberate: when entity resolution (§4) merges two records wrongly, the
audit trail is what makes it recoverable.

## Not yet done

No automated test covers the two behaviors above. They need a test against a
throwaway database — out-of-order event insertion asserting the derived status,
and asserting that UPDATE/DELETE on `events` raises. Verifying this by hand
against the live project is the wrong move; it belongs in CI.
