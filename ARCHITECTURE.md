# Architecture

Design notes for a personal job-application tracker, with the decisions recorded so the reasoning
survives. Nothing here is built yet.

**Scope:** built for a single user first. A section near the end covers what changes if it ever
goes multi-user, and which decisions are worth making now to keep that door open.

---

## 1. Capture

### Why there is no "connect your job boards" feature

No major board exposes an API for your own application history:

- **LinkedIn** — API access is partner-gated; no endpoint exposes applications you've submitted.
- **Indeed** — the public job-seeker API was retired.
- **Naukri** — nothing public.

Scraping a logged-in session from a server is fragile (markup changes constantly) and risks
account restriction. So OAuth-and-sync, the feature everyone assumes exists, is not available as a
product primitive.

### What is universal: the confirmation email

Every application produces one. Greenhouse, Lever, Workday, Ashby, SmartRecruiters, iCIMS, Taleo
and LinkedIn Easy Apply all send templated confirmations from recognizable senders. The inbox is
the only place where every application converges.

More importantly, the inbox carries *everything that happens next* — recruiter replies, online
assessment links, interview invitations, rejections. Status tracking is almost entirely an email
problem, not a job-board problem.

### Three channels

1. **Email — the backbone and the status engine.** Establishes that an application exists, then
   drives every subsequent state change. Works retroactively: pointing it at an existing mailbox
   reconstructs history immediately, before any other component exists.
2. **Browser extension — the enricher.** Captures what email never contains: the job description
   text (postings get taken down right when you need them to prep), which resume version was sent,
   the salary figure entered, the answers to screening questions.
3. **Manual entry.** The long tail. Always needed; not worth pretending otherwise.

---

## 2. Email ingestion

### ADR-001: Ingest email by forwarding, not Gmail OAuth

**Decision:** each user gets a unique inbound address (`u_<token>@in.<domain>`) and sets up one
Gmail filter that forwards application mail to it. The system never connects to the mailbox.

**Why.** Reading message bodies requires Google's `gmail.readonly` scope, which is *restricted*.
In test mode it's free and unrestricted for up to 100 users — fine for personal use. Going public
means an annual third-party CASA security assessment, plus privacy policy, domain verification,
demo video and limited-use disclosure. That is real money and weeks of process, and it would be
discovered at exactly the wrong moment.

Forwarding sidesteps the scope entirely:

- No OAuth, no restricted scope, no CASA. The public-launch blocker never materializes.
- Only explicitly forwarded mail is ever received — a materially stronger privacy position than
  holding read access to someone's entire inbox, and a defensible claim rather than a hedge.
- Receiving is cheap: Cloudflare Email Routing (free) delivers the raw message to a Worker;
  Postmark or SendGrid inbound webhooks are equivalent.

**Costs accepted.** One-time setup friction — Gmail requires verifying a forwarding address, and
the user has to create the filter. Coverage is bounded by the filter's accuracy, which is also the
point.

**Consequence.** Build the forwarding path first even for single-user. It's less work than OAuth
and it's the path that survives contact with users. Keep ingestion behind an interface so an OAuth
adapter can be added later if zero-setup onboarding ever justifies the compliance cost.

### Classification

Confirmation emails are *templated*, so most of the work needs no model at all:

1. **Template matcher first.** Sender-domain plus subject/body patterns per known ATS. Handles the
   large majority deterministically, for free, with no latency.
2. **Model fallback** for anything unmatched, extracting company, role, ATS and event type.
3. **Archive the raw payload always** (see §5), so a parser fix can be replayed over history.

Naukri is the hard case: it sends very high volumes of job alerts, recruiter mailers and promos.
A sender-domain rule is not enough. Gate on subject/body patterns for an actual application event,
then let the model confirm. Build a labeled set from real mail and measure the false-positive rate
before trusting it — a false positive creates a phantom application, which is worse than a miss.

---

## 3. Extension capture

### Don't scrape the DOM — intercept the network

LinkedIn, Indeed and most modern ATS front-ends are SPAs whose markup changes often, but whose
**submit request is stable**. Hooking the network layer is both more robust and gives structured
JSON instead of inferred text.

MV3 supports injecting into the page's own JS context via `world: "MAIN"` (Chrome 111+):

```json
// manifest.json
"content_scripts": [
  { "matches": ["https://*.example.com/*"], "js": ["interceptor.js"],
    "world": "MAIN", "run_at": "document_start" },
  { "matches": ["https://*.example.com/*"], "js": ["relay.js"],
    "world": "ISOLATED", "run_at": "document_start" }
]
```

