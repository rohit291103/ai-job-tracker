import { timingSafeEqual } from "node:crypto";
import { ingestEmail, type IngestResult } from "@/lib/pipeline";
import type { InboundEmail } from "@/lib/templates";

export const runtime = "nodejs";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = process.env.INGEST_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  // timingSafeEqual throws on length mismatch, so check that separately.
  return a.length === b.length && timingSafeEqual(a, b);
}

function isInboundEmail(v: unknown): v is InboundEmail {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e["messageId"] === "string" &&
    typeof e["threadId"] === "string" &&
    typeof e["from"] === "string" &&
    typeof e["subject"] === "string" &&
    typeof e["date"] === "string" &&
    typeof e["body"] === "string" &&
    !Number.isNaN(Date.parse(e["date"] as string))
  );
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const userId = process.env.DEFAULT_USER_ID;
  if (!userId) {
    return Response.json({ error: "DEFAULT_USER_ID is not set" }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const raw = (body as { emails?: unknown })?.emails;
  if (!Array.isArray(raw)) {
    return Response.json({ error: "expected { emails: [...] }" }, { status: 400 });
  }
  if (raw.length > 100) {
    return Response.json({ error: "max 100 emails per request" }, { status: 413 });
  }

  const emails = raw.filter(isInboundEmail);
  const rejected = raw.length - emails.length;

  // Sequential rather than concurrent: ordering matters when two messages in
  // the same thread arrive in one batch, since the second one resolves against
  // the application the first one created.
  const results: IngestResult[] = [];
  for (const email of emails) {
    try {
      results.push(await ingestEmail(userId, email));
    } catch (err) {
      results.push({
        status: "unparsed",
        messageId: email.messageId,
        rawEventId: `error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  return Response.json({ received: raw.length, rejected, counts, results });
}
