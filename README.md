# AI Job Tracker

A personal job-application tracker that builds itself. Instead of hand-maintaining a
spreadsheet, applications are captured automatically — from confirmation emails, and from a
browser extension at the moment of submission — and their status is kept current by reading the
email thread that follows.

**Status: design phase.** No code yet. [ARCHITECTURE.md](ARCHITECTURE.md) is the current state of
thinking: the decisions made, the reasoning behind them, and the build order.

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

TypeScript end to end so the extension and server share types. Next.js on Vercel, Postgres
(Supabase), Drizzle for migrations, Plasmo for the extension, Cloudflare Email Routing for inbound
mail, Claude for classification and extraction.

## Build order

1. Email ingestion + classifier + schema — works retroactively against existing mail, so there's
   useful data on day one
2. Dashboard: list, kanban by status, application detail with full thread
3. Extension: generic ATS capture (Greenhouse / Lever / Ashby) + manual save
4. Platform-specific capture for LinkedIn and Indeed
5. Question bank + autofill

Step 1 is a weekend and carries roughly half the total value.
