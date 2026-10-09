/**
 * Deterministic template matching for application email.
 *
 * ATS confirmations are templated, so most mail can be parsed with no model
 * call at all. ARCHITECTURE.md section 7 depends on this: it is the difference
 * between roughly $510/month and under $100/month in classification cost at
 * 1,000 users, and it removes latency and a failure mode from the common path.
 *
 * ---------------------------------------------------------------------------
 * THESE PATTERNS ARE A STARTING POINT, NOT VALIDATED GROUND TRUTH.
 *
 * They are written from the general shape of ATS mail, not measured against a
 * real corpus. Expect both misses and false positives until they have been run
 * over an actual inbox. A false positive is the worse failure — it invents an
 * application that does not exist — so the content rules below are deliberately
 * narrow, and anything unmatched falls through to the model rather than being
 * guessed at here.
 *
 * The fix path is built in: every message is archived in `raw_events`, so
 * tightening a pattern means replaying history, not losing it.
 * ---------------------------------------------------------------------------
 */
import { hostFrom } from "./normalize";


export type EventTypeName =
  | "applied"
  | "confirmation_received"
  | "recruiter_outreach"
  | "assessment_sent"
  | "interview_invite"
  | "interview_scheduled"
  | "rejected"
  | "offer"
  | "withdrawn"
  | "note";

/** The payload the Apps Script ingester sends. Mirrored in apps-script/Code.gs. */
export type InboundEmail = {
  messageId: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  /** ISO 8601. */
  date: string;
  /** Plain text, truncated by the sender. */
  body: string;
};

export type TemplateMatch = {
  ats: string | null;
  company: string | null;
  title: string | null;
  eventType: EventTypeName;
  /** Which rule fired. Kept on the event for debugging and for eval sets. */
  matchedBy: string;
};

export const PARSER_VERSION = "templates@1";

