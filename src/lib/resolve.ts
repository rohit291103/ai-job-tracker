/**
 * Entity resolution (ARCHITECTURE.md section 4).
 *
 * The hard problem is not capture, it is collapsing the same application
 * arriving from two or three sources into one record. Matching is ordered from
 * most to least certain, and the last resort is to give up rather than guess:
 * an unresolved event is recoverable, a wrong merge corrupts history.
 */
import { and, desc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "../db/client";
import { applications, companies, rawEvents } from "../db/schema";
import { normalizeCompanyName, normalizeTitle } from "./normalize";

/** The ±7 day window from section 4. */
const MATCH_WINDOW_DAYS = 7;

/**
 * Finds or creates a company. Root domain is the identity when known, because
 * display names vary ("Acme Inc.", "Acme Corp") while the domain does not.
 * Falls back to the normalized name when no domain is available.
 */
export async function resolveCompany(input: {
  name: string | null;
  domain: string | null;
}): Promise<string | null> {
  const { name, domain } = input;
  if (!name && !domain) return null;

  if (domain) {
    const existing = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.rootDomain, domain))
      .limit(1);
    if (existing[0]) return existing[0].id;
  }

  const normalized = name ? normalizeCompanyName(name) : null;
  if (normalized) {
    const byName = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.normalizedName, normalized))
      .limit(1);
    // Only reuse a name match when we have no domain to contradict it. Two
    // different companies can normalize to the same name; the domain wins.
    if (byName[0] && !domain) return byName[0].id;
  }

  const inserted = await db
    .insert(companies)
    .values({
      name: name ?? domain!,
      normalizedName: normalized ?? normalizeCompanyName(domain!),
      rootDomain: domain,
    })
    .onConflictDoNothing({ target: companies.rootDomain })
    .returning({ id: companies.id });

  if (inserted[0]) return inserted[0].id;

  // Lost an insert race on the domain unique index; read the winner.
  if (domain) {
    const raced = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.rootDomain, domain))
      .limit(1);
    return raced[0]?.id ?? null;
  }
  return null;
}

/**
 * Finds the application a follow-up event belongs to.
 *
 * Tier 1 — same mail thread. The strongest signal available and effectively
 * free: a recruiter replying in the thread that carried the confirmation is
 * unambiguously the same application. Tried first for exactly that reason.
 *
 * Tier 2 — company plus a title match inside the date window.
 *
 * Tier 3 — company alone, most recently updated application that is still
 * open. Only used when the company has exactly one open application, since
 * picking between several would be a guess.
 */
export async function resolveApplication(input: {
  userId: string;
  threadId: string | null;
  companyId: string | null;
  title: string | null;
  occurredAt: Date;
}): Promise<{ applicationId: string; matchedBy: string } | null> {
  const { userId, threadId, companyId, title, occurredAt } = input;

  if (threadId) {
    const byThread = await db
      .select({ applicationId: rawEvents.applicationId })
      .from(rawEvents)
      .where(
        and(
          eq(rawEvents.userId, userId),
          isNotNull(rawEvents.applicationId),
          sql`${rawEvents.payload} ->> 'threadId' = ${threadId}`,
        ),
      )
      .orderBy(desc(rawEvents.receivedAt))
      .limit(1);
    const hit = byThread[0]?.applicationId;
    if (hit) return { applicationId: hit, matchedBy: "thread" };
  }

  if (!companyId) return null;

  const windowStart = new Date(occurredAt.getTime() - MATCH_WINDOW_DAYS * 86_400_000);
  const windowEnd = new Date(occurredAt.getTime() + MATCH_WINDOW_DAYS * 86_400_000);

  if (title) {
    const normalized = normalizeTitle(title);
    const byTitle = await db
      .select({ id: applications.id })
      .from(applications)
      .where(
        and(
          eq(applications.userId, userId),
          eq(applications.companyId, companyId),
          eq(applications.normalizedTitle, normalized),
          gte(applications.appliedAt, windowStart),
          lte(applications.appliedAt, windowEnd),
        ),
      )
      .orderBy(desc(applications.appliedAt))
      .limit(1);
    if (byTitle[0]) return { applicationId: byTitle[0].id, matchedBy: "company+title+window" };
  }

  const open = await db
    .select({ id: applications.id })
    .from(applications)
    .where(
      and(
        eq(applications.userId, userId),
        eq(applications.companyId, companyId),
        sql`${applications.currentStatus} not in ('rejected', 'withdrawn', 'offer')`,
      ),
    )
    .orderBy(desc(applications.updatedAt))
    .limit(2);

  // Exactly one open application at this company, or it would be a guess.
  if (open.length === 1 && open[0]) {
    return { applicationId: open[0].id, matchedBy: "company+single-open" };
  }

  return null;
}
