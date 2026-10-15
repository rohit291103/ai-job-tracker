import { authorized } from "@/lib/auth";
import { isCapturePayload } from "@/lib/capture";
import { ingestCapture, type CaptureResult } from "@/lib/pipeline";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * The extension runs on a chrome-extension:// origin, and sending JSON with an
 * Authorization header triggers a CORS preflight. Allowing any origin is safe
 * here only because authentication is a bearer secret and nothing is
 * cookie-based: a hostile page gains nothing by being allowed to ask.
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Max-Age": "86400",
} as const;

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: CORS });

export async function POST(req: Request) {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);

  const userId = process.env.DEFAULT_USER_ID;
  if (!userId) return json({ error: "DEFAULT_USER_ID is not set" }, 500);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const raw = (body as { captures?: unknown })?.captures;
  if (!Array.isArray(raw)) return json({ error: "expected { captures: [...] }" }, 400);
  if (raw.length > 50) return json({ error: "max 50 captures per request" }, 413);

  const captures = raw.filter(isCapturePayload);
  const rejected = raw.length - captures.length;

  // Sequential for the same reason as /api/ingest: two captures of the same
  // application in one batch must see each other's work to resolve as one row.
  const results: CaptureResult[] = [];
  for (const capture of captures) {
    try {
      results.push(await ingestCapture(userId, capture));
    } catch (err) {
      results.push({
        status: "unparsed",
        captureId: capture.captureId,
        rawEventId: `error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  return json({ received: raw.length, rejected, counts, results }, 200);
}
