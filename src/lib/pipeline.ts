/**
 * Ingestion pipeline: one inbound email in, at most one application and one
 * event out. ARCHITECTURE.md sections 2, 4 and 5.
 *
 * Ordering principle throughout: archive the raw payload before interpreting
 * anything. If parsing fails or a pattern turns out to be wrong, the message is
 * still on disk and can be replayed.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { applications, events, jobDescriptions, rawEvents } from "../db/schema";
import { companyNameFromSlug, detectAtsPage, type CapturePayload } from "./capture";
import { classifyEmail } from "./classify";
import { companyDomainFromSender, normalizeTitle } from "./normalize";
import { resolveApplication, resolveCompany } from "./resolve";
import { matchTemplate, PARSER_VERSION, type InboundEmail } from "./templates";

/** Bumped when capture handling changes, so archived payloads can be replayed. */
export const CAPTURE_VERSION = "capture@1";

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

export type CaptureResult =
  /** Already ingested. Re-sending the same captureId is safe. */
  | { status: "duplicate"; captureId: string }
  /** Recognized nothing usable — no company to attach it to. Archived for review. */
  | { status: "unparsed"; captureId: string; rawEventId: string }
  | {
      status: "ingested";
      captureId: string;
      rawEventId: string;
      applicationId: string;
      matchedBy: string;
      createdApplication: boolean;
    };

/**
 * Ingests a browser-extension capture (ARCHITECTURE.md section 3).
 *
 * Differs from ingestEmail in three ways, each for a reason:
 *
 * 1. No classification step. An email has to be interpreted; a capture already
 *    knows what it is, so there is nothing for a template or the model to do.
 * 2. Entity resolution runs without its single-open-application fallback. See
 *    resolveApplication — a capture is a new submission, so the correct answer
 *    when nothing matches is a new row, not the nearest open one.
 * 3. It writes `external_url` and the JD snapshot, which is the metadata the
 *    extension exists to add. The email channel cannot see either.
 */
export async function ingestCapture(
  userId: string,
  capture: CapturePayload,
): Promise<CaptureResult> {
  const occurredAt = new Date(capture.capturedAt);

  // 1. Archive first, deduplicating on the capture id the extension generated.
  const inserted = await db
    .insert(rawEvents)
    .values({
      userId,
      channel: "extension",
      externalId: capture.captureId,
      payload: capture,
      receivedAt: occurredAt,
    })
    .onConflictDoNothing()
    .returning({ id: rawEvents.id });

  const rawEventId = inserted[0]?.id;
  if (!rawEventId) return { status: "duplicate", captureId: capture.captureId };

  // 2. Company. The ATS slug is not a domain, so this is a name match only —
  //    the confirmation email arrives with a real sender domain and resolves
  //    the same company properly, which is what merges the two.
  const page = detectAtsPage(capture.url);
  const company = capture.company ?? companyNameFromSlug(page?.companySlug ?? null);
  const companyId = await resolveCompany({ name: company, domain: null });

  if (!companyId) {
    await db
      .update(rawEvents)
      .set({ parsedAt: new Date(), parserVersion: CAPTURE_VERSION, parseError: "no-company" })
      .where(eq(rawEvents.id, rawEventId));
    return { status: "unparsed", captureId: capture.captureId, rawEventId };
  }

  const existing = await resolveApplication({
    userId,
    threadId: null,
    companyId,
    title: capture.title,
    occurredAt,
    allowSingleOpenFallback: false,
  });

  let applicationId: string;
  let createdApplication = false;

  if (existing) {
    applicationId = existing.applicationId;
    // The extension knows the URL and the email does not, so fill it in if the
    // application was created from mail. Never overwrite one already recorded.
    await db
      .update(applications)
      .set({ externalUrl: capture.url, updatedAt: new Date() })
      .where(and(eq(applications.id, applicationId), isNull(applications.externalUrl)));
  } else {
    const title = capture.title ?? "(role not captured)";
    const created = await db
      .insert(applications)
      .values({
        userId,
        companyId,
        title,
        normalizedTitle: normalizeTitle(title),
        source: "extension",
        ats: capture.ats ?? page?.ats ?? null,
        externalUrl: capture.url,
        appliedAt: occurredAt,
      })
      .returning({ id: applications.id });
    applicationId = created[0]!.id;
    createdApplication = true;
  }

  // 3. The JD snapshot, which only the extension can see — the confirmation
  //    email never contains it and the posting may be taken down later.
  if (capture.jobDescription && capture.jobDescription.trim().length > 0) {
    await db.insert(jobDescriptions).values({
      applicationId,
      text: capture.jobDescription.slice(0, 100_000),
      capturedAt: occurredAt,
    });
  }

  // 4. Append the event only when this capture created the application.
  //    A capture that matched an existing row is the same submission arriving
  //    twice, and a second `applied` event would double-count it in the funnel.
  if (createdApplication) {
    await db.insert(events).values({
      userId,
      applicationId,
      type: "applied",
      occurredAt,
      source: "extension",
      rawEventId,
      summary: `${capture.trigger} capture: ${capture.url}`.slice(0, 500),
    });
  }

  await db
    .update(rawEvents)
    .set({ parsedAt: new Date(), parserVersion: CAPTURE_VERSION, applicationId })
    .where(eq(rawEvents.id, rawEventId));

  return {
    status: "ingested",
    captureId: capture.captureId,
    rawEventId,
    applicationId,
    matchedBy: existing?.matchedBy ?? "new",
    createdApplication,
  };
}