```js
// interceptor.js — runs in the page, sees the requests the app itself makes
const origFetch = window.fetch;
window.fetch = async function (...args) {
  const res = await origFetch.apply(this, args);
  try {
    const url = typeof args[0] === "string" ? args[0] : args[0].url;
    if (isSubmitEndpoint(url)) {
      window.postMessage({
        __jt: true,
        url,
        body: args[1]?.body,
        payload: await res.clone().json().catch(() => null),
      }, "*");
    }
  } catch {}
  return res;
};
```

`relay.js` (isolated world) listens for `__jt` messages and forwards them to the background worker
via `chrome.runtime.sendMessage`; the worker POSTs to the API. `XMLHttpRequest` needs the same
treatment — some sites still use it.

**Finding each endpoint:** DevTools → Network → filter XHR → submit one application → read what
fired. Roughly ten minutes per platform, and the result is far more durable than a CSS selector.

### Per-platform notes

| Platform | Approach | Notes |
|---|---|---|
| **Greenhouse / Lever / Ashby** | URL pattern + predictable form fields | Easiest case. Stable field names, good autofill targets. |
| **Workday** | Hard | Nested iframes, per-tenant account creation, multi-step wizards. Roughly 40% of enterprise applications and the reason every competitor's autofill is weakest here. Do not promise it early. |
| **LinkedIn Easy Apply** | Intercept the submit call; confirmation-modal observer as fallback | Also sends a clean "Your application was sent to X" email as a safety net. |
| **Indeed** | Two distinct paths | *Apply on company site* redirects to the real ATS — generic capture handles it and Indeed is irrelevant. *Indeed Apply* (on-site modal) is the one to intercept. |
| **Naukri** | Email capture is sufficient | Mostly one-click apply, so the extension adds little. The work here is noise filtering, not capture. |

**Backfill.** Each platform has an "applied jobs" view. Rather than writing a scraper, have a
content script read the rendered list while the user scrolls it themselves — one-time, in their own
session, no automated traffic.

**On bot detection.** Indeed in particular runs aggressive detection (Cloudflare plus their own
fingerprinting). An extension acting inside a real browsing session is a human browsing; a headless
automation script hitting the same endpoints is not, and will be blocked. Stay in the extension.

---

## 4. Entity resolution

**This is the hard engineering problem**, not capture.

A single application can arrive as: an extension event
(`boards.greenhouse.io/acme/jobs/4839`), a confirmation email from `no-reply@greenhouse.io`
("Senior PM at Acme"), and a recruiter reply three days later from `jane@acme.com`. Collapsing
those into one record is where this kind of product succeeds or fails. A wrong merge corrupts
history; no merge produces duplicate soup.

Matching key:

- **Company** normalized to a root domain, never a display string — "Acme Inc.", "Acme Corp" and
  `acme.com` must resolve to one entity.
- **Title** normalized (case, seniority prefixes, requisition IDs stripped).
- **A ±7-day window.**
- A model as tiebreaker on ambiguous pairs, and a UI affordance for "these look like the same
  thing — merge?"

Never let resolution be irreversible. Which leads to the data model.

---

## 5. Data model

Two principles, both of which exist to make being wrong survivable:

**Events are immutable and source-tagged.** An `application` has many `events`. Status is never
overwritten — events are appended and current state is *derived*. When matching gets something
wrong, there's an audit trail to unwind instead of a silently corrupted row.

**Raw payloads are archived forever.** A `raw_events` table stores every inbound message and
extension payload unparsed. When a site changes its markup, or the classifier improves, history can
be replayed rather than lost. This table is also the eval set for the classifier.

Sketch:

```
users              id, email, inbound_token
companies          id, name, root_domain, normalized_name
applications       id, user_id, company_id, title, normalized_title,
                   source, external_url, applied_at, current_status (derived)
events             id, user_id, application_id, type, occurred_at,
                   source, raw_event_id            -- append-only
raw_events         id, user_id, channel, received_at, payload (jsonb),
                   parsed_at, parser_version
resume_versions    id, user_id, label, file_ref, created_at
job_descriptions   id, application_id, text, captured_at
question_bank      id, user_id, normalized_question, answer, updated_at
```

`user_id` is on every table from the first migration, with UUID keys — see §8.

---

## 6. Autofill and the question bank

**Autofill stops before the submit button.** The extension fills every field it can — years of
experience, work authorization, notice period, salary, screening questions — then waits. The user
reads it and submits.

This is a deliberate line. It keeps essentially all of the time saved, keeps a human on the
judgment calls, and produces no traffic pattern that looks automated. Auto-submitting, by contrast,
risks the account (platforms detect and restrict automated bulk applying) and converts poorly
anyway — mass one-click applying has a weak response rate precisely because it's frictionless for
everyone.

