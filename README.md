# AI Job Tracker

A personal job-application tracker that builds itself. Instead of hand-maintaining a
spreadsheet, applications are captured automatically — from confirmation emails, and from a
browser extension at the moment of submission — and their status is kept current by reading the
email thread that follows.

**Status: phase 1 built, plus insights.** Email ingestion, the template matcher, the model
fallback, entity resolution, a list dashboard and a funnel/conversion view are in place and tested;
nothing has yet run against a real inbox.
[SETUP.md](SETUP.md) gets it running in about fifteen minutes.
[ARCHITECTURE.md](ARCHITECTURE.md) carries the decisions, the reasoning behind each one, and the
build order.

## The core problem, and the thing that isn't obvious

The intuitive design is "connect my job boards via API, and fall back to a browser extension for
company career sites." That design doesn't work, because **no job board exposes an API for the jobs
you've applied to.** LinkedIn's API is partner-gated and has no application history; Indeed retired
its job-seeker API; Naukri has nothing public. Scraping a logged-in session is both fragile and a
route to account restriction.

What *is* universal: **every application generates a confirmation email.** Greenhouse, Lever,
Workday, Ashby, SmartRecruiters, iCIMS, Taleo and LinkedIn Easy Apply all send a templated
"thanks for applying" from a recognizable sender. The inbox is the only place where 100% of
applications converge, regardless of where they were submitted.

So email is the backbone and the status engine. The extension is a metadata enricher, not a
fallback.

| Channel | Captures | Coverage |
|---|---|---|
| **Email** (forwarded, not OAuth) | That the application happened, plus every status change after it | ~95%, works everywhere |
| **Browser extension** | Submit-time context: JD text, resume version, salary field, screening answers | ~100% where installed, but only at that moment |
| **Manual / paste** | The long tail | Always needed |

## Decisions worth knowing up front

- **Ingest email by forwarding, not Gmail OAuth.** Reading message bodies needs a Google
  *restricted* scope, which gates any public launch behind an annual third-party CASA assessment.
  A per-user inbound address plus one Gmail filter avoids the scope entirely and never touches the
  mailbox. See [ADR-001](ARCHITECTURE.md#adr-001-ingest-email-by-forwarding-not-gmail-oauth).
- **Entity resolution is the hard part**, not capture. The same application arrives from two or
  three sources and has to collapse into one row without corrupting history.
- **Autofill stops before the submit button.** Filling the form is most of the time saved and
  carries no account risk; auto-submitting carries real risk and converts badly anyway.
- **Build for one user, but don't foreclose more.** A handful of decisions (tenancy, queueing, raw
  event archive) are cheap now and painful to retrofit. Everything else waits.

## Stack

TypeScript end to end so the extension and server share types. Next.js on Vercel, Postgres via
Supabase, Drizzle for migrations, WXT for the extension, and Claude for classification. Email
ingestion starts as a Google Apps Script in your own account — no domain or inbound mail
infrastructure needed — with Cloudflare Email Routing as the second adapter if this ever goes
multi-user.

Each choice is recorded with its reasoning in [ARCHITECTURE.md §10](ARCHITECTURE.md#10-stack),
alongside an [alternatives considered](ARCHITECTURE.md#11-alternatives-considered) section covering
scraping, Firebase and n8n — the approaches most tutorials on this use.

## Build order

1. ~~Email ingestion + classifier + schema~~ — done. Works retroactively against existing mail, so
   there's useful data on day one
2. Dashboard: list, kanban by status, application detail with full thread
3. Extension: generic ATS capture (Greenhouse / Lever / Ashby) + manual save
4. Platform-specific capture for LinkedIn and Indeed
5. Question bank + autofill
6. ~~Insights: funnel, response times, conversion by source~~ — done. Activity heatmap and
   coding-profile sync still open

Step 1 carried roughly half the total value.

## The aggregated view

Beyond the list, the direction is a Codolio-shaped command center — funnel conversion, response
times, activity heatmap, synced LeetCode / Codeforces / GitHub progress — **private to its owner,
with no public page.** Your own data doesn't need to be flattering: 247 applications and 4
interviews is exactly the number worth seeing, because it says the resume is the problem and not
the interviewing. One rule keeps it from becoming a wall of vanity metrics: every number on the
page has to be one that would change a decision.

The hard part isn't the charts, it's the silence. Email capture observes rejections and invitations
well and observes *no reply* as nothing at all — so ghosting has to be a predicate evaluated at
read time, not a stored status. Recorded with the per-platform sync feasibility table in
[ARCHITECTURE.md §13](ARCHITECTURE.md#13-the-aggregated-view).
