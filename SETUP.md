# Setup

Phase 1: email ingestion. Gets your real application history into the database
and onto a dashboard. No domain, no DNS, no inbound mail infrastructure —
see [ADR-003](ARCHITECTURE.md#adr-003-apps-script-first-for-ingestion-cloudflare-email-routing-second).

## 1. Install

```bash
npm install
cp .env.example .env
```

## 2. Fill in `.env`

| Variable | Where it comes from |
|---|---|
| `DATABASE_URL` | Supabase dashboard → Project Settings → Database → Connection string → URI. Use the **pooled** string (port 6543) |
| `ANTHROPIC_API_KEY` | console.anthropic.com. Only used for mail the template matcher doesn't recognize |
| `INGEST_SECRET` | `openssl rand -hex 32` |
| `DEFAULT_USER_ID` | Step 3 below |

## 3. Create your user row

The schema is already applied to the Supabase project. It has no rows yet. In
the Supabase SQL editor:

```sql
insert into users (email) values ('you@example.com')
returning id, inbound_token;
```

Put the returned `id` in `.env` as `DEFAULT_USER_ID`. (`inbound_token` is unused
in phase 1 — it exists for the forwarding adapter in ADR-001.)

## 4. Run it

```bash
npm run dev          # http://localhost:3000
npm test             # 30 unit tests over normalization and template matching
npm run typecheck
```

The dashboard will say nothing has been ingested yet. That's correct.

## 5. Make the endpoint reachable from Google

Apps Script runs on Google's servers, so it cannot reach `localhost`. Either:

- **Tunnel for now:** `cloudflared tunnel --url http://localhost:3000` (or ngrok)
  and use the public URL. Fine for the backfill.
- **Or deploy:** push to Vercel, set the same environment variables there, and
  use that URL. Better if you want the hourly trigger to keep working.

## 6. Install the Apps Script

1. [script.google.com](https://script.google.com) → New project → paste
   [apps-script/Code.gs](apps-script/Code.gs).
2. Project Settings → Script Properties, add:
   - `API_URL` → `https://<your-url>/api/ingest`
   - `INGEST_SECRET` → the same value as in `.env`
3. Run `setup` once. Approve the Gmail scope.

   You will see an **"unverified app"** warning. Click Advanced → "Go to … (unsafe)".
   That warning is expected and correct: it is your own script, in your own
   account, and it has not been through Google's app verification — which is
   exactly why this approach needs no CASA assessment.

4. Run `backfill` once. It imports the last 365 days of application mail.
   Watch **Executions** for logs.

## 7. Check the results

Reload the dashboard. Then look at what didn't parse:

```sql
select received_at, parse_error, payload->>'from' as sender, payload->>'subject' as subject
from raw_events
where parse_error is not null
order by received_at desc
limit 50;
```

This is the feedback loop. `parse_error = 'unrecognized'` means neither the
templates nor the model could read it; `unresolved:<type>` means it was
understood but couldn't be matched to an application. Both are archived in full,
so fixing a pattern in [src/lib/templates.ts](src/lib/templates.ts) and
replaying is always possible — nothing is lost.

**Expect to iterate here.** The template patterns were written from the general
shape of ATS mail, not measured against a real corpus. Your inbox is the first
real test of them.

## What is not built yet

- **Browser extension** (build order steps 3–4). Email alone won't capture the
  JD text, which resume version you sent, or your screening answers.
- **Application detail view.** The dashboard is a list; the stitched email
  thread per application isn't rendered yet.
- **Database-level tests.** The append-only constraint and the status-derivation
  trigger are verified structurally but not behaviorally — that needs a
  throwaway Postgres, noted in [supabase/README.md](supabase/README.md).
- **Resume tailoring** ([§12](ARCHITECTURE.md#12-resume-tailoring-via-agent-skills)).