**The question bank is the compounding piece.** Store every question ever encountered, keyed by
normalized question text, with the answer given. After ~30 applications it covers nearly
everything, including the odd one-offs. The model is only invoked for genuinely new questions, and
its answer is written back. This is the feature that gets used daily.

---

## 7. Cost model

Deliberately shaped so the expensive feature is the one worth charging for.

**Classification is cheap.** At ~1,000 users × 40 applications/month × ~8 emails each ≈ 320k
emails/month, at roughly 1,200 input + 80 output tokens per email on Claude Haiku 4.5
($1 / $5 per MTok): about **$510/month**. The Batch API halves anything not latency-sensitive. The
template matcher from §2 handling ~85% deterministically drops it under **$100/month**.

Prompt caching matters here: the classifier's system prompt and few-shot examples are byte-identical
on every call, so they belong in the cached prefix with the email body last, after the final
breakpoint.

**Resume tailoring is the real cost driver.** Long inputs on an Opus-tier model run roughly $0.07
per tailoring; a user doing 40/month costs ~$3 on that feature alone — several times their entire
classification cost.

So the tiering falls out of the unit economics rather than being guessed at: **tracking and
classification are free, tailoring is paid.**

---

## 8. If this ever goes multi-user

Build for one user. But a few decisions are cheap today and genuinely painful to retrofit:

1. **`user_id` on every table from the first migration, UUID keys.** One hardcoded row initially.
   Retrofitting tenancy across a schema with months of code written against it is the worst version
   of this.
2. **Config-driven API base URL in the extension.** Never hardcode `localhost`.
3. **Ingestion behind a queue, not in a request handler.** Even a single `jobs` table and a worker
   loop. Synchronous ingestion works fine for one user and has to be torn out later.
4. **`raw_events` from day one** (§5).
5. **Platform-specific interceptors behind a feature flag** — see below.

### What gets harder

**The LinkedIn and Indeed interceptors can't ship in a public product.** Intercepting your own
session as a single user is unremarkable. Distributing software that automates LinkedIn is a
different matter: LinkedIn pursues it, and the people who bear the consequence are users whose
accounts get restricted. Flagged, removing it is a config change; woven into the core capture path,
it's surgery. The public product is forwarding-based email ingestion plus ATS capture and autofill —
which is well-trodden ground that existing tools occupy openly.

**The data is sensitive.** Resumes, work authorization status, salary expectations, sometimes dates
of birth and addresses. GDPR applies to any EU user; India's DPDP Act to domestic ones. Minimum
posture: encrypt resume blobs at rest, never log raw payloads, a real hard-delete path, and strip
anything from model prompts the task doesn't require.

**Chrome Web Store review will be slow.** `world: "MAIN"` injection plus broad host permissions
triggers manual review — weeks, not days. The single-purpose justification needs care.

### What not to build yet

Billing, teams, an admin panel, onboarding flows, a landing page. Each is about a week's work later
and pure distraction now. Whether this becomes a product is decided by whether it gets used daily
through a real job search and beats a spreadsheet — and that can only be learned by using it.

---

## 9. Build order

1. **Email ingestion + classifier + schema.** Works retroactively, so there's a populated database
   before any UI exists. Roughly a weekend, and about half the total value.
2. **Dashboard** — list, kanban by status, application detail with the full stitched thread.
3. **Extension: generic capture** — Greenhouse / Lever / Ashby URL patterns plus a manual
   "save this page" button.
4. **Platform interceptors** for LinkedIn and Indeed, behind flags.
5. **Question bank + autofill.**

Deliberately ordered so each step is independently useful, and so the extension is built *after*
there's evidence about what email alone fails to catch.

## 10. Stack

Verified against current tooling state in October 2026, not assumed.

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript throughout | Extension and server share types — the capture payload is the same shape on both sides |
| App | Next.js on Vercel | Dashboard and API in one deploy |
| Database | Postgres via Supabase | The core problem is relational (§4, §5). Supabase supplies the Firebase conveniences — auth, realtime, storage — without the data model that fights joins |
| ORM | Drizzle | Types inferred from the schema with no codegen step, readable checked-in SQL migrations, ~7kb for edge runtimes. The current default for greenfield Next.js + Postgres |
| Extension | **WXT** | See ADR-002 |
| Email ingest | Apps Script → Cloudflare Email Routing | See ADR-003 |
| Models | Claude Haiku 4.5 for classification, Opus-tier for tailoring | §7 |

### ADR-002: WXT for the extension, not Plasmo

**Decision:** build the extension with WXT.

**Why.** Plasmo is effectively in maintenance mode as of late 2025 — the framework still works, but it is not being actively developed, and migration posts from teams moving off it are now the common case. WXT is actively maintained, builds substantially faster, produces roughly half the bundle size, and has reliable HMR, which matters because extension development has a slow feedback loop already. It also treats frameworks other than React as first-class, which costs nothing here but removes a future constraint.

