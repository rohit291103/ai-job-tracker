import { timingSafeEqual } from "node:crypto";

/**
 * Bearer check for the ingestion endpoints.
 *
 * One shared secret, because both callers are things the user installs
 * themselves — the Apps Script and their own browser extension. Per-user
 * tokens become necessary the moment anyone else installs either one
 * (ARCHITECTURE.md section 8).
 */
export function authorized(req: Request): boolean {
  const secret = process.env.INGEST_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  // timingSafeEqual throws on length mismatch, so check that separately.
  return a.length === b.length && timingSafeEqual(a, b);
}
