/**
 * Ingestion pipeline: one inbound email in, at most one application and one
 * event out. ARCHITECTURE.md sections 2, 4 and 5.
 *
 * Ordering principle throughout: archive the raw payload before interpreting
 * anything. If parsing fails or a pattern turns out to be wrong, the message is
 * still on disk and can be replayed.
 */
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { applications, events, rawEvents } from "../db/schema";
import { classifyEmail } from "./classify";
import { companyDomainFromSender, normalizeTitle } from "./normalize";
import { resolveApplication, resolveCompany } from "./resolve";
import { matchTemplate, PARSER_VERSION, type InboundEmail } from "./templates";

export type IngestResult =
  /** Already ingested. The Apps Script poller is safe to re-send. */
  | { status: "duplicate"; messageId: string }
  /** Neither templates nor the model recognized it. Archived for review. */
  | { status: "unparsed"; messageId: string; rawEventId: string }
  /** Understood, but no application to attach it to. Archived for review. */
  | { status: "orphan"; messageId: string; rawEventId: string; eventType: string }
  | {
      status: "ingested";
      messageId: string;
      rawEventId: string;
      applicationId: string;
      eventType: string;
      matchedBy: string;
      createdApplication: boolean;
    };

export async function ingestEmail(userId: string, email: InboundEmail): Promise<IngestResult> {
  // 1. Archive first, deduplicating on the provider's message id.
  const inserted = await db
    .insert(rawEvents)
    .values({
      userId,
      channel: "apps_script",
      externalId: email.messageId,
      payload: email,
      receivedAt: new Date(email.date),
    })
    .onConflictDoNothing()
    .returning({ id: rawEvents.id });

  const rawEventId = inserted[0]?.id;
  if (!rawEventId) return { status: "duplicate", messageId: email.messageId };

  // 2. Deterministic first, model only as fallback (section 7).
  const match = matchTemplate(email) ?? (await classifyEmail(email));

  if (!match) {
    await db
      .update(rawEvents)
      .set({ parsedAt: new Date(), parserVersion: PARSER_VERSION, parseError: "unrecognized" })
      .where(eq(rawEvents.id, rawEventId));
    return { status: "unparsed", messageId: email.messageId, rawEventId };
  }

  // 3. Company. The sender domain is only usable when it is not an ATS or
  //    board, which companyDomainFromSender already enforces.
  const companyId = await resolveCompany({
    name: match.company,
    domain: companyDomainFromSender(email.from),
  });

  const occurredAt = new Date(email.date);

  // 4. Attach to an application, creating one only for `applied`.
  const existing = await resolveApplication({
    userId,
    threadId: email.threadId,
    companyId,
    title: match.title,
    occurredAt,
  });

  let applicationId: string;
  let createdApplication = false;

  if (existing) {
    applicationId = existing.applicationId;
  } else if (match.eventType === "applied") {
    // Titles are sometimes absent from confirmation mail. A placeholder is
    // better than deriving one from the subject line, which reads as a title
    // but is not one.
    const title = match.title ?? "(role not captured)";
    const created = await db
      .insert(applications)
      .values({
        userId,
        companyId,
        title,
        normalizedTitle: normalizeTitle(title),
        source: "email",
        ats: match.ats,
        appliedAt: occurredAt,
      })
      .returning({ id: applications.id });
    applicationId = created[0]!.id;
    createdApplication = true;
  } else {
    // Understood the message but cannot say which application it belongs to.
    // Recorded rather than attached to a guess.
    await db
      .update(rawEvents)
      .set({
        parsedAt: new Date(),
        parserVersion: PARSER_VERSION,
        parseError: `unresolved:${match.eventType}`,
      })
      .where(eq(rawEvents.id, rawEventId));
    return {
      status: "orphan",
      messageId: email.messageId,
      rawEventId,
      eventType: match.eventType,
    };
  }

  // 5. Append the event. The database trigger recomputes the derived status.
  await db.insert(events).values({
    userId,
    applicationId,
    type: match.eventType,
    occurredAt,
    source: "email",
    rawEventId,
    summary: `${match.matchedBy}: ${email.subject}`.slice(0, 500),
  });

  await db
    .update(rawEvents)
    .set({ parsedAt: new Date(), parserVersion: PARSER_VERSION, applicationId })
    .where(eq(rawEvents.id, rawEventId));

  return {
    status: "ingested",
    messageId: email.messageId,
    rawEventId,
    applicationId,
    eventType: match.eventType,
    matchedBy: existing ? `${match.matchedBy}|${existing.matchedBy}` : match.matchedBy,
    createdApplication,
  };
}
