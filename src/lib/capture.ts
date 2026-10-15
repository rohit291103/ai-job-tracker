/**
 * Extension capture: URL recognition, title cleanup, and the payload contract.
 *
 * Pure and dependency-free, like normalize.ts, because this module is imported
 * by both the server and the extension bundle. Nothing here may import the
 * database or any Node built-in.
 *
 * Design reference: ARCHITECTURE.md section 3.
 *
 * ── On the submit-endpoint heuristic ────────────────────────────────────────
 * `isSubmitEndpoint` is a HEURISTIC AND IS NOT VERIFIED against a real
 * submission on any of these platforms. ARCHITECTURE.md section 3 is explicit
 * that each endpoint is found by watching DevTools during a real submit, and
 * that has not been done yet.
 *
 * Until it has, the manual capture button is the reliable path and interception
 * is best-effort. Two things keep a false positive from being expensive: the
 * same application also arrives by confirmation email, so entity resolution
 * collapses the pair rather than inventing a second record; and a capture only
 * fires on a 2xx response from a known ATS host.
 */

export type AtsName = "greenhouse" | "lever" | "ashby";

export type AtsPage = {
  ats: AtsName;
  /** The employer's slug in the ATS URL, null where the URL doesn't carry one. */
  companySlug: string | null;
  jobId: string | null;
};

/**
 * Hosts we act on at all. Deliberately a small, closed list: the extension
 * should be inert everywhere else, which is also what keeps the manifest's
 * permission list honest.
 */
const ATS_HOSTS: ReadonlyArray<{ suffix: string; ats: AtsName }> = [
  { suffix: "greenhouse.io", ats: "greenhouse" },
  { suffix: "lever.co", ats: "lever" },
  { suffix: "ashbyhq.com", ats: "ashby" },
];

export function atsForHost(host: string): AtsName | null {
  const h = host.toLowerCase();
  for (const { suffix, ats } of ATS_HOSTS) {
    if (h === suffix || h.endsWith(`.${suffix}`)) return ats;
  }
  return null;
}

/**
 * Recognizes a job or application page and pulls the employer slug out of it.
 *
 * All three platforms put the employer first in the path
 * (`/{company}/jobs/{id}` for Greenhouse, `/{company}/{id}` for Lever and
 * Ashby), which is why one shape covers them. Greenhouse's embedded form is the
 * exception — `/embed/job_app?token=…` names no company, so the slug is null
 * and the company has to come from the page or from the confirmation email.
 */
export function detectAtsPage(rawUrl: string): AtsPage | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const ats = atsForHost(url.hostname);
  if (!ats) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  // Greenhouse's embedded application form carries no employer in the path.
  if (segments[0] === "embed") return { ats, companySlug: null, jobId: null };

  const companySlug = segments[0]!.toLowerCase();
  const jobId = ats === "greenhouse" ? (segments[2] ?? null) : (segments[1] ?? null);

  return { ats, companySlug, jobId: jobId && /^[a-z0-9-]+$/i.test(jobId) ? jobId : null };
}

/** "acme-corp" → "Acme Corp". A readable starting point; the email usually supplies the real name. */
export function companyNameFromSlug(slug: string | null): string | null {
  if (!slug) return null;
  const words = slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.length > 0 ? words.join(" ") : null;
}

const TITLE_PREFIXES = [/^job application for\s+/i, /^apply(?:\s+now)?(?:\s+for)?\s*[:—-]\s*/i];

/**
 * Turns a page title into a role title.
 *
 * Greenhouse sets `document.title` to "Job Application for {Title} at
 * {Company}", and the others use a separator between role and employer. Both
 * the known prefix and a trailing or leading company name are stripped; what is
 * left is the role.
 *
 * When the company name isn't known, separators are left alone on purpose:
 * "Engineer - Backend" and "Engineer - Acme" are indistinguishable without it,
 * and cutting would throw away a real part of the title. Same reasoning as
 * normalizeTitle's refusal to split on a dash.
 */
export function cleanJobTitle(pageTitle: string, company: string | null): string | null {
  let title = pageTitle.trim();
  if (!title) return null;

  for (const prefix of TITLE_PREFIXES) title = title.replace(prefix, "").trim();

  if (company) {
    const escaped = company.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    title = title
      .replace(new RegExp(`\\s*[-–—|@·]\\s*${escaped}\\s*$`, "i"), "")
      .replace(new RegExp(`\\s+at\\s+${escaped}\\s*$`, "i"), "")
      .replace(new RegExp(`^\\s*${escaped}\\s*[-–—|@·:]\\s*`, "i"), "")
      .trim();
  }

  title = title.replace(/\s+/g, " ").trim();
  if (title.length === 0) return null;

  // A title that is only the employer's name carries no role — Lever and Ashby
  // both show exactly that while the page is still loading. Returning it would
  // create an application titled after the company, so give up instead and let
  // the pipeline's placeholder stand until the confirmation email supplies one.
  if (company && title.toLowerCase() === company.trim().toLowerCase()) return null;

  return title;
}

const SUBMIT_PATH = /(application|apply|submit|job_app)/i;

/** See the heuristic warning in this file's header before trusting this. */
export function isSubmitEndpoint(rawUrl: string, method: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (!atsForHost(url.hostname)) return false;
  return SUBMIT_PATH.test(url.pathname);
}

/** What the extension POSTs to /api/capture. Mirrored by isCapturePayload below. */
export type CapturePayload = {
  /** Generated in the extension; the idempotency key for raw_events. */
  captureId: string;
  trigger: "intercept" | "manual";
  url: string;
  ats: AtsName | null;
  company: string | null;
  title: string | null;
  /** ISO 8601. */
  capturedAt: string;
  jobDescription?: string | null;
};

export function isCapturePayload(v: unknown): v is CapturePayload {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  const optionalString = (x: unknown) => x === null || x === undefined || typeof x === "string";
  return (
    typeof c["captureId"] === "string" &&
    c["captureId"].length > 0 &&
    (c["trigger"] === "intercept" || c["trigger"] === "manual") &&
    typeof c["url"] === "string" &&
    typeof c["capturedAt"] === "string" &&
    !Number.isNaN(Date.parse(c["capturedAt"])) &&
    optionalString(c["ats"]) &&
    optionalString(c["company"]) &&
    optionalString(c["title"]) &&
    optionalString(c["jobDescription"])
  );
}