This reverses an earlier recommendation of Plasmo in this project's planning, which was based on its MV3 boilerplate being the best-known option. That was true a year ago.

### ADR-003: Apps Script first for ingestion, Cloudflare Email Routing second

**Decision:** phase 1 reads mail with a Google Apps Script running inside the user's own account. The forwarding architecture from ADR-001 is the second adapter behind the same interface, built when the project goes multi-user.

**Why.** ADR-001's reasoning about restricted scopes and CASA is about *distributing* an OAuth app. For a single user it doesn't apply: an Apps Script you own, bound to your own account, needs no verification — you authorize it yourself and click through an unverified-app warning once. A time-based trigger runs a Gmail search and POSTs matches to the API.

That means phase 1 needs **no domain, no DNS, no OAuth app, no inbound mail infrastructure at all.** It is the shortest path to a populated database, which is the whole point of putting ingestion first in the build order.

It does not scale past one user — distributing it would mean publishing a Workspace Add-on with its own review — which is exactly why ADR-001 remains the multi-user design. Both are ingestion adapters producing the same `raw_events` rows, so the switch is additive rather than a rewrite.

### Cloudflare Email Routing: two operational details

Confirmed for when ADR-001's path gets built:

- **Inbound is unlimited and free** on both Workers Free and Paid plans.
- **There is a hard limit of 200 addresses and 200 routing rules per account**, which would otherwise cap the product at 200 users. The way around it is a **catch-all route** to a single Email Worker that parses the recipient out of the message headers to recover the user token — one rule, unlimited users.
- **Email Workers count against normal Workers CPU limits**, and complex handlers can exceed them on the free plan. So the Worker stays thin: validate, write the raw message, enqueue. All parsing and classification happens downstream — which is the queue separation §8 calls for anyway.

---

## 11. Alternatives considered

Recorded because these are the approaches most "automate your job search" tutorials use, and the reasons for not choosing them are specific rather than general.

**Scraping job boards (Playwright, Firecrawl, Apify).** Solves *discovery* — finding listings. This project's problem is *tracking* what was already applied to, and that fact exists only in the user's private account state and inbox; no amount of scraping public job pages recovers it. Scraping becomes relevant only if a discovery module is added (§12), where those tools are the right choice.

**Firebase / Firestore.** The data model here is relational by nature: an application folds an event log into a derived status and joins to a company, a thread, a resume version and a JD snapshot (§4, §5). Firestore has no joins, so assembling an application means N+1 reads; per-document pricing punishes read-heavy dashboards; and fuzzy company matching is an awkward query shape. The result would be aggressive denormalization with hand-maintained consistency, which is how merge bugs become unrecoverable.

**n8n / Make for the pipeline.** A genuinely faster way to get email → parse → store running without writing a backend, and a reasonable way to validate that classification works on real mail before committing to code. Not chosen because entity resolution (§4) is awkward to express in a visual workflow and the logic isn't portable, but it is a legitimate shortcut rather than a wrong answer.

**Headless browser automation for capture.** Rejected for LinkedIn and Indeed specifically: both run aggressive bot detection, and automated traffic against them risks the user's account. An extension inside a real browsing session is a human browsing. The extension is also strictly better for this purpose — it rides the existing session passively instead of reproducing authentication.

**Auto-submitting applications.** See §6. Real account risk, and poor conversion because frictionless bulk applying is weak precisely because it is frictionless for everyone.

---

## 12. Resume tailoring via Agent Skills

The one place a model earns its cost rather than saving a few seconds of parsing.

Tailoring a resume against a JD is a packaged, reusable, versionable instruction set — which is what a Skill is. Two properties make this the right shape:

- **The output is a file, not text.** Agent Skills with code execution run in a container with `python-docx` and `pypdf` preinstalled, so the pipeline produces an actual `.docx` or PDF rather than handing back prose to reformat by hand.
- **It composes with stored state.** The JD snapshot (§5) and the resume version history are already in the database, so tailoring reads structured inputs instead of asking the user to paste anything.

Pipeline: JD snapshot + selected base resume → gap analysis against the JD's stated requirements → rewritten bullets with keyword coverage → rendered file → stored as a new `resume_versions` row linked to the application. The version link is what makes it useful later: when a recruiter replies, the exact document they received is known.

This is the paid-tier feature in §7's cost model.

---

## 13. Out of scope for now

**Job discovery.** Aggregated search across boards is a materially different product with a much larger scraping surface and far more legal exposure. If added later, it belongs as a separate module feeding the same schema, and Firecrawl or Apify are the right tools for it.

**Everything in §8's "what not to build yet."**
