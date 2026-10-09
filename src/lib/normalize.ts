/**
 * Normalization for entity resolution (ARCHITECTURE.md section 4).
 *
 * The matching key is company root domain + normalized title + a date window.
 * Everything here is pure and dependency-free so it can be unit tested without
 * a database, and so the same functions can run in the extension later.
 */

/**
 * Legal-form suffixes stripped from the end of a company name, repeatedly.
 * Deliberately excludes descriptive words like "technologies" or "labs": those
 * distinguish real companies from each other, and collapsing them would merge
 * entities that are genuinely different.
 */
const LEGAL_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "llp", "ltd", "limited", "pvt", "private",
  "corp", "corporation", "co", "company", "gmbh", "plc", "sa", "nv", "ag",
  "bv", "oy", "ab", "as", "pte", "sdn", "bhd", "srl", "spa", "kk",
]);

/**
 * Multi-part public suffixes. This is a pragmatic subset, not the full Public
 * Suffix List — it covers the domains that actually show up in job mail. A
 * wrong answer here means a company is keyed by the wrong domain, so if this
 * starts mattering, swap in a real PSL library rather than extending the list
 * indefinitely.
 */
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "co.in", "net.in", "org.in", "ac.in", "com.au",
  "net.au", "co.nz", "co.jp", "co.kr", "com.br", "com.mx", "co.za", "com.sg",
  "com.hk", "com.tr", "co.il", "com.cn",
]);

/**
 * Domains belonging to ATSs, job boards and aggregators. A confirmation email
 * from greenhouse.io is about a job at some company — it is not a job at
 * Greenhouse. Treating these as the company domain is the single most likely
 * way to corrupt the company table, so they are excluded explicitly.
 */
const ATS_AND_BOARD_DOMAINS = new Set([
  "greenhouse.io", "greenhouse-mail.io", "lever.co", "hire.lever.co",
  "ashbyhq.com", "myworkday.com", "myworkdayjobs.com", "workday.com",
  "smartrecruiters.com", "icims.com", "taleo.net", "successfactors.com",
  "workable.com", "workablemail.com", "recruitee.com", "jazzhr.com",
  "bamboohr.com", "breezy.hr", "teamtailor.com", "personio.de", "rippling.com",
  "dover.com", "jobvite.com", "hiringthing.com", "pinpointhq.com",
  "linkedin.com", "indeed.com", "indeedemail.com", "naukri.com", "info.naukri.com",
  "glassdoor.com", "monster.com", "monsterindia.com", "ziprecruiter.com",
  "shine.com", "instahyre.com", "cutshort.io", "hirist.com", "wellfound.com",
  "angel.co", "ycombinator.com", "gmail.com", "googlemail.com", "outlook.com",
  "hotmail.com", "yahoo.com",
]);

/** Common abbreviations in job titles, matched only as whole words. */
const TITLE_ALIASES: Record<string, string> = {
  sr: "senior",
  snr: "senior",
  jr: "junior",
  mgr: "manager",
  engr: "engineer",
  swe: "software engineer",
  sde: "software engineer",
};

/**
 * Collapses a company's display name to a comparison key.
 * "Acme Inc.", "ACME Private Limited" and "Acme  Co" all become "acme".
 */
export function normalizeCompanyName(raw: string): string {
  let s = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Strip legal suffixes from the end, repeatedly, but never to empty — a
  // company named "Limited" keeps its name.
  let tokens = s.split(" ").filter(Boolean);
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]!;
    if (!LEGAL_SUFFIXES.has(last)) break;
    tokens = tokens.slice(0, -1);
  }
  return tokens.join(" ");
}

/** Extracts the host from an email address or a URL. Returns null if neither. */
export function hostFrom(input: string): string | null {
  const trimmed = input.trim();

  // "Display Name <addr@host>" or a bare address.
  const addr = /<([^>]+)>/.exec(trimmed)?.[1] ?? trimmed;
  if (addr.includes("@")) {
    const host = addr.split("@").pop()?.toLowerCase().trim();
    return host && host.includes(".") ? host.replace(/[>.,;]+$/, "") : null;
  }

  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return url.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Reduces a host to its registrable domain. "careers.acme.co.in" -> "acme.co.in" */
export function rootDomain(host: string): string | null {
  const parts = host.toLowerCase().replace(/^\.+|\.+$/g, "").split(".").filter(Boolean);
  if (parts.length < 2) return null;

  const lastTwo = parts.slice(-2).join(".");
  const take = MULTI_PART_SUFFIXES.has(lastTwo) ? 3 : 2;
  if (parts.length < take) return null;
  return parts.slice(-take).join(".");
}

/** True if the domain belongs to an ATS, job board or consumer mail provider. */
export function isAtsOrBoardDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (ATS_AND_BOARD_DOMAINS.has(d)) return true;
  const root = rootDomain(d);
  return root !== null && ATS_AND_BOARD_DOMAINS.has(root);
}

/**
 * The company root domain for an email, or null when the sender is an ATS,
 * board or consumer mail provider and therefore says nothing about the company.
 */
export function companyDomainFromSender(from: string): string | null {
  const host = hostFrom(from);
  if (!host) return null;
  const root = rootDomain(host);
  if (!root || isAtsOrBoardDomain(root)) return null;
  return root;
}

/**
 * Collapses a job title to a comparison key.
 *
 * Strips bracketed content and requisition ids, expands common abbreviations,
 * and normalizes whitespace. Deliberately keeps everything after a dash: a
 * trailing segment is as likely to be meaningful ("Engineer - Backend") as it
 * is to be a location ("Engineer - Bangalore"), and dropping the meaningful
 * case silently merges distinct roles. The trigram index on normalized_title
 * absorbs the resulting fuzziness instead.
 */
export function normalizeTitle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")          // (Remote), (R12345)
    .replace(/\[[^\]]*\]/g, " ")         // [JR-1234]
    .replace(/\b(?:req|job|requisition)\s*(?:id|no|number)?[-#:\s]*\d{3,}\b/g, " ")
    .replace(/\b[a-z]{0,3}[-#]?\d{4,}\b/g, " ")  // R12345, JR-99812, #4839
    .replace(/[^a-z0-9+#\s]/g, " ")      // keep + and # for "C++", "C#"
    .split(/\s+/)
    // Drop tokens left holding only punctuation, e.g. the "#" stranded after a
    // requisition number is stripped out of "Senior SDE #4839".
    .filter((t) => /[a-z0-9]/.test(t))
    .map((t) => TITLE_ALIASES[t] ?? t)
    .join(" ")
    .trim();
}