/** Trailing punctuation and stray quoting on an extracted name. */
function clean(value: string | undefined): string | null {
  if (!value) return null;
  const s = value
    .trim()
    .replace(/^["'`(\[]+|["'`)\]]+$/g, "")
    .replace(/[!.,;:\s]+$/g, "")
    .trim();
  return s.length > 0 && s.length < 200 ? s : null;
}

/**
 * ATS confirmation templates. A match here establishes that an application
 * exists, which is why these emit `applied` rather than `confirmation_received`
 * — for anything not captured by the extension, this email *is* how the
 * application is discovered.
 */
const ATS_TEMPLATES: ReadonlyArray<{
  id: string;
  ats: string;
  /** Matched against the host extracted from the From header. */
  host: RegExp;
  subject: RegExp;
}> = [
  {
    id: "greenhouse.confirmation",
    ats: "greenhouse",
    host: /(?:^|\.)(?:greenhouse\.io|greenhouse-mail\.io)$/i,
    subject: /^(?:thank you for applying to|your application to)\s+(?<company>.+?)$/i,
  },
  {
    id: "lever.confirmation",
    ats: "lever",
    host: /(?:^|\.)lever\.co$/i,
    subject:
      /^(?:thank you for applying to\s+(?<company>.+?)|(?<company2>.+?)\s+application (?:received|confirmation))$/i,
  },
  {
    id: "ashby.confirmation",
    ats: "ashby",
    host: /(?:^|\.)ashbyhq\.com$/i,
    subject: /^(?:thank you for applying to|application received[—\-:]?\s*)\s*(?<company>.+?)$/i,
  },
  {
    id: "workday.confirmation",
    ats: "workday",
    host: /(?:^|\.)(?:myworkday\.com|myworkdayjobs\.com|workday\.com)$/i,
    subject: /(?:thank you for (?:your interest|applying)|application received)(?:\s+(?:in|to|at)\s+(?<company>.+?))?$/i,
  },
  {
    id: "smartrecruiters.confirmation",
    ats: "smartrecruiters",
    host: /(?:^|\.)smartrecruiters\.com$/i,
    subject: /^(?:thank you for applying to|application received at)\s+(?<company>.+?)$/i,
  },
  {
    id: "linkedin.easy_apply",
    ats: "linkedin",
    host: /(?:^|\.)linkedin\.com$/i,
    subject: /^your application was sent to\s+(?<company>.+?)$/i,
  },
  {
    id: "indeed.apply",
    ats: "indeed",
    host: /(?:^|\.)(?:indeed\.com|indeedemail\.com)$/i,
    subject:
      /^(?:you(?:'ve| have)? applied to\s+(?<title>.+?)\s+at\s+(?<company>.+?)|indeed application:\s*(?<title2>.+?))$/i,
  },
  {
    id: "naukri.apply",
    ats: "naukri",
    host: /(?:^|\.)naukri\.com$/i,
    // Naukri sends very high volumes of alerts and mailers, so this requires an
    // explicit application confirmation rather than matching the sender alone.
    subject: /^(?:your (?:application|profile) (?:has been )?(?:sent|applied|submitted)|applied successfully)(?:\s+(?:to|for)\s+(?<company>.+?))?$/i,
  },
];

/**
 * Sender-agnostic content rules for follow-up mail, in precedence order.
 * First match wins, and the order is load-bearing: a rejection sent after an
 * interview mentions the interview, so `rejected` must be tested before
 * `interview_invite` or the status would walk backwards.
 */
const CONTENT_RULES: ReadonlyArray<{ id: string; eventType: EventTypeName; pattern: RegExp }> = [
  {
    id: "content.rejected",
    eventType: "rejected",
    pattern:
      /\b(?:regret to inform|decided (?:not to (?:move|proceed)|to move forward with other)|moving forward with other candidates|will not be (?:moving forward|proceeding)|not (?:be )?selected for|unfortunately,? (?:we|after)|no longer under consideration|pursue other candidates)\b/i,
  },
  {
    id: "content.offer",
    eventType: "offer",
    pattern: /\b(?:pleased to (?:extend|offer)|offer of employment|formal offer|we(?:'d| would) like to offer you)\b/i,
  },
  {
    id: "content.assessment",
    eventType: "assessment_sent",
    pattern:
      /\b(?:hackerrank|codility|codesignal|karat|coderbyte|take[- ]home (?:test|assignment|exercise)|coding (?:challenge|assessment|test)|online assessment)\b/i,
  },
  {
    id: "content.interview_scheduled",
    eventType: "interview_scheduled",
    pattern: /\b(?:interview (?:is )?(?:confirmed|scheduled)|calendar invite|your interview on)\b/i,
  },
  {
    id: "content.interview_invite",
    eventType: "interview_invite",
    pattern:
      /\b(?:(?:like|love) to (?:schedule|set up|arrange)|invite you to (?:an? )?(?:interview|conversation)|share your availability|your availability for (?:a|an)|move(?:ing)? (?:you )?(?:forward|to the next)|next (?:round|stage|step)s?)\b/i,
  },
];

/**
 * Parses an inbound email deterministically, or returns null to hand it to the
 * model. Null is the correct answer for anything ambiguous — see the header.
 */
export function matchTemplate(email: InboundEmail): TemplateMatch | null {
  const subject = email.subject.trim();
  // The raw From header is often "Display Name <addr@host>", so match on the
  // extracted host rather than the header text.
  const host = hostFrom(email.from);

  for (const tpl of ATS_TEMPLATES) {
    if (!host || !tpl.host.test(host)) continue;
    const m = tpl.subject.exec(subject);
    if (!m) continue;
    const g = m.groups ?? {};
    return {
      ats: tpl.ats,
      company: clean(g["company"] ?? g["company2"]),
      title: clean(g["title"] ?? g["title2"]),
      eventType: "applied",
      matchedBy: tpl.id,
    };
  }

  // Follow-up mail. Subject and body are tested together because the signal
  // lands in either depending on the sender.
  const haystack = `${subject}\n${email.body}`;
  for (const rule of CONTENT_RULES) {
    if (rule.pattern.test(haystack)) {
      return {
        ats: null,
        company: null,
        title: null,
        eventType: rule.eventType,
        matchedBy: rule.id,
      };
    }
  }

  return null;
}
