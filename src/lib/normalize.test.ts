import { describe, expect, it } from "vitest";
import {
  companyDomainFromSender,
  hostFrom,
  isAtsOrBoardDomain,
  normalizeCompanyName,
  normalizeTitle,
  rootDomain,
} from "./normalize";

describe("normalizeCompanyName", () => {
  it("collapses legal-form variants of the same company", () => {
    expect(normalizeCompanyName("Acme Inc.")).toBe("acme");
    expect(normalizeCompanyName("ACME Private Limited")).toBe("acme");
    expect(normalizeCompanyName("Acme & Co")).toBe("acme");
    expect(normalizeCompanyName("  acme   corp  ")).toBe("acme");
  });

  it("keeps descriptive words that distinguish real companies", () => {
    // Stripping "technologies" would merge genuinely different entities.
    expect(normalizeCompanyName("Acme Technologies Pvt. Ltd.")).toBe("acme technologies");
    expect(normalizeCompanyName("Acme Labs")).toBe("acme labs");
  });

  it("never strips a name down to nothing", () => {
    expect(normalizeCompanyName("Limited")).toBe("limited");
    expect(normalizeCompanyName("Co")).toBe("co");
  });
});

describe("hostFrom", () => {
  it("reads a bare address, a display-name address and a URL", () => {
    expect(hostFrom("no-reply@greenhouse.io")).toBe("greenhouse.io");
    expect(hostFrom("Acme Careers <careers@acme.co.in>")).toBe("acme.co.in");
    expect(hostFrom("https://boards.greenhouse.io/acme/jobs/4839")).toBe("boards.greenhouse.io");
  });

  it("returns null for input that is neither", () => {
    expect(hostFrom("not an email!!")).toBeNull();
    expect(hostFrom("")).toBeNull();
  });
});

describe("rootDomain", () => {
  it("handles single-part suffixes", () => {
    expect(rootDomain("acme.com")).toBe("acme.com");
    expect(rootDomain("us.greenhouse-mail.io")).toBe("greenhouse-mail.io");
  });

  it("handles multi-part public suffixes", () => {
    expect(rootDomain("careers.acme.co.in")).toBe("acme.co.in");
    expect(rootDomain("acme.co.uk")).toBe("acme.co.uk");
  });

  it("returns null when there is no registrable domain", () => {
    expect(rootDomain("localhost")).toBeNull();
    expect(rootDomain("co.uk")).toBeNull();
  });
});

describe("isAtsOrBoardDomain", () => {
  it("recognizes ATS and board domains, including subdomains", () => {
    expect(isAtsOrBoardDomain("greenhouse.io")).toBe(true);
    expect(isAtsOrBoardDomain("boards.greenhouse.io")).toBe(true);
    expect(isAtsOrBoardDomain("hire.lever.co")).toBe(true);
    expect(isAtsOrBoardDomain("linkedin.com")).toBe(true);
    expect(isAtsOrBoardDomain("naukri.com")).toBe(true);
  });

  it("does not flag an actual employer domain", () => {
    expect(isAtsOrBoardDomain("acme.com")).toBe(false);
  });
});

describe("companyDomainFromSender", () => {
  it("returns the employer domain for mail from the company itself", () => {
    expect(companyDomainFromSender("jane@acme.com")).toBe("acme.com");
    expect(companyDomainFromSender("recruiting@careers.acme.co.in")).toBe("acme.co.in");
  });

  it("returns null for ATS and board senders", () => {
    // A Greenhouse confirmation is about a job at some company; it is not a job
    // at Greenhouse. Treating it as one would corrupt the company table.
    expect(companyDomainFromSender("no-reply@greenhouse.io")).toBeNull();
    expect(companyDomainFromSender("jobs-noreply@linkedin.com")).toBeNull();
    expect(companyDomainFromSender("someone@gmail.com")).toBeNull();
  });
});

describe("normalizeTitle", () => {
  it("expands abbreviations and normalizes whitespace", () => {
    expect(normalizeTitle("Senior Product Manager")).toBe("senior product manager");
    expect(normalizeTitle("Sr.  Product   Manager")).toBe("senior product manager");
    expect(normalizeTitle("Jr Data Analyst")).toBe("junior data analyst");
  });

  it("strips bracketed content and requisition ids", () => {
    expect(normalizeTitle("Sr. Product Manager (R12345)")).toBe("senior product manager");
    expect(normalizeTitle("Backend Engineer [JR-99812]")).toBe("backend engineer");
    expect(normalizeTitle("Data Scientist, Req ID 48392")).toBe("data scientist");
    expect(normalizeTitle("Senior SDE #4839")).toBe("senior software engineer");
  });

  it("preserves + and # so language names survive", () => {
    expect(normalizeTitle("C++ Developer")).toBe("c++ developer");
    expect(normalizeTitle("C# Engineer")).toBe("c# engineer");
  });

  it("deliberately keeps content after a dash", () => {
    // "Engineer - Backend" is as likely as "Engineer - Bangalore", and dropping
    // the meaningful case silently merges distinct roles. The trigram index on
    // normalized_title absorbs the fuzziness instead.
    expect(normalizeTitle("Software Engineer II - Bangalore")).toBe(
      "software engineer ii bangalore",
    );
    expect(normalizeTitle("Engineer - Backend")).toBe("engineer backend");
  });
});
