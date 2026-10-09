/**
 * Model fallback for mail the template matcher (templates.ts) could not parse.
 *
 * Haiku 4.5 per ARCHITECTURE.md section 7: this is the minority path by design,
 * so the cheap model is the right one. If this starts handling the majority of
 * mail, that is a signal to fix the templates, not to upgrade the model.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { EventTypeName, InboundEmail, TemplateMatch } from "./templates";

export const CLASSIFIER_VERSION = "haiku-4-5@1";

const EVENT_TYPES = [
  "applied",
  "confirmation_received",
  "recruiter_outreach",
  "assessment_sent",
  "interview_invite",
  "interview_scheduled",
  "rejected",
  "offer",
  "withdrawn",
  "note",
] as const;

const Classification = z.object({
  /**
   * False for newsletters, job alerts, marketing and anything else that is not
   * about a specific application of this person's. Checked first; everything
   * else is ignored when this is false.
   */
  isApplicationMail: z.boolean(),
  eventType: z.enum(EVENT_TYPES),
  company: z.string().nullable(),
  /** Employer's own domain if the mail states it. Never an ATS or board domain. */
  companyDomain: z.string().nullable(),
  title: z.string().nullable(),
  ats: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  /** One short sentence. Stored on the event, and useful when auditing misses. */
  reasoning: z.string(),
});

const SYSTEM = `You classify email related to a person's job applications.

Decide first whether the message concerns one specific job application of the
recipient's. Job alerts, recruiter mass-mailers, newsletters, marketing and
platform notifications are NOT application mail - set isApplicationMail to false
for them, even when they come from a job board.

Event types:
- applied: confirms the person submitted an application
- confirmation_received: acknowledges receipt without being the submission itself
- recruiter_outreach: a human reaching out about the role
- assessment_sent: a test, coding challenge or take-home was sent
- interview_invite: asks for availability or invites to interview
- interview_scheduled: an interview is confirmed with a time
- rejected: the application will not proceed
- offer: an offer is extended
- withdrawn: the person withdrew
- note: application mail that fits none of the above

Rules:
- A rejection sent after an interview is "rejected", not an interview event.
- company is the employer, never the ATS or job board. A Greenhouse email is
  about a job at some company; it is not a job at Greenhouse.
- companyDomain is the employer's own domain, or null. Never an ATS, job board
  or consumer mail domain.
- Use confidence "low" when genuinely unsure. Low-confidence results are
  discarded rather than written, so guessing is strictly worse than admitting
  uncertainty.`;

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

/**
 * Classifies an email, or returns null when it is not application mail or the
 * model is not confident. Null means "leave this unparsed for review" — the raw
 * payload is archived either way, so a miss is recoverable and a false positive
 * is not.
 */
export async function classifyEmail(email: InboundEmail): Promise<TemplateMatch | null> {
  const response = await anthropic().messages.parse({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: SYSTEM,
        // Stable across every call, so it belongs in the cached prefix with the
        // message last. Note this prompt is currently likely below the minimum
        // cacheable prefix length, so caching will only start paying off once
        // few-shot examples are added from the raw_events corpus.
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          `From: ${email.from}`,
          `Subject: ${email.subject}`,
          `Date: ${email.date}`,
          "",
          email.body.slice(0, 6000),
        ].join("\n"),
      },
    ],
    output_config: { format: zodOutputFormat(Classification) },
  });

  const parsed = response.parsed_output;
  if (!parsed) return null;
  if (!parsed.isApplicationMail) return null;
  if (parsed.confidence === "low") return null;

  return {
    ats: parsed.ats,
    company: parsed.company,
    title: parsed.title,
    eventType: parsed.eventType as EventTypeName,
    matchedBy: `model:${CLASSIFIER_VERSION}:${parsed.confidence}`,
  };
}
